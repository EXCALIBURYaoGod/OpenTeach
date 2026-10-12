/**
 * OpenTeach bundle 组装入口 —— 同时是 dsh 插件的 **node 半部**。
 *
 * 本包是**组装层**，不含业务逻辑、不 `provide` 业务服务：
 * - 声明式的组装清单见 `cordis.patch.yml`（`dsh.bundle.patch`，单行指向本包）；
 * - 程序化装载见本文件 `apply()`，与清单保持同一顺序
 *   llm → db → kernel → storage → generation → layout → slide → audio →
 *   classroom → openmaic-core → kb → http。
 *
 * 各模块自身经 `ctx.provide()` 注册服务，随各自 fiber 卸载回收；bundle 只协调
 * 装载顺序与配置透传，某模块缺失时由使用方按其契约降级。
 *
 * 作为 dsh 插件：命名导出 `name` / `Config` / `apply`，无 default export，因此
 * `import * as bundle` 得到的模块命名空间本身就是一个合法 Cordis 插件。所有路径
 * 类配置（llm / db / env / webDist）都可由环境变量兜底，使本包在没有 edu-loop
 * 宿主注入时也能独立安装运行（`config.listen` 为真时自行监听 HTTP 端口）。
 *
 * LLM 配置来源：在 dsh 宿主内运行时**完全沿用 dsh 的 LLM 配置**——`@openteach/plugin-llm`
 * 反向适配宿主的 `ctx.llm`（provider 路由、端点、模型目录与凭据全部由 dsh 掌管，见其
 * `dsh-host.ts`），本包不再桥接或复制凭据。仅当本包独立安装运行（无 dsh 内核）时，才
 * 按 `llmConfigPath` / 内置默认装配本地 provider。
 *
 * @module bundle
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { loadDotEnv, resolveAppMode, type AppMode } from '@openteach/shared'
import * as llmPlugin from '@openteach/plugin-llm'
import * as dbPlugin from '@openteach/plugin-db'
import * as kernelPlugin from '@openteach/plugin-kernel'
import * as storagePlugin from '@openteach/plugin-storage'
import * as generationPlugin from '@openteach/plugin-generation'
import * as layoutPlugin from '@openteach/plugin-layout'
import * as slidePlugin from '@openteach/plugin-slide'
import * as audioPlugin from '@openteach/plugin-audio'
import * as classroomPlugin from '@openteach/plugin-classroom'
import * as openmaicCorePlugin from '@openteach/plugin-openmaic-core'
import * as kbPlugin from '@openteach/plugin-kb'
import * as httpPlugin from '@openteach/plugin-http'
import type { Config as LlmConfig } from '@openteach/plugin-llm'
import type { GenerationConfig } from '@openteach/plugin-generation'
import type { ClassroomConfig } from '@openteach/plugin-classroom'

export const name = 'openteach'

/**
 * bundle 组装配置：由宿主（如 edu-loop server 入口）或 dsh bundle patch 注入。
 * 除 `llm` 外全部可省略，缺省时按环境变量与内置默认解析。
 */
export interface Config {
  /** 已解析的 `llm.config.json` 内容（provider 路由与默认模型）。省略时读 `llmConfigPath` / `OPENTEACH_LLM_CONFIG` / 内置默认。 */
  llm?: LlmConfig
  /** `llm.config.json` 路径；提供时从中读取 provider 配置。相对路径按本包根目录解析。 */
  llmConfigPath?: string
  /** SQLite 库文件路径（db 模块）。省略时读 `OPENTEACH_DB_PATH`，再退到 `<cwd>/data/openteach.db`。 */
  dbFilePath?: string
  /** `.env` 文件路径；提供时在装配前载入（凭据经环境变量注入 provider）。省略时读 `OPENTEACH_ENV_PATH`。相对路径按本包根目录解析。 */
  envPath?: string
  /** 运行模式；省略时按 `NODE_ENV` 解析。 */
  mode?: AppMode
  /** 生产模式下托管的前端构建产物目录（仅 production 生效）。省略时读 `OPENTEACH_WEB_DIST`。 */
  webDist?: string
  /** generation 模块配置。 */
  generation?: GenerationConfig
  /** classroom 模块配置。 */
  classroom?: ClassroomConfig
  /** 装载后自行监听 HTTP 端口（独立安装到 dsh 时用；edu-loop 宿主自行 listen 时保持默认 false）。 */
  listen?: boolean
  /** 监听端口；省略时读 `OPENTEACH_PORT`，再退到 8787。 */
  port?: number
}

