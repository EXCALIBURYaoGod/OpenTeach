# 生成链路与提示词资产

## 1. 两条生成路径

重构后有两套生成能力并存，服务不同场景、**不共用** provider 配置：

| 路径 | 归属 | 入口 | 说明 |
| --- | --- | --- | --- |
| **OpenMAIC 核心链路** | `openmaic-core` 插件 | `/api/generate-classroom`、`/api/generate/*`、`/api/stages/*`、`/api/persistence/*` | 移植自 OpenMAIC 上游的 route handler + 生成逻辑，是**主链路** |
| **教学闭环两阶段管线** | `generation` 插件 | 服务 `openmaic.generation` | 轻量版：需求 → 大纲 → 完整场景，供五步闭环使用 |

两者都是「能力型」设计：主链路不可用时教学闭环仍成立。

## 2. openmaic-core：把 OpenMAIC 服务端搬进 Express

[`packages/openmaic-core/`](../OpenTeach/packages/openmaic-core) 把 OpenMAIC 的
服务端 lib 与 `app/api/**` route handler vendor 进本仓库，以 **in-process HTTP 路由**
的形式挂到 OpenTeach 的 Express 出口上。

### 2.1 路由表

路径按 Next.js 约定编译为 regex（`[name]` → 单段动态参数，`[...name]` → 尾部 catch-all），
全部带 `/api` 前缀，与运行中的 OpenMAIC 完全同形。完整清单见
[`src/router.ts`](../OpenTeach/packages/openmaic-core/src/router.ts)，共 **35 条**，主要分组：

- **生成**：`generate-classroom`（+ `[jobId]` 轮询）、`generate/scene-outlines-stream`、
  `generate/scene-content`、`generate/scene-actions`、`generate/agent-profiles`
- **课堂容器**：`classroom`、`stages`（+ `[id]` 及 `freshness` / `manifest` /
  `publish` / `unpublish` / `scenes` / `status` / `generation-complete`）、`stage-meta/[stageId]`
- **持久化**：`persistence/[...path]`（owner-scoped 文档存储，从 `request.url` 剥
  `/api/persistence` 前缀）
- **材料与文档**：`materials`（+ `[id]`）、`extract-document`
- **provider 与验证**：`server-providers`、`provider/probe-models`、
  `verify-model` / `verify-image-provider` / `verify-video-provider` / `verify-pdf-provider`
- **其它**：`health`、`usage`、`web-search`、`access-code/*`、`identity/*`

### 2.2 分发器

[`src/dispatch.ts`](../OpenTeach/packages/openmaic-core/src/dispatch.ts) 把 Node
`IncomingMessage` 适配成 Next.js 的 `NextRequest`，并把返回的 `Response` 写回
`ServerResponse`。关键设计：

- **不消费未命中的请求**：只有路径命中路由表后才读取请求体，未命中立即 `next()`，
  把控制权交还 Express 其余中间件。这是它必须先于 `express.json()` 挂载的原因。
- **请求体缓冲**：命中后把 body 收成 `Buffer` 交给 `Request`，Fetch 会规范化成
  `ReadableStream`，因此 `request.body`（persistence 依赖）与 `request.json()` /
  `request.formData()`（其余路由依赖）**同时成立**，且无需 `duplex`。
- **响应流式回写**：`Readable.fromWeb(response.body).pipe(res)` 保留 SSE 语义。
- **Cookie 合并**：`cookies().set()` 写入的 `Set-Cookie` 由请求作用域收集后并到响应。
- **来源解析**：优先 `x-forwarded-host` / `x-forwarded-proto`（前端反代补齐），
  否则退回 `Host` —— 保证生成的课堂分享链接指向前端域名。
- **`after()` 支持**：`generate-classroom` 的后台生成任务在响应写出后由
  `setImmediate` 执行。

### 2.3 打包方式

`openmaic-core` 有**独立的 build**（[`build.mjs`](../OpenTeach/packages/openmaic-core/build.mjs)），
用 esbuild 把 `src/index.ts` 及依赖闭包（vendor 的 `lib/` + `app/api` route handler，
约 **339 个文件**）打成单文件 ESM。

- 用 esbuild 而非 tsc/tsdown：这棵树来自上游、按 Next.js + React 工程配置编写，
  逐文件类型检查没有意义且会引入大量与移植无关的错误，构建只需要**转译**。
- 需要两条 Next 专有解析规则，由 onResolve 插件实现：`@/*` 路径别名 →
  `src/`；`next/server` / `next/headers` → `src/shim/`。
- **默认全部内联**，只外置两类：`@deepseek-ai/*`（必须是 dsh 装载时的同一实例）
  与 `sharp` / `pg-native` / `canvas` / `encoding` / `aws-crt`（原生或纯可选依赖）。
  之所以不再外置普通 npm 依赖：产物是给 Node 原生 ESM 直接 `import` 的
  `lib/index.js`，而 vendor 代码里有大量 CJS 子路径引入（如 `lodash/isEqual`），
  打包器语义能消解、Node 原生 ESM 不能。
- 顶部注入 `createRequire` 提供真实 `require`，供内联的 CJS 依赖使用。

