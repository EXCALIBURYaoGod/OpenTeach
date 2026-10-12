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
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
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
  /** 知识库目录是否存在。读路径靠它区分「库不存在」与「库为空」。 */
  hasKnowledgeBase(kbName: string): Promise<boolean>
  /** 显式新建空知识库；已存在时返回 false（不覆盖既有内容）。 */
  createKnowledgeBase(kbName: string): Promise<boolean>
  /** 删除整个知识库目录（含全部文档与分块）；不存在时返回 false。 */
  removeKnowledgeBase(kbName: string): Promise<boolean>
  listDocuments(kbName: string): Promise<KbDocument[]>
  loadChunks(kbName: string): Promise<KbChunk[]>
  /** 切分、建索引并落盘，返回新建的文档。库不存在时按「入库即建库」隐式创建。 */
  index(kbName: string, input: Omit<KbIndexInput, 'kbName'>, chunkSize: number, chunkOverlap: number): Promise<KbDocument>
  /** 删除文档及其全部分块；文档或知识库不存在时返回 false。 */
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
  /** 知识库目录路径。纯拼接，**不建目录**——读路径不能有副作用。 */
  function pathOf(kbName: string): string {
    return join(dir, assertKbName(kbName))
  }

  /** 目录是否存在（且确实是目录）。 */
  async function isDir(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory()
    } catch {
      return false
    }
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

    async hasKnowledgeBase(kbName) {
      return isDir(pathOf(kbName))
    },

    async createKnowledgeBase(kbName) {
      const path = pathOf(kbName)
      if (await isDir(path)) return false
      await mkdir(path, { recursive: true })
      // 落一份空索引，让「新建的空库」在磁盘上是显式存在的状态，而不是靠目录本身推断。
      await writeJson(join(path, 'documents.json'), [])
      await writeJson(join(path, 'chunks.json'), [])
      return true
    },

    async removeKnowledgeBase(kbName) {
      const path = pathOf(kbName)
      if (!(await isDir(path))) return false
      await rm(path, { recursive: true, force: true })
      return true
    },

    async listDocuments(kbName) {
      return readJson<KbDocument[]>(join(pathOf(kbName), 'documents.json'), [])
    },

    async loadChunks(kbName) {
      return readJson<KbChunk[]>(join(pathOf(kbName), 'chunks.json'), [])
    },

    async index(kbName, input, chunkSize, chunkOverlap) {
      const text = input.text.trim()
      if (text === '') throw new Error('入库文本为空：请先通过文档解析拿到正文后再入库')

      // 入库即建库：这是新知识库的隐式创建路径（显式创建见 createKnowledgeBase）。
      const path = pathOf(kbName)
      await mkdir(path, { recursive: true })
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
      const path = pathOf(kbName)
      // 库不存在就直接返回：删除不应把目录建出来（旧实现会在读路径上 mkdir）。
      if (!(await isDir(path))) return false
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