/** 配置结构校验（宿主包保持 external，由 dsh Loader 校验本 schema）。 */
export const Config = z.object({
  llm: z.any(),
  llmConfigPath: z.string().default(''),
  dbFilePath: z.string().default(''),
  envPath: z.string().default(''),
  mode: z.string().default(''),
  webDist: z.string().default(''),
  generation: z.any(),
  classroom: z.any(),
  listen: z.boolean().default(false),
  port: z.number().default(8787),
})

/**
 * 内置默认 LLM 路由：指向 DeepSeek。未解析到凭据时 llm 模块会自动降级为本地
 * mock 适配器（标记 degraded），保证没有任何 API Key 也能跑通五步闭环。
 */
const DEFAULT_LLM_CONFIG: LlmConfig = {
  defaultProvider: 'deepseek',
  providers: {
    deepseek: {
      displayName: 'DeepSeek',
      api: 'openai-completions',
      baseURL: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    },
  },
}

/**
 * 解析 provider 配置。优先级：显式传入 > 配置文件路径 > 内置默认。
 *
 * 注意：在 dsh 宿主内运行时本函数的结果**不生效**——`@openteach/plugin-llm` 会反向
 * 适配宿主的 `ctx.llm`（方案 B），provider 路由与凭据全部由 dsh 掌管。此处的本地
 * 配置只服务于「本包独立安装运行」这一场景。
 */
function resolveLlmConfig(config: Config): LlmConfig {
  if (config.llm !== undefined && config.llm !== null) return config.llm
  const raw = nonEmpty(config.llmConfigPath) ?? nonEmpty(process.env.OPENTEACH_LLM_CONFIG)
  if (raw !== undefined) {
    const path = resolveLocalPath(raw)
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as LlmConfig
  }
  return DEFAULT_LLM_CONFIG
}

/** 非空字符串判定，用于把「未设置」与「空字符串」统一成 undefined。 */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined
}

/**
 * 本包根目录（`lib/index.js` 的上一级）。
 *
 * 随包携带的资产与本地配置（`assets/`、`.env.local`、`llm.config.json`）按它定位，
 * 而不是按进程 cwd：dsh 以 `pnpm dsh web` 从 harness checkout 启动时 cwd 是那个
 * checkout，相对 cwd 的 `./.env.local` 会指向不存在的文件，并被 `loadDotEnv`
 * 静默忽略——凭据与 `DATABASE_URL` 就此丢失且没有任何日志。
 */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 相对路径按 {@link PKG_ROOT} 解析，绝对路径原样使用。 */
function resolveLocalPath(value: string): string {
  return isAbsolute(value) ? value : join(PKG_ROOT, value)
}

/** 显式 `mode` 的字面量校验；缺省或非法值按 `NODE_ENV` 解析。 */
function resolveMode(explicit: string | undefined): AppMode {
  const value = nonEmpty(explicit)
  if (value === 'development' || value === 'production') return value
  return resolveAppMode()
}

/**
 * 把随包携带的提示词资产目录告知两套提示词加载器。
 *
 * `@openmaic/generation` 的加载器默认按 `import.meta.url` 上溯两级定位
 * `templates/` / `snippets/`——只有它运行在自身 `dist/` 下时才成立；openmaic-core
 * 自己的 app 级加载器默认按 `process.cwd()/lib/prompts` 定位——只有 cwd 是前端
 * 工程根时才成立。两者在本 bundle 里都不成立：前者被内联进单文件 `lib/index.js`，
 * 上溯落到包外；后者的 cwd 是宿主（dsh）的启动目录，那里没有 `lib/prompts`，
 * `interactive-outlines` 等模板全部读不到，生成接口只能返回 500
 * `Prompt template not found`。这里在装配前显式指定资产目录（构建时由
 * `packages/openmaic-core/build.mjs` 复制到 `assets/`）；宿主已显式设置时不覆盖。
 */
