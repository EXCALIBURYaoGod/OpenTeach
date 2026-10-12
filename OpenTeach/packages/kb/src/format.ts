/**
 * 把检索结果格式化为可注入课堂生成的 Markdown 上下文块。
 *
 * 与 `packages/openmaic-core/src/lib/web-search/format.ts` 的
 * `formatSearchResultsAsContext` 同构：产出的字符串由调用方作为
 * `externalContext` 透传给 `POST /api/generate-classroom`，最终与 web search
 * 结果合并成同一段 researchContext。
 *
 * 命中片段不截断：块长在入库时已由 `chunkSize` 约束，条数由 `topK` 约束。
 *
 * @module kb/format
 */

import type { KbSearchResult } from './types.js'

export function formatKbResultsAsContext(result: KbSearchResult): string {
  const lines: string[] = []

  if (result.answer.trim() !== '') {
    lines.push(result.answer.trim(), '')
  }

  if (result.hits.length > 0) {
    lines.push(`以下是本地知识库「${result.kbName}」中检索到的参考资料：`, '')
    for (const hit of result.hits) {
      const source = hit.source === '' ? hit.title : hit.source
      lines.push(`- 【${hit.title}】（来源：${source}）`)
      lines.push(`  ${hit.text.replace(/\n/g, '\n  ')}`)
    }
  }

  return lines.join('\n').trim()
}