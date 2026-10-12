# 技术文档索引

本目录是 OpenTeach 的技术说明。项目定位见根 [README](../README.md)：
**基于 DeepSeek Harness（dsh）对 OpenMAIC 的重构**。

## 文档

| 文档 | 内容 |
| --- | --- |
| [architecture.md](./architecture.md) | 总体架构：仓库分层、`@openteach/bundle` 组装模型、12 个模块插件与服务拓扑、双持久化 |
| [llm.md](./llm.md) | LLM 接入：宿主优先（方案 B）反向适配、`eduLlm` 服务、独立运行回落、mock 降级 |
| [generation.md](./generation.md) | 生成链路：openmaic-core 路由移植、提示词资产的三套目录与注入机制、资产随包构建 |
| [classroom.md](./classroom.md) | 多智能体互动课堂：Director / 子智能体、角色注册表与权限、事件契约与 SSE 续传 |
| [frontend.md](./frontend.md) | 前端移植与前后端集成：Next.js rewrite 代理、隐藏入口与 501、交互 widget 运行时约定 |
| [development.md](./development.md) | 开发与部署：构建、启动、数据库、配置与环境变量、常见问题 |
| [../OpenTeach/packages/kb/DESIGN.md](../OpenTeach/packages/kb/DESIGN.md) | 本地知识库设计：存储布局、BM25 检索、HTTP 契约与降级策略 |

## 阅读路径

- **想了解整体设计** → [architecture.md](./architecture.md)
- **要接入 / 排查模型** → [llm.md](./llm.md) → [development.md](./development.md)
- **要改生成与提示词** → [generation.md](./generation.md)
- **要改课堂智能体行为** → [classroom.md](./classroom.md)
- **要改前端页面** → [frontend.md](./frontend.md)
- **要跑起来** → [development.md](./development.md)

## 上游关系

| 目录 | 角色 |
| --- | --- |
| `references/OpenMAIC/` | 上游只读参考（[THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC)）。不改动，作为移植来源与契约对照，同时是 `@openmaic/{dsl,generation,storage}` 的 `file:` 依赖源 |
| `OpenTeach/` | 本项目后端：dsh 插件包，承载重构后的服务端 |
| `OpenTeach-frontend/` | 本项目前端：移植自 OpenMAIC 前端，改接 OpenTeach 后端 |
| `references/deepseek-harness/` | dsh 宿主 checkout，构建期用于软链 `@deepseek-ai/*` 宿主包（**本机实际使用的 checkout 在仓库外，见 [development.md](./development.md#1-前置条件)**） |
| `references/dsh-openmaic/` | 上游独立仓库（[THU-MAIC/dsh-openmaic](https://github.com/THU-MAIC/dsh-openmaic)），另一个把 OpenMAIC 带进 dsh 的插件，非本项目产物 |
