/**
 * 文本分块：按段落 / 句子边界切分，块间保留重叠。
 *
 * 先按自然边界切，再按目标长度打包：这样检索命中的块在语义上尽量完整；单个
 * 句子本身超长（例如无标点的长表格文本）时才硬切。重叠保证跨块的答案不会被
 * 边界割裂。
 *
 * @module kb/chunking
 */

export interface TextChunk {
  /** 块在文档内的序号（从 0 起）。 */
  index: number
  text: string
}

/** 句子边界：中英文句末标点、分号与换行。 */
const SENTENCE_BOUNDARY = /([。！？!?；;]+|\n+)/

/** 归一化空白：统一换行、压缩连续空行、去掉行尾空格。 */
function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 把文本切成句子级片段（保留标点与换行分隔符）。 */
function splitSentences(text: string): string[] {
  const parts = text.split(SENTENCE_BOUNDARY)
  const sentences: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const body = parts[i] ?? ''
    const separator = parts[i + 1] ?? ''
    const sentence = (body + separator).trim()
    if (sentence !== '') sentences.push(sentence)
  }
  return sentences
}

/** 句子超长时按目标长度硬切。 */
function hardSplit(sentence: string, size: number): string[] {
  if (sentence.length <= size) return [sentence]
  const pieces: string[] = []
  for (let start = 0; start < sentence.length; start += size) {
    pieces.push(sentence.slice(start, start + size))
  }
  return pieces
}

/**
 * 切分为块。
 *
 * @param text 归一化前的原文。
 * @param size 单块目标字符数。
 * @param overlap 相邻块的重叠字符数；调用方需保证 `0 <= overlap < size`。
 */
export function chunkText(text: string, size: number, overlap: number): TextChunk[] {
  const normalized = normalize(text)
  if (normalized === '') return []

  const units = splitSentences(normalized).flatMap((sentence) => hardSplit(sentence, size))
  const chunks: string[] = []
  let current = ''

  for (const unit of units) {
    // 当前块已接近目标长度且再加入本句会超长时，先封块。
    if (current !== '' && current.length + unit.length + 1 > size) {
      chunks.push(current)
      // 用尾部长度的片段作为下一块的开头，保留跨块上下文。
      const tail = overlap > 0 ? current.slice(-overlap) : ''
      current = tail
    }
    current = current === '' ? unit : `${current}\n${unit}`
  }
  if (current.trim() !== '') chunks.push(current)

  return chunks.map((chunk, index) => ({ index, text: chunk }))
}