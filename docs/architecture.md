# 架构总览

## 1. 定位

DSH-OpenMAIC 是基于 **DeepSeek Harness（dsh）** 对 [OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) 的重构：

- **后端**（`OpenTeach/`）不做成一个独立 Web 服务，而是做成**一个 dsh 插件包** `@openteach/bundle`；
  它把一个教学内核与 OpenMAIC 的核心服务端链路，按依赖顺序组装成 12 个模块插件；
- **前端**（`OpenTeach-frontend/`）直接移植 OpenMAIC 前端（Next.js），把接口从「OpenMAIC 自带路由」
  改为「转发到 OpenTeach 后端」；
- **模型能力**在 dsh 宿主内**完全沿用宿主配置**，不再自持一份 LLM 配置。

重构目标：让「多智能体互动课堂」这套能力以 dsh 插件的形式被安装、组合与复用，而不是又一个独立部署的站点。

## 2. 仓库分层

```
DSH-Openmaic/
├─ references/            第三方参考仓库（只读，不入库）
│  ├─ OpenMAIC/           上游移植来源；@openmaic/* 的 file: 依赖源
│  ├─ deepseek-harness/   dsh 宿主 checkout（构建期软链 @deepseek-ai/*）
│  ├─ dsh-openmaic/       上游另一个 dsh 插件仓库
│  ├─ DeepTutor/          KB 检索参考实现
│  ├─ Edu-RAG/            KB 检索参考实现
│  └─ EduClaw/            已弃用
├─ OpenTeach/              后端：@openteach/bundle（dsh 插件）
│  ├─ src/index.ts         组装入口（bundle 的 node 半部 = dsh 插件）
│  ├─ packages/            12 个模块插件 + shared
│  ├─ assets/              随包携带的提示词资产（构建期复制）
│  ├─ cordis.patch.yml     dsh bundle patch（声明安装行）
│  └─ lib/index.js         tsdown 打出的单文件产物（含 vendor 进来的 openmaic-core）
├─ OpenTeach-frontend/     前端：@openteach/frontend（Next.js 移植）
└─ docs/                   本技术文档
```

## 3. 组装模型：一个包，12 个模块插件

安装单位是**一个包**。`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，
后者只向 dsh profile 的 layer 栈插入**一行**：

```yaml
- insert:
    - id: openteach
      name: '@openteach/bundle'
      config:
        listen: true
        envPath: ./.env.local
        llmConfigPath: ./llm.config.json
