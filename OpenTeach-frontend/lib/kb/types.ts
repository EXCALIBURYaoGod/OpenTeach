/**
 * 知识库（KB）前端契约类型。
 *
 * 与 OpenTeach 后端 `@openteach/plugin-kb` 的 `KbService` 一一对应
 * （见 `OpenTeach/packages/kb/src/types.ts`），仅保留浏览器侧需要的字段：
 * 后端返回的 `text`（文档全文）在管理界面只用于计数，不做渲染。
 */

/** 一个已入库文档。 */
export interface KbDocument {
  id: string;
  title: string;
  /** 来源标识：文件名 / URL / 素材 id。 */
  source: string;
  mimeType?: string;
  /** 正文全文（管理界面不渲染，仅随响应回传）。 */
  text: string;
  /** 分块数。 */
  chunkCount: number;
  /** 入库时间戳（毫秒）。 */
  createdAt: number;
}

/** 一条检索命中。 */
export interface KbSearchHit {
  chunkId: string;
  documentId: string;
  title: string;
  source: string;
  score: number;
  text: string;
}

/** 一次检索的结果。 */
export interface KbSearchResult {
  query: string;
  kbName: string;
  /** 实际参与检索的查询列表；多查询检索时长度 > 1。 */
  queries: string[];
  hits: KbSearchHit[];
  /** 聚合摘要：多查询检索下由后端 LLM 合成，否则为空串。 */
  answer: string;
  /** 检索耗时（毫秒）。 */
  responseTime: number;
  /**
   * 已格式化好的上下文字符串，可直接作为课堂生成的
   * `externalContext` / 并入 `researchContext`，无需前端拼装。
   */
  context: string;
}

/** 入库入参。 */
export interface KbIndexInput {
  kbName: string;
  title: string;
  /** 已解析的正文。文档解析复用 `/api/extract-document`，前端不重复实现。 */
  text: string;
  /** 来源标识；省略时后端取 title。 */
  source?: string;
  mimeType?: string;
}

/** 检索入参。 */
export interface KbSearchInput {
  kbName: string;
  query: string;
  /** 返回条数上限；省略时取后端配置默认值。 */
  topK?: number;
  /** 是否启用多查询 + LLM 聚合；省略时取后端配置默认值。 */
  smart?: boolean;
}

/** 知识库服务可用性探针结果。 */
export interface KbStatus {
  /** 后端装配了 kb 插件且存储可写时为 true。 */
  available: boolean;
  /** 已存在的知识库名（不可用时为空数组）。 */
  knowledgeBases: string[];
}