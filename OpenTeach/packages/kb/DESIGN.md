# `@openteach/plugin-kb` 设计说明

本地知识库（KB）检索插件。把「已索引的本地资料」按需检索出来，格式化成一段上下文，
注入课堂生成流程 —— 让生成的课程建立在指定语料之上，而不是只靠模型先验。

- 服务名：`openmaic.kb`
- HTTP 前缀：`/api/kb`
- 依赖：`@deepseek-ai/cordis`（内核）、`@openteach/plugin-llm`（**可选**）、`express`
- 参考实现：[`references/DeepTutor`](../../../references/DeepTutor)（仅参考契约，不复制代码）

---

## 1. 为什么是独立插件，而不是写进 `openmaic-core`

`openmaic-core` 是「课程生成」的领域内核，它不应该知道「知识库」这个概念 —— 一旦写进去，
未来每接一种新的检索源（向量库、图库、企业搜索）都要改内核并重新打包。

因此采用**接缝（seam）方案**：

| 位置 | 改动 | 说明 |
| --- | --- | --- |
| `openmaic-core` `GenerateClassroomInput` | 新增 `externalContext?: string` | 只是一个字符串字段，不含任何检索实现 |
| `openmaic-core` `classroom-generation.ts` | 把该字段与 web search 结果合并进 `researchContext` | 约 6 行；缺省时行为与改造前**完全一致** |
| `openmaic-core` `routes/generate-classroom/route.ts` | 白名单透传 `externalContext` | 约 3 行 |

检索引擎、分块、索引存储、多查询检索、配置、路由**全部在本包内**。
不装本插件 → `/api/kb` 不存在、`externalContext` 无人产出 → 内核行为不变。

内核侧唯一的语义约定：`externalContext` **只做拼接透传**，内核不解析、不校验它的格式。

---

## 2. 装配

组装层 [`OpenTeach/src/index.ts`](../../src/index.ts) 的插件顺序：

```
llm → db → storage → generation → layout → slide → audio → openmaic-core → kb → http
```

- `kb` 排在 `openmaic-core` 之后（同层，互不依赖），排在 `http` **之前** —— `http` 装配时
  会 `ctx.get('openmaic.kb')` 取走子路由。
- 对 `eduLlm` 用 **`ctx.get()` 可选读取**，不写 `inject: ['eduLlm']`：这样 kb 插件可以脱离
  llm 插件独立装卸（Cordis 的 `Context.get(name)` 明确为「无需 inject 的读取」，缺失返回
  `undefined`）。缺 LLM 时多查询检索自动退化为单查询。
- 路由挂载位由 [`packages/http/src/app.ts`](../http/src/app.ts) 提供（`AppOptions.kb`）：
  挂在 `express.json()` **之后**（直接读 `req.body`，不需要原始流缓冲）、`/api` 501 兜底
  **之前**。Express 的 `app.use` 是追加语义，晚挂的中间件不会被命中，顺序不能调换。

---

## 3. 内部结构

```
packages/kb/src/
├── plugin.ts          # Cordis 插件入口：装配、可选 LLM、降级、ctx.provide('openmaic.kb')
├── types.ts           # 契约类型（KbDocument / KbChunk / KbSearchResult / KbService …）
├── config.ts          # 环境变量解析（无凭据、无明文）
├── chunking.ts        # 句子边界切分 + 重叠
├── engine.ts          # 分词 + BM25 打分
├── store.ts           # 文件系统存储（原子写入、库名校验）
├── smart-retriever.ts # 多查询生成 + 并发检索 + LLM 聚合
├── format.ts          # 检索结果 → 可注入的上下文字符串
└── routes.ts          # Express 子路由（信封对齐 openmaic-core）
```

### 3.1 检索：BM25 + CJK 单字/二元组

零依赖、零凭据，不引入 embedding 模型或外部向量库：

- `tokenize()`：ASCII 词（≥2 字符、小写）+ **CJK 单字与二元组**（`isCjk` 覆盖
  0x3400–0x4dbf / 0x4e00–0x9fff / 0xf900–0xfaff）。二元组让中文查询无需分词器即可
  召回，单字同时入索引是为了让单字查询（「表」）也能命中 —— 代价是 BM25 的 `dl`
  统计里含有单字项，语料极大时 `avgdl` 偏大、打分偏保守。
- `buildTermFrequencies()`：入库时预计算 `terms`（词项 → 词频）与 `length`，检索时只打分。
- `searchChunks()`：标准 BM25，`k1 = 1.2`、`b = 0.75`，
  `idf = log(1 + (N - df + 0.5) / (df + 0.5))`，
  `saturation = tf / (tf + k1 * (1 - b + b * dl / avgdl))`。

### 3.2 存储布局

```
<OPENTEACH_KB_DIR>/<kbName>/
├── documents.json   # 文档元数据 + 全文（用于重建索引）
└── chunks.json      # 分块 + 预计算词频
```

