# 开发与部署

## 1. 前置条件

| 依赖 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20（`@openteach/bundle` 的 `engines`）；前端要求 ≥ 22.19 | 前端见 `OpenTeach-frontend/.nvmrc` |
| pnpm | monorepo 工作区 | 前后端各自有 `pnpm-workspace.yaml` |
| dsh | `dsh` 在 `PATH` 上，或有 harness checkout | 镜像 `pnpm dsh web` |
| harness checkout | 含 `packages/` 与 `vendor/` 目录 | 仓库内只读留存一份在 `references/deepseek-harness/`；构建请用 `DSH_CHECKOUT` 指向**本机实际使用**的那份（本机为 `E:\AgentDev\LuPin\deepseek-harness-master`） |
| PostgreSQL | 可选（16） | 仅 OpenMAIC 核心链路的 stages / persistence 需要 |

## 2. 构建后端

```sh
cd OpenTeach
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh   # 不设则尝试从 PATH 上的 dsh 反推
```

[`scripts/build.sh`](../OpenTeach/scripts/build.sh) 做三件事：

1. **软链宿主包**：扫描 harness checkout 的 `packages/` 与 `vendor/`，把每个
   `@deepseek-ai/*` 包的 `package.json` 所在目录 `ln -sfn` 到本包 `node_modules/`
   （不硬编码目录，按包名建链）。这样 tsdown 的类型检查与打包对齐「运行中的 dsh
   所带的那套包」，且 `DSH_CHECKOUT` 可切换 checkout。
2. **构建 openmaic-core**：`node packages/openmaic-core/build.mjs`
   —— esbuild 打单文件，并**复制提示词资产**到 `assets/`（见
   [generation.md](./generation.md) 第 3 节）。
3. **打包组装层**：`tsdown` 把 `src/index.ts` 与 12 个模块插件打成
   `lib/index.js`（单文件 ESM）。

[`tsdown.config.ts`](../OpenTeach/tsdown.config.ts) 的外部化策略：

- `@deepseek-ai/*`（cordis / schemastery / dsh-\*）保持 **external**，由 harness
  装载时的模块表解析（必须是同一实例）；
- `@openteach/*` 与 `@openmaic/*` **内联**，使安装单位只有一个包；
- `dts: false`：12 个模块插件的**裸 `.ts` 源码**被内联，rolldown-plugin-dts 为其生成
  声明会命中 TS2742（推断类型引用 schemastery → cosmokit 的非公开路径）。声明改由
  手写的窄接口 `types/index.d.ts` 提供；运行时消费方（dsh Loader）只读 `lib/index.js`。

类型检查：`pnpm typecheck`。

## 3. 注册为 dsh 插件

两种方式，二选一：

**A. bundle 层**（随包声明，已在 `package.json` 里）

```jsonc
"dsh": { "manifestVersion": 1, "bundle": { "patch": "./cordis.patch.yml" } }
```

**B. 用户层**（推荐用于本地迭代）——把
[`OpenTeach/cordis.patch.yml`](../OpenTeach/cordis.patch.yml) 里的 `insert` 行原样写入：

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- insert:
    - id: openteach
      name: '@openteach/bundle'
      config:
        listen: true
        envPath: ./.env.local
        llmConfigPath: ./llm.config.json