生成的 `lib/index.js` 再由组装层 tsdown 内联进 `@openteach/bundle` 的 `lib/index.js`。

## 3. 提示词资产：三套目录

这是移植中最容易出错的地方。提示词分散在**三套目录**，各自的加载器**原本都靠
`import.meta.url` 或 `process.cwd()` 定位**，而这两者在 dsh 插件形态下**都不成立**。

| 环境变量 | 资产 | 原定位方式 | 失效原因 |
| --- | --- | --- | --- |
| `OPENMAIC_PROMPTS_DIR` | `templates/` + `snippets/`（13 套 generation 模板） | `@openmaic/generation` 的 `import.meta.url` 上溯两级 | 内联进单文件后上溯落到包外 |
| `OPENMAIC_PBL_PROMPTS_DIR` | `prompts-pbl/*.md` | 同上 | 同上 |
| `OPENMAIC_LIB_PROMPTS_DIR` | app 级 `lib/prompts`（director、agent-system\*、interactive-outlines、task-engine-outlines、web-search-query-rewrite + 4 个 snippet） | `process.cwd()/lib/prompts` | dsh 从 harness checkout 启动，cwd 无此目录 |

**修复方案**（三层配合）：

1. **加载器支持覆盖**：app 级加载器优先读 `OPENMAIC_LIB_PROMPTS_DIR`
   （[`lib/prompts/loader.ts`](../OpenTeach/packages/openmaic-core/src/lib/prompts/loader.ts)）；
2. **构建期复制资产**：`build.mjs` 把
   - `@openmaic/generation` 的 `templates/` / `snippets/` / `prompts-pbl/`
     复制到 `assets/prompts*`；
   - OpenMAIC 仓库根的 `lib/prompts/{templates,snippets}`
     复制到 `assets/lib-prompts/`（源缺失即 throw，避免静默产出残缺包）；
3. **启动时注入**：组装层 `configurePromptAssets()` 在 `apply()` 首行按包根目录解析
   `assets/` 并写入上述三个环境变量（宿主已显式设置时不覆盖）。

> 为什么用 `path.resolve(HERE, '..','..','..','references','OpenMAIC','lib','prompts')`
> 而不是从 `@openmaic/generation` 的解析结果上溯：pnpm 把 `file:` 依赖复制进 `.pnpm/`
> 后，包的上游仓库根**已不可达**。故按相邻 checkout 布局定位，与 package.json 中
> `file:../../../references/OpenMAIC` 同款约定。

资产目录**随包发布**（`package.json` 的 `files` 含 `assets`），因此 git 安装的
dsh 插件无需任何构建步骤即可加载提示词。

## 4. 教学闭环两阶段管线（generation 插件）

[`packages/generation/src/plugin.ts`](../OpenTeach/packages/generation/src/plugin.ts)
提供 `openmaic.generation` 服务：

```ts
interface OpenmaicGenerationService {
  available: boolean
  source: 'llm' | 'mock'
  generateSceneOutlinesFromRequirements(input): Promise<GenerationResult<GeneratedOutline>>
  buildCompleteScene(outline, content): CompleteScene
}
```

- **第一阶段**：`(systemPrompt, userPrompt)` 经 `makeAiCall` 映射到
  `llm.runtime.stream` 的一次调用，`assembleStream` 装配成完整文本，再从返回文本里
  宽松提取第一个 JSON 对象（抓首尾大括号）。
- **第二阶段**：把 outline + 讲解内容装配成符合 storage `docs.store` 场景形状
  （`{ id, title, content }`）的文档。
- **降级**：当默认路由处于 mock 降级态（或 `forceMock`）时，走内置确定性生成器
  `builtinOutline`，产出结构化 3 页大纲，保证闭环可跑。
- 输出契约对齐 `@openmaic/generation` 的 `SceneOutline` / `CompleteScene` 最小子集，
  使上层教学闭环与持久层解耦 —— 无论真模型还是 mock，调用方无需感知差异。

## 5. slide 链路与 dsl 降级

`openmaic.slide` 服务（[`packages/slide/src/plugin.ts`](../OpenTeach/packages/slide/src/plugin.ts)）
把课程要点 / 讲解文本转成 slide JSON：

- specifier **动态拼装**（`['@openmaic', 'dsl'].join('/')`）以规避 tsc 静态解析与
  打包器解析，再 `await import()` 探测；
- 能解析且导出 `validateStage` → `source: 'openmaic'`，暴露 `dslVersion`，
  产物为符合 dsl `Stage` / `Scene` 契约的文档（每页一个 slide scene + PPTist canvas），
  校验委托给 `validateStage`；
- 无法解析 → `source: 'builtin-fallback'`，退到内置生成器，**不阻断闭环**。

## 6. 501 策略

未实现的 OpenMAIC 能力域不返回笼统 404，而是由 Express 的 `/api` 兜底统一返回：

```json
{ "success": false, "errorCode": "NOT_IMPLEMENTED", "error": "该接口尚未由 OpenTeach 后端实现" }
```

前端据此**隐藏对应入口**（如文件夹操作、部分图像/视频/TTS/ASR 服务），而不是让用户点进空页面。