- 写入用「临时文件 + `rename`」保证原子性。
- `KB_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/` 挡住路径穿越；非法库名在路由层就是 400。
- 文档 id 用 `randomUUID()`，不引入额外依赖。
- **「库存在」= 目录存在**，不靠「有没有文档」推断：`createKnowledgeBase()` 会显式
  建目录并落两份空 JSON，因此空库在磁盘上是可见状态，`listKnowledgeBases()` 能列出它，
  检索它返回 0 命中而不是 404。
- **读路径无副作用**：`pathOf()` 只拼接路径，不 `mkdir`；只有 `index()` 与
  `createKnowledgeBase()` 会建目录。旧实现把 `mkdir` 放在读路径上，导致「删掉文档后
  目录又被重建」，空库永远删不干净。
- **整库删除是目录级 `rm -rf`**（`removeKnowledgeBase()`），连同两份 JSON 一起删除；
  库不存在时返回 false（→ 路由 404），不会先把目录建出来。
- `documents.json` 与 `chunks.json` 是**两次独立的原子写**，两者之间没有跨文件事务：
  进程在其中一次写完后崩溃，会留下元数据与分块不一致的库（本包按 MVP 接受这一窗口，
  修复手段是重新入库该文档）。

### 3.3 多查询检索（Smart Retrieval）

默认**关闭**（`OPENTEACH_KB_SMART_RETRIEVAL=true` 开启）。开启且 LLM 可用时：

1. `generateQueries`：让 LLM 把原查询改写成若干检索式（失败 → `[原查询]`）
2. `Promise.allSettled` 并发检索，`Map` 去重并保留最高分
3. `aggregate`：让 LLM 把命中片段合成 `answer`（失败 → 直接拼接）

两处 LLM 调用都各自 try/catch 降级，任一步失败都不影响检索本身返回结果。

---

## 4. HTTP 契约

前缀 `/api/kb`。响应信封与 `openmaic-core` 一致：
`{ success: true, ...data }` / `{ success: false, errorCode, error, details? }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/knowledge-bases` | → `{ data: { knowledgeBases: string[] } }` |
| POST | `/knowledge-bases` | body `{ kbName }` → 201 `{ data: { kbName, created: true } }`；已存在为 409 `KB_EXISTS` |
| DELETE | `/knowledge-bases/:kbName` | 整库删除（含全部文档与分块）→ `{ data: { kbName, removed: true } }`；不存在为 404 `KB_NOT_FOUND` |
| GET | `/:kbName/documents` | → `{ data: { documents: KbDocument[] } }`；库不存在为 404 `KB_NOT_FOUND` |
| DELETE | `/:kbName/documents/:documentId` | → `{ data: { removed: boolean } }`；库不存在为 404 `KB_NOT_FOUND`，文档不存在为 404 `ASSET_NOT_FOUND` |
| POST | `/index` | body `{ kbName, title, text, source?, mimeType? }` → 201 `{ data: { document } }`（库不存在时**随之创建**） |
| POST | `/search` | body `{ kbName, query, topK?, smart? }` → `{ data: { ...KbSearchResult, context } }`；库不存在为 404 `KB_NOT_FOUND` |

要点：

- **`kbName` 必填且不回落默认库**（与参考实现 `rag_search` 一致）：避免检索悄悄跑到别的库上。
- `POST /search` 额外返回 **`context`** —— 已由 `formatKbResultsAsContext()` 拼好的字符串，
  调用方**不需要**自己拼装，直接当作 `externalContext` 透传即可。
- 存储不可用（目录不可写）时全部接口返回 503 `KB_UNAVAILABLE`。
- **新建与删除都挂在 `/knowledge-bases` 这个字面量路径上**，不写成 `POST /:kbName`：
  Express 按注册顺序匹配，动态段会遮蔽 `/index`、`/search` 这些字面量路由。
- **库不存在分两层处理**：HTTP 层用 `requireExistingKb()` 回 404 `KB_NOT_FOUND`，让调用方
  能区分「库不存在 / 库为空 / 无命中」；服务层（`KbService.search()`）仍对不存在的库
  返回空结果，保证内部调用方（课堂生成）不会被一次检索打断。
- `POST /index` 是唯一「隐式建库」的入口（首次入库随之产生目录）；用户显式建空库走
  `POST /knowledge-bases`。

`context` 的形态：

```
以下是本地知识库「demo」中检索到的参考资料：

- 【FPGA 基础】（来源：fpga.pdf）
  查找表（Look-Up Table，LUT）是 FPGA 实现组合逻辑的基本单元……
```

---

## 5. 降级矩阵

| 情形 | 行为 |
| --- | --- |
| 未装配 kb 插件 | `/api/kb` 不存在（落到 `/api` 501 兜底）；内核不受影响 |
| 存储目录不可写 | 插件仍装配，`available = false`；接口 503；**不阻断课堂生成** |
| `eduLlm` 缺失 | 检索正常工作，smart 自动退化为单查询、`answer` 为空串 |
| LLM 改写/聚合失败 | 各自 try/catch 回落到原查询 / 直接拼接 |
| 检索命中为空 | `context` 为空串；调用方不注入，行为与不选知识库一致 |
| 检索的库不存在 | HTTP 404 `KB_NOT_FOUND`；前端提示「检索失败，已跳过」并照常生成 |
| 前端 `/api/kb` 不可达 | 探针失败 → 隐藏知识库入口（见 §6） |

