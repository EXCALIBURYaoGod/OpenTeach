/**
 * KB 插件配置：全部可由环境变量提供，无凭据、无明文。
 *
 * 与 `packages/openmaic-core` 的 web search 配置一样，本插件不要求 API Key 即可
 * 工作——内置检索引擎是纯本地词法检索。
 *
 * @module kb/config
 */

import { isAbsolute, join } from 'node:path'

export interface KbConfig {
  /** 存储根目录。每个知识库一个子目录。 */
  dir: string
  /** 单块目标字符数。 */
  chunkSize: number
  /** 相邻块的重叠字符数。 */
  chunkOverlap: number
  /** 默认返回条数。 */
  topK: number
  /** 多查询检索的查询数上限。 */
  maxQueries: number
  /** 默认是否启用多查询 + LLM 聚合。 */
  smartRetrieval: boolean
}

/** 正整数环境变量；缺省、非数字或非正数时取回落值。 */
function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** 布尔环境变量：`true` / `1` 为真，其余为假。 */
function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  return raw === 'true' || raw === '1'
}

/**
 * 解析配置。显式传入的字段优先于环境变量。
 *
 * `OPENTEACH_KB_DIR` 缺省为 `<cwd>/data/kb`，与 db 插件的
 * `<cwd>/data/openteach.db` 落在同一个数据目录下。
 */
export function resolveKbConfig(overrides: Partial<KbConfig> = {}): KbConfig {
  const dir = overrides.dir ?? process.env.OPENTEACH_KB_DIR ?? join('data', 'kb')
  const chunkSize = overrides.chunkSize ?? intFromEnv('OPENTEACH_KB_CHUNK_SIZE', 800)
  return {
    dir: isAbsolute(dir) ? dir : join(process.cwd(), dir),
    chunkSize,
    // 重叠必须小于块长，否则切分会原地踏步；越界时收敛到块长的一半。
    chunkOverlap: Math.min(
      overrides.chunkOverlap ?? intFromEnv('OPENTEACH_KB_CHUNK_OVERLAP', 120),
      Math.floor(chunkSize / 2),
    ),
    topK: overrides.topK ?? intFromEnv('OPENTEACH_KB_TOP_K', 6),
    maxQueries: overrides.maxQueries ?? intFromEnv('OPENTEACH_KB_MAX_QUERIES', 3),
    smartRetrieval: overrides.smartRetrieval ?? boolFromEnv('OPENTEACH_KB_SMART_RETRIEVAL', false),
  }
}