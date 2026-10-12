/**
 * 内置检索引擎：BM25 轻量实现。
 *
 * 选词法检索而非向量检索作为默认引擎：零依赖、零凭据、离线可用，与本仓库
 * 「没有任何 API Key 也能跑通主链路」的降级哲学一致（对齐 llm 插件无凭据时
 * 回落 mock 适配器的做法）。需要向量检索时可在本文件旁新增引擎实现，服务契约
 * 不变。
 *
 * 分词：ASCII 单词（长度 ≥ 2，小写）+ CJK 字符二元组。中文没有空格，二元组是
 * 零依赖下最稳的召回手段；英文用整词，避免二元组带来的噪声。
 *
 * @module kb/engine
 */

import type { KbChunk, KbDocument, KbSearchHit } from './types.js'

/** BM25 参数：词频饱和系数与长度归一化强度（业界常用默认值）。 */
const K1 = 1.2
const B = 0.75

/** CJK 统一表意文字及扩展区的码点范围。 */
function isCjk(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff)
  )
}

/** 分词：ASCII 单词 + CJK 二元组。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lowered = text.toLowerCase()
  let ascii = ''
  let cjk: number[] = []

  const flushAscii = (): void => {
    if (ascii.length >= 2) tokens.push(ascii)
    ascii = ''
  }
  const flushCjk = (): void => {
    for (let i = 0; i < cjk.length; i += 1) {
      tokens.push(String.fromCharCode(cjk[i]))
      if (i + 1 < cjk.length) tokens.push(String.fromCharCode(cjk[i], cjk[i + 1]))
    }
    cjk = []
  }

  for (const char of lowered) {
    const code = char.codePointAt(0) ?? 0
    if (isCjk(code)) {
      flushAscii()
      cjk.push(code)
      continue
    }
    flushCjk()
    // 字母数字保留在单词内，其余字符（空格、标点）作为分隔。
    if (/[0-9a-z]/.test(char)) {
      ascii += char
    } else {
      flushAscii()
    }
  }
  flushAscii()
  flushCjk()
  return tokens
}

/** 统计词频与词项总数。 */
export function buildTermFrequencies(tokens: string[]): {
  terms: Record<string, number>
  length: number
} {
  const terms: Record<string, number> = {}
  for (const token of tokens) {
    terms[token] = (terms[token] ?? 0) + 1
  }
  return { terms, length: tokens.length }
}

/**
 * 在一组分块上做 BM25 检索，返回得分降序的命中。
 *
 * 词频与长度已随分块预计算；查询时只需算文档频率（df）与平均长度，因此不需要
 * 常驻的倒排索引结构。
 */
export function searchChunks(
  query: string,
  chunks: readonly KbChunk[],
  documents: ReadonlyMap<string, KbDocument>,
  topK: number,
): KbSearchHit[] {
  const queryTerms = [...new Set(tokenize(query))]
  if (queryTerms.length === 0 || chunks.length === 0) return []

  const documentFrequency = new Map<string, number>()
  let totalLength = 0
  for (const chunk of chunks) {
    totalLength += chunk.length
    for (const term of queryTerms) {
      if (chunk.terms[term] !== undefined) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
      }
    }
  }
  const averageLength = totalLength / chunks.length || 1

  const hits: KbSearchHit[] = []
  for (const chunk of chunks) {
    let score = 0
    for (const term of queryTerms) {
      const frequency = chunk.terms[term]
      if (frequency === undefined) continue
      const df = documentFrequency.get(term) ?? 0
      // BM25 的 idf 变体，+0.5 平滑避免除零。
      const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5))
      const saturation = frequency / (frequency + K1 * (1 - B + (B * chunk.length) / averageLength))
      score += idf * saturation * (K1 + 1)
    }
    if (score <= 0) continue

    const document = documents.get(chunk.documentId)
    hits.push({
      chunkId: chunk.id,
      documentId: chunk.documentId,
      title: document?.title ?? '未命名文档',
      source: document?.source ?? '',
      score,
      text: chunk.text,
    })
  }

  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, topK)
}