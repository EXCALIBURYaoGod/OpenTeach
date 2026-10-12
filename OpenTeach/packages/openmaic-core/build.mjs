/**
 * openmaic-core 的打包脚本。
 *
 * 把 `src/index.ts` 及其依赖闭包（vendor 的 OpenMAIC `lib/` 与核心
 * `app/api` route handler，共 339 个文件）打成单文件 ESM `lib/index.js`。
 *
 * 为什么用 esbuild 而不是 tsc/tsdown：
 * - 这棵树来自 OpenMAIC 上游、按 Next.js + React 的工程配置编写，在本仓库里
 *   逐文件做类型检查没有意义且会引入大量与移植无关的错误；构建只需要**转译**。
 * - 需要两条 Next 专有的解析规则：`@/*` 路径别名、`next/server` 与 `next/headers`
 *   指向本地 shim。用 onResolve 插件显式实现，避免依赖 tsconfig。
 *
 * 外部化策略：`packages: 'external'` —— 所有 node_modules 依赖保持 external，由
 * 组装层的 tsdown 决定最终内联（`@openmaic/*`）还是外置（pg、sharp、react…）。
 */

import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, 'src')

/** 解析顺序与 esbuild 默认一致，另加 `.ts`/`.tsx`。 */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js', '.jsx', '.json']

/** 把无扩展名的模块路径解析成真实文件（支持 `dir` → `dir/index.ts`）。 */
function resolveToFile(base) {
  const candidates = [
    base,
    ...RESOLVE_EXTENSIONS.map((ext) => base + ext),
    ...RESOLVE_EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
  ]
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // 继续尝试下一个候选。
    }
  }
  return null
}

/** 处理 `@/` 别名与 `next/*` shim 重定向。 */
const nextShimPlugin = {
  name: 'openmaic-core-shims',
  setup(build) {
    build.onResolve({ filter: /^next\/server$/ }, () => ({ path: path.join(SRC, 'shim', 'server.ts') }))
    build.onResolve({ filter: /^next\/headers$/ }, () => ({ path: path.join(SRC, 'shim', 'headers.ts') }))
    build.onResolve({ filter: /^@\// }, (args) => {
      const resolved = resolveToFile(path.join(SRC, args.path.slice(2)))
      if (resolved === null) {
        return { errors: [{ text: `openmaic-core: cannot resolve alias import "${args.path}"` }] }
      }
      return { path: resolved }
    })
  },
}

/**
 * 外部化策略：**默认全部内联**，只保留两类外置。
 *
 * 1. `@deepseek-ai/*`：dsh 宿主包，必须由 harness 装载时的模块表解析（同一实例）。
 * 2. `sharp` 等原生/可选依赖：带平台二进制或纯可选，无法内联。
 *
 * 之所以不再把普通 npm 依赖外置：最终产物是给 Node 原生 ESM 直接 import 的
 * `lib/index.js`，而 vendor 代码里有大量 CJS 风格的子路径引入（如
 * `lodash/isEqual`）。打包器（webpack/Next.js）能解析它们，Node 原生 ESM 不能
 * （`ERR_MODULE_NOT_FOUND`）。内联即可在构建期用打包器语义消解掉这些差异。
 *
 * `node:*` 与 Node 内置模块由 esbuild 在 `platform: 'node'` 下自动外置；
 * `@/` 与 `next/*` 已由上一个插件截获（onResolve 首个返回结果者胜）。
 */
const EXTERNAL_SPECIFIERS = new Set(['sharp', 'pg-native', 'canvas', 'encoding', 'aws-crt'])
const EXTERNAL_PREFIXES = ['@deepseek-ai/']

const externalizePlugin = {
  name: 'openmaic-core-external',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      // 入口自身、以及 Windows 盘符绝对路径（`E:\...`）不能外置。
      if (args.kind === 'entry-point' || /^[a-zA-Z]:[\\/]/.test(args.path)) return null
      if (EXTERNAL_SPECIFIERS.has(args.path)) return { path: args.path, external: true }
      if (EXTERNAL_PREFIXES.some((prefix) => args.path.startsWith(prefix))) {
        return { path: args.path, external: true }
      }
      return null
    })
  },
}