---

## 6. 前端接入

前端 [`OpenTeach-frontend`](../../../OpenTeach-frontend)（Next.js）通过 `next.config.ts` 的
`beforeFiles` 重写把 `/api/*` 代理到 OpenTeach 后端，因此 `/api/kb/*` 无需额外配置。

| 位置 | 作用 |
| --- | --- |
| `lib/kb/client.ts` | 七个端点的类型化封装 + `KbApiError`（带 `status`/`code`/`notFound`）+ `probeKnowledgeBase()` 可用性探针 |
| `components/knowledge/knowledge-manager-dialog.tsx` | 管理弹窗：库列表 / 文档列表 / 新建空库 / 入库 / 删文档 / **删整库** |
| `app/page.tsx` | 生成表单新增「知识库」chip（Select + 管理入口），选用持久化到 `localStorage` |
| `app/generation-preview/page.tsx` | 在联网调研之后发起 `/api/kb/search`，把 `context` 并入 `researchContext`，并给出可见反馈 |
| `app/generation-preview/types.ts` | 会话新增 `kbName?: string` |

**目录以服务端为唯一真相**：弹窗每次变更（新建 / 删除）都重新拉 `GET /knowledge-bases`，
并通过 `onCatalogChange` 把最新列表回调给表单 —— 否则弹窗里新建的库在表单下拉里看不见，
只能刷新页面。表单侧同理：探针成功后再校验一次已存的 `kbName` 是否仍在目录中，不在就
清空选择并同步清掉 `localStorage`。

**入口可见性由探针决定**：`probeKnowledgeBase()` 失败（后端未装配本插件，或 `/api/kb`
未被代理）时返回 `available: false`，表单不渲染整行知识库入口 —— 与仓库既有的
「后端未实现的入口一律隐藏」约定一致。

**降级 + 反馈**：preview 里的检索失败只提示、不阻断生成 —— 命中注入上下文时显示
「已引用 N 条片段」，未命中显示「无相关内容」，失败（含 404 `KB_NOT_FOUND`）显示
「检索失败，已跳过」，三种终态都有可见文案，不再只写 console。

### 端到端用法

```bash
# 0. （可选）显式建一个空库；入库也会隐式建库
curl -X POST http://127.0.0.1:8787/api/kb/knowledge-bases \
  -H 'Content-Type: application/json' \
  -d '{"kbName":"fpga"}'

# 1. 入库
curl -X POST http://127.0.0.1:8787/api/kb/index \
  -H 'Content-Type: application/json' \
  -d '{"kbName":"fpga","title":"FPGA 基础","text":"……","source":"fpga.pdf"}'

# 2. 检索，直接拿 data.context
curl -X POST http://127.0.0.1:8787/api/kb/search \
  -H 'Content-Type: application/json' \
  -d '{"kbName":"fpga","query":"查找表是什么"}'

# 3. 注入课堂生成
curl -X POST http://127.0.0.1:8787/api/generate-classroom \
  -H 'Content-Type: application/json' \
  -d '{"requirement":"讲一节 FPGA 入门课","externalContext":"<上一步的 data.context>"}'

# 4. 整库删除
curl -X DELETE http://127.0.0.1:8787/api/kb/knowledge-bases/fpga
```

前端走的是 `scene-outlines-stream` 那条链路，它的请求体**本来就有 `researchContext`**，
所以前端在客户端把 KB 与 web search 的上下文合并后一并传入，无需给该路由新增字段。
`externalContext` 这个字段是给 `/api/generate-classroom`（工具调用 / 外部集成）用的，
前端自给自足模式下的同名实现（`lib/server/classroom-generation.ts`）也已同步对齐。

---

## 7. 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OPENTEACH_KB_DIR` | `<cwd>/data/kb` | 存储根目录，与 db 插件的 `data/openteach.db` 同目录 |
| `OPENTEACH_KB_CHUNK_SIZE` | `800` | 单块目标字符数 |
| `OPENTEACH_KB_CHUNK_OVERLAP` | `120` | 相邻块重叠字符数（被收敛到 `chunkSize / 2` 以内） |
| `OPENTEACH_KB_TOP_K` | `6` | 默认返回条数 |
| `OPENTEACH_KB_MAX_QUERIES` | `3` | 多查询检索的查询数上限 |
| `OPENTEACH_KB_SMART_RETRIEVAL` | `false` | 是否默认启用多查询 + LLM 聚合 |

无 API Key、无明文凭据：引擎是纯本地词法检索，LLM（若可用）只用于改写与聚合。

---

## 8. 明确不做（与参考实现的边界）

参考 DeepTutor 的 `RAGPipeline` Protocol、`rag_search`、`SmartRetriever` 契约，但**不复制**：

- GraphRAG / LightRAG 等图检索与外部产品绑定
- 完整知识库生命周期管理（多租户、版本、权限、配额）
- 文档解析（PDF / 音视频）：复用 `openmaic-core` 已有的 `POST /api/extract-document`，
  本插件只接收**已解析的文本**（`KbIndexInput.text`）