```

写成用户层可避免把本包塞进 profile 的 `dsh.profile.bundles` 列表。

也可以在终端安装：

```sh
dsh plugin --profile web add <path-or-git-url>
```

> **git 安装的两个硬约束**（否则会失败）：
> 1. 生产依赖**不得**使用 `workspace:*` 协议 —— pnpm 在 monorepo 外无法解析。
>    本项目因此把 `@openteach/plugin-*` 与 `@openteach/shared` 收进
>    **devDependencies**（它们已被内联进 `lib/index.js`），运行时依赖只剩可被 registry
>    解析的 `sharp`；
> 2. **包根必须位于仓库根**——git 安装不支持子目录包。

## 4. 启动

```sh
pnpm dsh web        # 宿主：默认 http://127.0.0.1:3080
```

插件装载时（`config.listen: true`）后端自行监听 HTTP，端口由 `OPENTEACH_PORT`
覆盖，默认 **8787**：

```
[openteach] 已监听 http://localhost:8787
```

前端另开一个终端：

```sh
cd OpenTeach-frontend
pnpm install                # postinstall 依次构建 packages/ 下的 SDK
pnpm db:up                  # 可选：docker compose 启动 Postgres 16
$env:OPENTEACH_API_BASE="http://127.0.0.1:8787"   # PowerShell
pnpm dev                    # http://localhost:3000
```

`OPENTEACH_API_BASE` 必须设置，否则前端不会把 `/api/*` 转发到后端
（详见 [frontend.md](./frontend.md) 第 2 节）。

自检：

```sh
curl http://127.0.0.1:8787/api/llm/providers   # defaultProvider / defaultModel / providers（含 degraded 标志）
curl http://127.0.0.1:8787/api/plugins    # 已装载插件与服务拓扑
```

> `/api/health` 返回的是 openmaic-core 移植路由的响应（`status` / `capabilities`），
> 其中 `capabilities` 只反映 webSearch / imageGeneration / videoGeneration / tts
> 这四个可选能力域，全为 `false` 属预期，与聊天 LLM 无关 —— 判断模型可用性请用
> 上面的 `/api/llm/providers`。

## 5. 数据库

| 用途 | 存储 | 启动 |
| --- | --- | --- |
| 教学闭环、课堂会话、角色、TTS 资产 | SQLite（`node:sqlite`，零原生依赖） | 自动创建。路径：`config.dbFilePath` → `OPENTEACH_DB_PATH` → `<进程 cwd>/data/openteach.db` |
| 通用文档 KV | SQLite（`storage_kv` / `storage_docs`） | 随 `db` 插件 |
| OpenMAIC stage / scene 文档 | PostgreSQL | `cd OpenTeach-frontend && pnpm db:up`（`docker compose -p openmaic-dev-db -f docker-compose.db.yml up -d --wait postgres`），并把连接串写入 `.env.local` 的 `DATABASE_URL` |

**`DATABASE_URL` 必须设置**：前端自身（服务端持久化）在缺少它时拒绝启动，
openmaic-core 的 `stages` / `persistence` 等路由也不可用。可直接用
`pnpm db:up` 起一个本地 Postgres，再把连接串写入 `.env.local`。

## 6. 配置与环境变量

配置文件（均按 **OpenTeach 包根目录**解析，与进程 cwd 无关）：

| 文件 | 作用 |
| --- | --- |
| `OpenTeach/cordis.patch.yml` | bundle patch，声明安装行与 `listen` / `envPath` / `llmConfigPath` |
| `OpenTeach/llm.config.json` | **独立运行时**的 provider 路由（宿主内不生效） |
| `OpenTeach/.env.local` | 凭据与 `DATABASE_URL`（**不入库**，模板见 `.env.example`） |

环境变量（`config` 显式值优先，其次环境变量，再次内置默认）：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `OPENTEACH_ENV_PATH` | — | `.env.local` 的绝对路径（未显式配置 `envPath` 时生效） |
| `OPENTEACH_LLM_CONFIG` | — | `llm.config.json` 的绝对路径（未显式配置 `llmConfigPath` 时生效） |
| `OPENTEACH_DB_PATH` | `<cwd>/data/openteach.db` | SQLite 库文件路径 |
| `OPENTEACH_WEB_DIST` | — | 生产模式下托管的前端构建产物目录 |
| `OPENTEACH_PORT` | `8787` | 后端监听端口 |
| `OPENTEACH_API_BASE` | — | **前端**用：后端基址，设置后启用 `/api/*` 转发 |
| `DATABASE_URL` | — | **必填**（Postgres），openmaic-core 持久化依赖 |
| `OPENMAIC_PROMPTS_DIR`<br>`OPENMAIC_PBL_PROMPTS_DIR`<br>`OPENMAIC_LIB_PROMPTS_DIR` | 自动注入 | 三套提示词资产目录；由 `configurePromptAssets()` 按包根解析 `assets/` 注入，宿主已设置时不覆盖 |
| `DEEPSEEK_API_KEY`<br>`DOUBAO_LLM_API_KEY` | — | 独立运行时的 LLM 凭据 |
| `DOUBAO_API_KEY` / `DOUBAO_BASE_URL` / `DOUBAO_MODELS` | — | openmaic-core 的 provider 约定（`{PREFIX}_API_KEY` / `{PREFIX}_BASE_URL` / `{PREFIX}_MODELS`），与上面的 `DOUBAO_LLM_*` 是**两套**，共用同一把 Key 时需重复填 |

> `.env.example` 只放凭据占位，**不含任何敏感信息**，随仓库发布；
> 真实值一律放 `.env.local`（已 gitignore）。

## 7. 常见问题

**Q：点「进入课堂」生成失败，报 `Prompt template not found`**
提示词加载器在找 `process.cwd()/lib/prompts/templates/interactive-outlines/system.md`，
即 `OPENMAIC_LIB_PROMPTS_DIR` 没生效。检查：

1. `OpenTeach/assets/lib-prompts/` 是否存在（构建期由 `build.mjs` 复制，源缺失会
   throw 而不是静默跳过）；
2. 是否重新构建并重启了 dsh；
3. 环境中是否有人显式设置了 `OPENMAIC_LIB_PROMPTS_DIR` 指向错误位置
   （已设置时 `configurePromptAssets()` 不覆盖）。

**Q：日志说 LLM 降级 / 用 mock，但 dsh 里明明配了模型**
宿主内运行时 `eduLlm` 是宿主 `ctx.llm` 的代理，`degradedProviders` 应为空集。
若仍降级，说明 `probeDshLlm` 没等到宿主 `llm`（上限 8s）：
确认 dsh 侧确实注册了 provider 路由（`/api/llm/providers` 的 `providers` 字段）。

**Q：`.env.local` 里的 Key 像是没被读到**
`.env.local` 按**包根目录**解析，不是进程 cwd。dsh 从 harness checkout 启动时
cwd 是那个 checkout —— 这正是改成包根解析的原因。可用 `OPENTEACH_ENV_PATH`
指向绝对路径验证。

**Q：`dsh plugin add` 报 workspace 协议错误**
把 `workspace:*` 依赖移出 `dependencies`（本项目已移入 devDependencies）。

**Q：生成的互动场景显示「这个互动未能运行」**
widget HTML 里有未捕获异常，整个 `<script>` 中断。用浏览器控制台看首个错误
（行号是 `srcDoc` 行号，需减去注入 shim 的偏移）。常见原因：调用了字符串上不存在
的方法（如 `.code.bold()`）。详见 [frontend.md](./frontend.md) 第 4.1 节。

**Q：`references/dsh-openmaic/` 目录是什么？**
上游 [THU-MAIC/dsh-openmaic](https://github.com/THU-MAIC/dsh-openmaic) 的独立仓库
（自带 `.git`），是另一个把 OpenMAIC 带进 dsh 的插件，**不是本项目的产物**，也不在
本仓库的版本控制内。

## 8. 提交前检查

```sh
cd OpenTeach && pnpm typecheck      # 组装层类型检查
cd OpenTeach && bash scripts/build.sh   # 产物与 assets 需同步提交
```

`OpenTeach/lib/index.js` 与 `OpenTeach/assets/**` **随仓库提交** —— git 安装的
dsh 插件不做构建步骤。改动插件源码或提示词资产后，务必重新构建再提交。