await build({
  entryPoints: [path.join(SRC, 'index.ts')],
  outfile: path.join(HERE, 'lib', 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  jsx: 'automatic',
  legalComments: 'none',
  sourcemap: false,
  resolveExtensions: RESOLVE_EXTENSIONS,
  plugins: [nextShimPlugin, externalizePlugin],
  // 内联的 CJS 依赖（postcss、sanitize-html…）会走 esbuild 的 `__require` 垫片，
  // 其中「动态 require 内置模块」（`require('path')`）在 ESM 产物里默认抛错。
  // 顶部注入 createRequire 提供一个真实的 require，垫片即可直接使用。
  banner: {
    js: "import { createRequire as __openmaicCreateRequire } from 'node:module';\nconst require = __openmaicCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
})

/**
 * 复制 `@openmaic/generation` 的提示词资产到 bundle 包的 `assets/`。
 *
 * 该包在自身 `dist/` 下运行时靠 `import.meta.url` 上溯定位这些 Markdown；内联进
 * 单文件后上溯失效。产物把资产随包携带，由组装层 `src/index.ts` 的
 * `configurePromptAssets()` 在启动时经 `OPENMAIC_PROMPTS_DIR` /
 * `OPENMAIC_PBL_PROMPTS_DIR` 指过来。
 */
const generationRoot = path.dirname(
  path.dirname(fileURLToPath(import.meta.resolve('@openmaic/generation'))),
)
const ASSETS = path.join(HERE, '..', '..', 'assets')

function copyDir(source, target) {
  rmSync(target, { recursive: true, force: true })
  mkdirSync(path.dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true })
  console.log(`[openmaic-core] copied prompt assets -> ${target}`)
}

// 主提示词加载器的 base dir 需同时含 `templates/` 与 `snippets/`；PBL v2 的
// 加载器直接读该目录下的 `*.md`，因此 `prompts-pbl/` 的内部文件要落在顶层。
copyDir(path.join(generationRoot, 'templates'), path.join(ASSETS, 'prompts', 'templates'))
copyDir(path.join(generationRoot, 'snippets'), path.join(ASSETS, 'prompts', 'snippets'))
copyDir(path.join(generationRoot, 'prompts-pbl'), path.join(ASSETS, 'prompts-pbl'))

/**
 * 复制 app 级提示词（OpenMAIC 仓库根的 `lib/prompts`）到 `assets/lib-prompts/`。
 *
 * 这套模板由 openmaic-core 自己的加载器读取（`src/lib/prompts/loader.ts`），它
 * 原先按 `process.cwd()/lib/prompts` 定位——在 Next.js 里成立，但内联进 dsh 插件
 * 后 cwd 是 harness 的启动目录，目录不存在，`interactive-outlines` 等模板全部
 * 加载失败，生成接口只能以 `Prompt template not found` 收场。产物随包携带，
 * 由组装层经 `OPENMAIC_LIB_PROMPTS_DIR` 指过来。
 */
// 该目录不在 `@openmaic/generation` 的解析链上（pnpm 把 file: 依赖复制进
// `.pnpm/` 后，包的上游仓库根已不可达），故按 package.json 里
// `file:../../../references/OpenMAIC` 同款的相邻 checkout 布局定位，与
// `generationRoot` 的用途保持一致。
const libPrompts = path.resolve(
  HERE, '..', '..', '..', 'references', 'OpenMAIC', 'lib', 'prompts',
)
if (!existsSync(libPrompts)) {
  throw new Error(`openmaic-core: app-level prompts not found at ${libPrompts}`)
}
copyDir(path.join(libPrompts, 'templates'), path.join(ASSETS, 'lib-prompts', 'templates'))
copyDir(path.join(libPrompts, 'snippets'), path.join(ASSETS, 'lib-prompts', 'snippets'))