function configurePromptAssets(): void {
  const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
  const prompts = join(assets, 'prompts')
  const promptsPbl = join(assets, 'prompts-pbl')
  const libPrompts = join(assets, 'lib-prompts')
  if (nonEmpty(process.env.OPENMAIC_PROMPTS_DIR) === undefined && existsSync(prompts)) {
    process.env.OPENMAIC_PROMPTS_DIR = prompts
  }
  if (nonEmpty(process.env.OPENMAIC_PBL_PROMPTS_DIR) === undefined && existsSync(promptsPbl)) {
    process.env.OPENMAIC_PBL_PROMPTS_DIR = promptsPbl
  }
  if (nonEmpty(process.env.OPENMAIC_LIB_PROMPTS_DIR) === undefined && existsSync(libPrompts)) {
    process.env.OPENMAIC_LIB_PROMPTS_DIR = libPrompts
  }
}

/**
 * 按依赖顺序装载各模块插件。
 *
 * 顺序约束：llm/db 为基座；kernel 依赖 eduLlm；storage/generation/slide 依赖
 * db/llm/layout；classroom 依赖 kernel 装配的 `ctx.agents`/`ctx.llm`；http 最后，
 * 依赖前述全部服务。
 *
 * @returns `config.listen` 为真时返回关闭 HTTP 服务的 disposer，否则 void。
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void | (() => void)> {
  configurePromptAssets()

  const envPath = nonEmpty(config.envPath) ?? nonEmpty(process.env.OPENTEACH_ENV_PATH)
  if (envPath !== undefined) loadDotEnv(resolveLocalPath(envPath))

  // 注意用 nonEmpty：schema 把 mode 的缺省值归一成空串，`??` 对空串不生效，
  // 否则空串会直接传给 http 插件，使开发分支（CORS）被跳过。
  const mode = resolveMode(config.mode)
  const dbFilePath = nonEmpty(config.dbFilePath)
    ?? nonEmpty(process.env.OPENTEACH_DB_PATH)
    ?? join(process.cwd(), 'data', 'openteach.db')
  const webDist = nonEmpty(config.webDist) ?? nonEmpty(process.env.OPENTEACH_WEB_DIST)

  await ctx.plugin(llmPlugin, resolveLlmConfig(config))
  await ctx.plugin(dbPlugin, { filePath: dbFilePath })
  // DSH 编排内核（宿主优先、缺失自装配）：依赖 eduLlm，须在 llm 之后装载。
  await ctx.plugin(kernelPlugin)
  await ctx.plugin(storagePlugin)
  await ctx.plugin(generationPlugin, config.generation ?? {})
  await ctx.plugin(layoutPlugin)
  await ctx.plugin(slidePlugin)
  await ctx.plugin(audioPlugin)
  // 多智能体互动课堂编排层：依赖 kernel 提供的 ctx.agents / ctx.llm。
  await ctx.plugin(classroomPlugin, config.classroom ?? {})
  // OpenMAIC 核心 API（生成 + 课堂主链路）：注册 openmaic.core 服务，由 http 插件挂载。
  await ctx.plugin(openmaicCorePlugin)
  // 本地知识库（索引 + 检索）：注册 openmaic.kb 服务，其上下文经
  // `GenerateClassroomInput.externalContext` 注入课堂生成；可选依赖 eduLlm，
  // 缺失时自动关闭多查询检索，不阻断装配。
  await ctx.plugin(kbPlugin)
  // HTTP/SSE 出口：仅生产模式托管前端构建产物。
  await ctx.plugin(httpPlugin, {
    mode,
    ...(mode === 'production' && webDist !== undefined ? { webDist } : {}),
  })

  // 独立安装到 dsh 时自行监听；edu-loop 宿主代为 listen 时该开关保持默认关闭，避免重复占用端口。
  if (config.listen === true) {
    const port = config.port ?? Number.parseInt(process.env.OPENTEACH_PORT ?? '8787', 10)
    return listen(ctx, port)
  }
  return undefined
}

/** 启动 http 插件提供的 Express 应用，并返回关闭它的 disposer。 */
function listen(ctx: Context, port: number): () => void {
  const app = ctx.get('app')
  if (app === undefined) throw new Error('openteach: http 插件未提供 app，无法监听')
  const server: Server = app.listen(port, () => {
    console.log(`[openteach] 已监听 http://localhost:${port}`)
  })
  return () => { server.close() }
}