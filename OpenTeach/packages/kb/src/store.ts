/**
 * KB 存储：文件系统按知识库分目录落盘。
 *
 * 选文件而非 SQLite，是为了让本插件与 db 插件完全解耦——它可以独立装卸、独立
 * 配置存储目录（`OPENTEACH_KB_DIR`），不要求宿主先装配数据库；同时零原生依赖。
 *
 * 目录结构（`<dir>/<kbName>/`）：
 * - `documents.json`：文档元数据 + 全文；
 * - `chunks.json`：切分后的块与预计算词频。
 *
 * 写入用「临时文件 + rename」保证原子性，避免进程中断留下半截 JSON。
 *
 * @module kb/store
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chunkText } from './chunking.js'
import { buildTermFrequencies, tokenize } from './engine.js'
import type { KbChunk, KbDocument, KbIndexInput } from './types.js'

/** 知识库名只允许这些字符：它直接参与路径拼接，必须挡住路径穿越。 */
const KB_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function isValidKbName(kbName: string): boolean {
  return KB_NAME_PATTERN.test(kbName)
}

export function assertKbName(kbName: string): string {
  if (!isValidKbName(kbName)) {
    throw new Error(`知识库名非法（仅允许字母/数字/下划线/连字符，1-64 位）："${kbName}"`)
  }
  return kbName
}

export interface KbStore {
  listKnowledgeBases(): Promise<string[]>
  listDocuments(kbName: string): Promise<KbDocument[]>
  loadChunks(kbName: string): Promise<KbChunk[]>
  /** 切分、建索引并落盘，返回新建的文档。 */
  index(kbName: string, input: Omit<KbIndexInput, 'kbName'>, chunkSize: number, chunkOverlap: number): Promise<KbDocument>
  /** 删除文档及其全部分块；文档不存在时返回 false。 */
  remove(kbName: string, documentId: string): Promise<boolean>
}

/** 读取 JSON；文件不存在或内容损坏时返回回落值（不阻断调用方）。 */
async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** 原子写入 JSON。 */
async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value), 'utf8')
  await rename(temporary, path)
}

export function createKbStore(dir: string): KbStore {
  /** 知识库目录；已确保存在。 */
  async function kbDir(kbName: string): Promise<string> {
    const path = join(dir, assertKbName(kbName))
    await mkdir(path, { recursive: true })
    return path
  }

  return {
    async listKnowledgeBases() {
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        return entries
          .filter((entry) => entry.isDirectory() && KB_NAME_PATTERN.test(entry.name))
          .map((entry) => entry.name)
          .sort()
      } catch {
        // 根目录尚未创建：视为空知识库集合，而不是错误。
        return []
      }
    },

    async listDocuments(kbName) {
      return readJson<KbDocument[]>(join(dir, assertKbName(kbName), 'documents.json'), [])
    },

    async loadChunks(kbName) {
      return readJson<KbChunk[]>(join(dir, assertKbName(kbName), 'chunks.json'), [])
    },

    async index(kbName, input, chunkSize, chunkOverlap) {
      const text = input.text.trim()
      if (text === '') throw new Error('入库文本为空：请先通过文档解析拿到正文后再入库')

      const path = await kbDir(kbName)
      const documents = await readJson<KbDocument[]>(join(path, 'documents.json'), [])
      const chunks = await readJson<KbChunk[]>(join(path, 'chunks.json'), [])

      const documentId = randomUUID()
      const pieces = chunkText(text, chunkSize, chunkOverlap)
      if (pieces.length === 0) throw new Error('入库文本切分后为空：请检查正文内容')

      const document: KbDocument = {
        id: documentId,
        title: input.title.trim() || '未命名文档',
        source: input.source?.trim() || input.title.trim() || '未命名文档',
        ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
        text,
        chunkCount: pieces.length,
        createdAt: Date.now(),
      }

      const newChunks: KbChunk[] = pieces.map((piece) => {
        const { terms, length } = buildTermFrequencies(tokenize(piece.text))
        return {
          id: `${documentId}:${piece.index}`,
          documentId,
          index: piece.index,
          text: piece.text,
          terms,
          length,
        }
      })

      await writeJson(join(path, 'documents.json'), [...documents, document])
      await writeJson(join(path, 'chunks.json'), [...chunks, ...newChunks])
      return document
    },

    async remove(kbName, documentId) {
      const path = await kbDir(kbName)
      const documents = await readJson<KbDocument[]>(join(path, 'documents.json'), [])
      const remaining = documents.filter((document) => document.id !== documentId)
      if (remaining.length === documents.length) return false

      const chunks = await readJson<KbChunk[]>(join(path, 'chunks.json'), [])
      await writeJson(join(path, 'documents.json'), remaining)
      await writeJson(
        join(path, 'chunks.json'),
        chunks.filter((chunk) => chunk.documentId !== documentId),
      )
      return true
    },
  }
}