```

真正的装载发生在 [`src/index.ts`](../OpenTeach/src/index.ts) 的 `apply()` 里，按依赖顺序
在进程内 `ctx.plugin(...)` 逐个装配：

| # | 插件 | 包名 | provide（服务名） | inject |
| --- | --- | --- | --- | --- |
| 1 | llm | `@openteach/plugin-llm` | `eduLlm` | — |
| 2 | db | `@openteach/plugin-db` | `db`、`repo` | — |
| 3 | kernel | `@openteach/plugin-kernel` | —（装配 DSH 编排内核） | `eduLlm` |
| 4 | storage | `@openteach/plugin-storage` | `kv.store`、`docs.store`、`openmaic.storage` | `db` |
| 5 | generation | `@openteach/plugin-generation` | `openmaic.generation` | `eduLlm` |
| 6 | layout | `@openteach/plugin-layout` | `openmaic.layout` | — |
| 7 | slide | `@openteach/plugin-slide` | `openmaic.slide` | `eduLlm`、`repo` |
| 8 | audio | `@openteach/plugin-audio` | `openmaic.tts`、`openmaic.asr` | — |
| 9 | classroom | `@openteach/plugin-classroom` | `openmaic.classroom` | `eduLlm`、`llm`、`agents` |
| 10 | openmaic-core | `@openteach/plugin-openmaic-core` | `openmaic.core` | — |
| 11 | kb | `@openteach/plugin-kb` | `openmaic.kb` | —（可选消费 `eduLlm`） |
| 12 | http | `@openteach/plugin-http` | `app` | `eduLlm`、`repo` |

顺序约束：

- `llm` / `db` 是基座；`storage` 依赖 `db`；
- `kernel` 依赖 `eduLlm`，须在 `llm` 之后，且在 `classroom` 之前（`classroom` 需要内核提供的
  `ctx.llm` 与 `ctx.agents`）；
- `http` 最后，它从容器里取上述**全部**服务来装配 Express。

bundle 本身不含业务逻辑、不 `provide` 业务服务，只协调**装载顺序**与**配置透传**；
每个模块经 `ctx.provide()` 注册的服务随各自 fiber 卸载自动回收。

> `@openteach/plugin-*` 与 `@openteach/shared` 在 `@openteach/bundle` 中列为
> **devDependencies**（`workspace:*`）：它们已被 tsdown 内联进单文件 `lib/index.js`，
> 运行时依赖只剩可被 registry 解析的 `sharp`。

## 4. HTTP 出口与请求路径

`http` 插件装配的 Express 应用（[`packages/http/src/app.ts`](../OpenTeach/packages/http/src/app.ts)）
的挂载顺序是有意为之的：

```
cors（仅 dev）
└─ openmaic.core handler        ← 必须在 express.json() 之前
└─ express.json({ limit: 2mb })
└─ /api/health, /api/plugins
└─ /api/llm/*, /api/classroom/*, /api/agents/*
└─ /api/* → 501 NOT_IMPLEMENTED    ← 未实现能力域统一 501
└─ static(webDist) + SPA fallback  ← 仅 production 且目录存在
```

> 注意：`/api/health` 同时出现在 openmaic-core 的路由表里，而它挂在最前面且精确命中，
> 因此实际由**核心路由**（OpenMAIC 的健康检查）应答 Express 那一条同名处理器。
> `/api/classroom` 亦存在两条并行入口（见 [classroom.md](./classroom.md) 第 7 节）；
> 分发器只精确匹配 `/api/classroom`，其子路径仍由 Express 路由处理。

**为什么 openmaic-core 必须挂在 `express.json()` 之前**：openmaic-core 是移植进来的
OpenMAIC 路由（原为 Next.js route handler），它按**原始请求流**读取请求体
（有的路由用 `request.json()`，有的用 `request.formData()`，`/api/persistence` 用 `request.body`）。
一旦上游解析过 JSON，流就被消费，这些路由会读到空体。分发器在未命中路由时会立即 `next()` 透传，
所以「先挂、不消费」是安全的。

完整请求链（开发态）：

```
浏览器 → Next.js dev (localhost:3000)
        → rewrites.beforeFiles: /api/:path* → http://127.0.0.1:8787/api/:path*
        → Express（openmaic-core 命中核心路由；其余落到 /api/llm、/api/classroom、/api/agents 或 501）
```

openmaic-core 用 `x-forwarded-host` / `x-forwarded-proto` 解析来源（前端反代时会补齐），
因此**后端生成的课堂链接指向前端域名**，而不是 `127.0.0.1:8787`。

## 5. 与 dsh 宿主的关系

| 维度 | 宿主内运行（被 dsh 装载） | 独立运行（无 dsh 内核） |
| --- | --- | --- |
| LLM | `eduLlm` 反向适配宿主 `ctx.llm`，provider / 端点 / 模型 / 凭据全由 dsh 掌管 | 按 `llm.config.json` → 内置 DeepSeek 默认装配 |
| 编排内核 | 复用宿主 `ctx.llm` / `ctx.agents` | 自装配最小插件图，并把 `eduLlm` 桥进 `ctx.llm` |
| HTTP 监听 | `config.listen: true` 时插件自行 `app.listen` | 同上（`OPENTEACH_PORT`，默认 8787） |
| 路径解析 | `envPath` / `llmConfigPath` / 提示词资产全部按**包根目录**解析 | 同左 |

路径按包根目录而非进程 cwd 解析是关键：dsh 以 `pnpm dsh web` 从 harness checkout 启动时，
进程 cwd 是那个 checkout，相对 cwd 的 `./.env.local` 会指向不存在的文件并被静默忽略，
凭据与 `DATABASE_URL` 就此丢失且没有任何日志。

详见 [llm.md](./llm.md) 与 [development.md](./development.md)。

## 6. 持久化双轨

重构后存在两套并行的存储，各管一段：

| 存储 | 位置 | 归属 | 用途 |
| --- | --- | --- | --- |
| SQLite | `db` 插件（`node:sqlite`，`OPENTEACH_DB_PATH`） | OpenTeach 教学闭环 | `courses` / `lessons` / `questions` / `attempts` / `reviews` / `rubrics` / `rubric_evaluations` / `llm_call_logs` / `eval_runs`，以及课堂侧 `agents` / `classroom_sessions` / `classroom_events` / `whiteboard_elements` / `tts_assets`（共 14 张业务表） |
| SQLite KV | `storage` 插件 | 通用文档存储 | `storage_kv`、`storage_docs`（2 张） |
| PostgreSQL | 《`DATABASE_URL`》→ openmaic-core 的 owner-scoped 文档存储 | OpenMAIC 核心链路 | `stage_meta`、`owner_merges`、`owner_material`、`legacy_import_bindings`、`document_stages` / `document_scenes` 等 |

即：**教学闭环与课堂会话**走自带 SQLite（零原生依赖，`node:sqlite`）；
**OpenMAIC 生成链路的 stage / scene 文档**走 Postgres（`DATABASE_URL` 未设置时，
`stages` / `persistence` 等路由不可用）。

## 7. 能力降级哲学

贯穿全部模块：**任一能力缺失都不阻断闭环**。

- LLM 无凭据 → `llm` 自动降级为内置 mock 适配器（标记 degraded），五步闭环仍可跑通；
- `@openmaic/dsl` 不可解析 → slide 插件退到内置生成器；
- DSH 编排内核不可用 → classroom 退到确定性教师发言；
- OpenMAIC 核心路由未实现的能力域 → 统一 501，前端据此隐藏入口。

调用方通过各服务的 `available` / `source` 字段感知当前是真实能力还是降级实现。
