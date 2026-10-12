/**
 * 多查询检索 + LLM 聚合。
 *
 * 移植参考实现 DeepTutor 的 `SmartRetriever`（`services/rag/smart_retriever.py`）：
 * 先把上下文扩写成多个查询，再并发检索、合并去重，最后让 LLM 把命中片段合成
 * 一段摘要。
 *
 * 两处 LLM 调用都可降级，与参考实现一致：
 * - 查询生成失败 → 退化为「只用原始查询」；
 * - 聚合失败 → 退化为「直接拼接命中片段」。
 *
 * @module kb/smart-retriever
 */

import type { KbSearchHit } from './types.js'

/** 单轮文本补全：由插件层适配 `eduLlm`。 */
export type LlmComplete = (system: string, user: string) => Promise<string>

/** 查询生成时喂给 LLM 的上下文长度上限（参考实现同为 2000）。 */
const CONTEXT_LIMIT = 2000
/** 聚合时喂给 LLM 的片段总长上限。 */
const PASSAGE_LIMIT = 6000
/** 聚合时喂给 LLM 的上下文长度上限。 */
const AGGREGATE_CONTEXT_LIMIT = 1000

/** 生成查询变体；失败时退化为原始查询。 */
async function generateQueries(
  query: string,
  complete: LlmComplete,
  maxQueries: number,
): Promise<string[]> {
  try {
    const raw = await complete(
      '你是检索查询生成器。',
      `针对下面的上下文，生成 ${maxQueries} 条不同的检索查询，用于从知识库中取回相关信息。` +
        `只输出查询本身，每行一条。\n\n上下文：\n${query.slice(0, CONTEXT_LIMIT)}`,
    )
    const queries = raw
      .split('\n')
      .map((line) => line.replace(/^\s*\d+\s*[.、)）-]\s*/, '').trim())
      .filter((line) => line !== '')
    return queries.length > 0 ? queries.slice(0, maxQueries) : [query]
  } catch {
    return [query]
  }
}

/** 聚合命中片段；失败时退化为拼接。 */
async function aggregate(
  query: string,
  hits: readonly KbSearchHit[],
  complete: LlmComplete,
): Promise<string> {
  const combined = hits.map((hit) => hit.text).join('\n---\n')
  try {
    return await complete(
      '你是知识综合器。',
      '把下面从知识库检索到的片段，针对给定上下文综合成一段简洁、相关的摘要。\n\n' +
        `上下文：\n${query.slice(0, AGGREGATE_CONTEXT_LIMIT)}\n\n` +
        `片段：\n${combined.slice(0, PASSAGE_LIMIT)}`,
    )
  } catch {
    return hits.map((hit) => hit.text).join('\n\n')
  }
}

export interface SmartRetrieveOptions {
  query: string
  /** 单查询检索；由插件层绑定知识库与 topK。 */
  search: (query: string) => Promise<KbSearchHit[]>
  /** 省略时退化为单查询检索，不做任何 LLM 调用。 */
  complete?: LlmComplete
  maxQueries: number
  topK: number
}

export interface SmartRetrieveResult {
  queries: string[]
  hits: KbSearchHit[]
  answer: string
}

/** 多查询检索 + 聚合。未提供 `complete` 时等价于单查询检索。 */
export async function smartRetrieve(options: SmartRetrieveOptions): Promise<SmartRetrieveResult> {
  const { query, search, complete, maxQueries, topK } = options
  if (complete === undefined) {
    const hits = await search(query)
    return { queries: [query], hits, answer: '' }
  }

  const queries = [...new Set(await generateQueries(query, complete, maxQueries))]
  const settled = await Promise.allSettled(queries.map((item) => search(item)))

  // 合并去重：同一块被多个查询命中时保留最高分。
  const merged = new Map<string, KbSearchHit>()
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    for (const hit of result.value) {
      const existing = merged.get(hit.chunkId)
      if (existing === undefined || hit.score > existing.score) merged.set(hit.chunkId, hit)
    }
  }
  const hits = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, topK)
  if (hits.length === 0) return { queries, hits, answer: '' }

  return { queries, hits, answer: await aggregate(query, hits, complete) }
}