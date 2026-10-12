# OpenTeach

**基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）对 [OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) 的重构。**

把「一键生成沉浸式多智能体互动课堂」这套能力，从独立部署的 Web 站点，重构为**可被 dsh
装载与组合的插件**：后端是一个 dsh 插件包，前端复用 OpenMAIC 的界面，模型能力完全沿用
宿主配置。

> OpenMAIC 上游是只读参考。本仓库不再维护它，也不与其同步发布节奏。

## 它由什么组成

```
┌─────────────────────────────────────────────────────────────────────┐
│  dsh（DeepSeek Harness）宿主                                         │
│  · ctx.llm / ctx.agents：模型路由、凭据、编排内核                     │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  @openteach/bundle  （一个 dsh 插件，含 11 个模块插件）         │  │
│  │                                                               │  │
│  │  llm → db → kernel → storage → generation → layout → slide     │  │
│  │       → audio → classroom → openmaic-core → http               │  │
│  │                                                               │  │
│  │  Express 出口 :8787                                            │  │
│  │    · openmaic-core：移植自 OpenMAIC 的 35 条核心 API            │  │
│  │    · /api/llm /api/classroom /api/agents：教学闭环与课堂编排    │  │
│  │    · 未实现能力域统一 501                                       │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
              ▲ /api/*  （Next.js rewrite 同源转发）
┌─────────────┴───────────────────────────────────────────────────────┐
│  @openteach/frontend  （Next.js 前端，移植自 OpenMAIC 前端）          │
└─────────────────────────────────────────────────────────────────────┘
```

一句话：**后端 = 一个 dsh 插件；前端 = OpenMAIC 前端的改接版。**

## 快速开始

```sh
# 1. 构建后端插件（软链宿主包 → 构建 openmaic-core → 打包 lib/index.js）
cd OpenTeach && bash scripts/build.sh
#    harness checkout 不在仓库内时显式指定（本机：/mnt/e/AgentDev/LuPin/deepseek-harness-master）
#    DSH_CHECKOUT=<harness 路径> bash scripts/build.sh

# 2. 注册为 dsh 插件（用户层，推荐本地迭代）
#    把 OpenTeach/cordis.patch.yml 的 insert 行写入 $DSH_HOME/profiles/<name>/cordis.patch.yml

# 3. 启动宿主（后端随之监听 :8787）
pnpm dsh web

# 4. 启动前端
cd ../OpenTeach-frontend && pnpm install
$env:OPENTEACH_API_BASE="http://127.0.0.1:8787"   # PowerShell
pnpm dev            # http://localhost:3000
```

自检：`curl http://127.0.0.1:8787/api/health` 应返回当前 provider 与模型。

完整步骤、数据库与环境变量见 [docs/development.md](docs/development.md)。

## 仓库结构

| 目录 | 内容 |
| --- | --- |
| `OpenTeach/` | **后端**：`@openteach/bundle` —— dsh 插件包，组装 11 个 `@openteach/plugin-*` 模块插件；含随包发布的提示词资产 `assets/` 与单文件产物 `lib/index.js` |
| `OpenTeach-frontend/` | **前端**：`@openteach/frontend` —— Next.js 移植自 OpenMAIC 前端，接口改接 OpenTeach 后端 |
| `docs/` | 技术文档（见下） |
| `references/` | 第三方参考仓库（只读，**不入库**）：`OpenMAIC/`（上游移植来源与 `@openmaic/*` 契约对照）、`deepseek-harness/`（dsh 宿主 checkout，构建期软链 `@deepseek-ai/*`）、`dsh-openmaic/`、`DeepTutor/`、`Edu-RAG/`、`EduClaw/` |

## 技术文档

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 总体架构：组装模型、插件装配顺序与服务拓扑、双持久化 |
| [docs/llm.md](docs/llm.md) | LLM 接入：宿主优先（方案 B）、`eduLlm` 反向适配、mock 降级 |
| [docs/generation.md](docs/generation.md) | 生成链路：openmaic-core 路由移植、三套提示词资产与注入机制 |
| [docs/classroom.md](docs/classroom.md) | 多智能体课堂：Director / 子智能体、6 个内置角色与权限、事件契约 |
| [docs/frontend.md](docs/frontend.md) | 前端移植与集成：rewrite 代理、501 与入口裁剪、交互 widget 约定 |
| [docs/development.md](docs/development.md) | 开发与部署：构建、注册、启动、配置与环境变量、常见问题 |

## 相对 OpenMAIC 的关键改动

- **形态**：独立站点 → dsh 插件包（单包安装，11 个模块插件进程内组装）。
- **模型**：自持 LLM 配置 → **完全沿用 dsh 宿主**的 `ctx.llm`（provider / 端点 /
  模型 / 凭据都由 dsh 掌管），不自持也不复制凭据。
- **编排**：自建编排 → 复用 dsh 的 `ctx.agents` / `ctx.llm` 编排内核。
- **前端**：后端服务端渲染 → Next.js 前端独立运行，`/api/*` 同源转发到后端。
- **降级**：任一能力缺失（无凭据、无 dsl、无内核、未实现路由）都不阻断闭环。

## 许可

各子目录保留其原有许可证，详见各目录下的 `LICENSE`。
