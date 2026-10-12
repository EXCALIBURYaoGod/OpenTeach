/**
 * 知识库（KB）插件契约类型。
 *
 * 引擎侧契约（`initialize` / `add_documents` / `search` / `delete`）对齐参考实现
 * DeepTutor 的 `RAGPipeline` Protocol，但按本仓库的 MVP 规模收窄为「本地词法索引
 * + 检索上下文注入」：不含 GraphRAG/LightRAG 等外部产品绑定，也不含完整知识库
 * 生命周期管理。
 *
 * @module kb/types
 */

import type { RequestHandler } from 'express'

/** 一个已入库文档。 */
export interface KbDocument {
  id: string
  /** 文档标题，用于引用展示。 */
  title: string
  /** 来源标识：文件名 / URL / 素材 id。 */
  source: string
  mimeType?: string
  /** 正文全文（保留以便重建索引）。 */
  text: string
  /** 分块数。 */
  chunkCount: number
  createdAt: number
}

/** 文档切分后的一个可检索块。 */
export interface KbChunk {
  id: string
  documentId: string
  /** 块在所属文档内的序号（从 0 起）。 */
  index: number
  text: string
  /** 词项 → 词频，入库时算好，检索时只做打分。 */
  terms: Record<string, number>
  /** 词项总数，供 BM25 做长度归一化。 */
  length: number
}

/** 一条检索命中。 */
export interface KbSearchHit {
  chunkId: string
  documentId: string
  title: string
  source: string
  score: number
  text: string
}

/** 一次检索的完整结果。 */
export interface KbSearchResult {
  /** 原始查询。 */
  query: string
  /** 检索的知识库名。 */
  kbName: string
  /** 实际参与检索的查询列表；多查询检索时长度 > 1。 */
  queries: string[]
  hits: KbSearchHit[]
  /**
   * 聚合摘要：多查询检索下由 LLM 合成；LLM 不可用或未开启时为空串，
   * 由 {@link KbService.formatContext} 直接用命中片段拼装。
   */
  answer: string
  /** 检索耗时（毫秒）。 */
  responseTime: number
}

/** 检索入参。 */
export interface KbSearchInput {
  query: string
  /**
   * 知识库名。必填且必须已存在：不回落默认库（与参考实现 `rag_search` 一致）。
   * 存在性由 **HTTP 层**校验（库不存在回 404 `KB_NOT_FOUND`）；服务层保持优雅降级
   * ——库不存在时返回空结果，避免内部调用方（课堂生成）被一次检索失败打断。
   */
  kbName: string
  /** 返回条数上限；省略时取配置默认值。 */
  topK?: number
  /** 是否启用多查询 + LLM 聚合；省略时取配置默认值。 */
  smart?: boolean
}

/** 入库入参。 */
export interface KbIndexInput {
  kbName: string
  title: string
  /** 来源标识；省略时取 title。 */
  source?: string
  mimeType?: string
  /** 已解析的正文。文档解析（PDF/音视频）复用 openmaic-core 的
   * `POST /api/extract-document`，本插件不复制其解析实现。 */
  text: string
}

/** 对外服务契约（服务名 `openmaic.kb`）。 */
export interface KbService {
  /** 存储可用性。目录不可写时为 false，检索返回空结果并告警，不阻断主链路。 */
  available: boolean
  /**
   * 子路由，由 http 插件挂在 `express.json()` 之后、`/api` 501 兜底之前
   * （见 `packages/http/src/app.ts`）。
   */
  router: RequestHandler
  /** 列出已存在的知识库名。 */
  listKnowledgeBases(): Promise<string[]>
  /** 知识库是否存在。读路径靠它区分「库不存在」与「库为空」。 */
  hasKnowledgeBase(kbName: string): Promise<boolean>
  /** 新建空知识库；已存在时返回 false。 */
  createKnowledgeBase(kbName: string): Promise<boolean>
  /** 删除整个知识库（含全部文档与分块）；不存在时返回 false。 */
  removeKnowledgeBase(kbName: string): Promise<boolean>
  /** 列出某知识库的文档。 */
  listDocuments(kbName: string): Promise<KbDocument[]>
  /** 入库：切分 + 建索引。 */
  index(input: KbIndexInput): Promise<KbDocument>
  /** 删除文档及其分块。 */
  remove(kbName: string, documentId: string): Promise<boolean>
  /** 检索。 */
  search(input: KbSearchInput): Promise<KbSearchResult>
  /** 把检索结果格式化为可注入课堂生成的上下文字符串。 */
  formatContext(result: KbSearchResult): string
}