/**
 * openmaic-kb 插件：本地知识库的索引与检索层。
 *
 * 独立成包（而不是写进 openmaic-core）的理由：知识库的引擎、分块、检索策略、
 * 存储与配置都属于可替换的实现细节，openmaic-core 只需要一个**通用的外部上下文
 * 接缝**（`GenerateClassroomInput.externalContext`）即可消费任意检索来源——包括
 * 本插件、web search，或未来的其它实现。两边通过一个字符串解耦：本插件
 * `formatContext()` 的产出即是 openmaic-core 的入参。
 *
 * Cordis 范式：命名导出 `name` / `provide` / `apply`，`ctx.provide('openmaic.kb')`
 * 注册服务，随 fiber 卸载回收。**不 inject `eduLlm`**：知识库的索引与检索本身
 * 不依赖模型，只在开启「多查询 + LLM 聚合」时才可选消费它——因此本插件可以脱离
 * llm 插件独立装卸（对齐仓库内其它插件的可选依赖写法）。
 *
 * 降级：存储目录不可写时 `available` 置 false，路由回 503，课堂生成主链路不受
 * 影响（沿用仓库既有哲学）。
 *
 * @module kb/plugin
 */

import { mkdirSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { LoadedLlm } from '@openteach/plugin-llm/loader'
import { resolveKbConfig, type KbConfig } from './config.js'
import { searchChunks } from './engine.js'
import { formatKbResultsAsContext } from './format.js'
import { createKbRouter } from './routes.js'
import { smartRetrieve, type LlmComplete } from './smart-retriever.js'
import { createKbStore } from './store.js'
import type { KbDocument, KbIndexInput, KbSearchInput, KbSearchResult, KbService } from './types.js'

/** 对外透出契约类型，调用方（如 http 插件）从包根即可拿到。 */
export type {
  KbChunk,
  KbDocument,
  KbIndexInput,
  KbSearchHit,
  KbSearchInput,
  KbSearchResult,
  KbService,
} from './types.js'

export const name = 'openmaic:kb'
export const provide = 'openmaic.kb'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 本地知识库的索引与检索服务。 */
    'openmaic.kb': KbService
  }
}

/**
 * 把 `eduLlm` 适配为单轮文本补全。
 *
 * 省略 provider / model 之外的参数：由 llm 插件负责路由与凭据，这里只取默认
 * 路由。`finish` 只在 error / aborted 时抛错——`max-tokens` 截断的文本对查询
 * 生成与摘要仍有价值，交给上层决定要不要降级。
 */
function createLlmComplete(llm: LoadedLlm | undefined): LlmComplete | undefined {
  if (llm === undefined) return undefined
  return async (system, user) => {
    let text = ''
    for await (const chunk of llm.runtime.stream({
      provider: llm.defaultProvider,
      model: llm.defaultModel,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens: 1024,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        throw new Error(`LLM 调用未正常结束：${chunk.reason.kind}`)
      }
    }
    return text
  }
}

export function apply(ctx: Context, config: Partial<KbConfig> = {}): () => void {
  const resolved = resolveKbConfig(config)
  const store = createKbStore(resolved.dir)

  let available = true
  try {
    mkdirSync(resolved.dir, { recursive: true })
  } catch (error) {
    available = false
    console.warn(
      `[openmaic] 知识库存储目录不可用（${resolved.dir}），KB 能力降级为空（不阻断主链路）：`,
      error,
    )
  }

  const complete = createLlmComplete(ctx.get('eduLlm'))

  /** 空结果的统一形状：检索失败、库为空、未命中都走这里。 */
  function emptyResult(query: string, kbName: string, queries: string[], startedAt: number): KbSearchResult {
    return { query, kbName, queries, hits: [], answer: '', responseTime: Date.now() - startedAt }
  }

  async function search(input: KbSearchInput): Promise<KbSearchResult> {
    const startedAt = Date.now()
    const { kbName, query } = input
    if (!available) {
      console.warn(`[openmaic] 知识库存储不可用，跳过检索（kb=${kbName}）`)
      return emptyResult(query, kbName, [query], startedAt)
    }

    const chunks = await store.loadChunks(kbName)
    if (chunks.length === 0) return emptyResult(query, kbName, [query], startedAt)

    const documents = new Map<string, KbDocument>()
    for (const document of await store.listDocuments(kbName)) documents.set(document.id, document)

    const topK = input.topK ?? resolved.topK
    const runSearch = async (item: string) => searchChunks(item, chunks, documents, topK)

    const result = (input.smart ?? resolved.smartRetrieval)
      ? await smartRetrieve({
          query,
          search: runSearch,
          ...(complete === undefined ? {} : { complete }),
          maxQueries: resolved.maxQueries,
          topK,
        })
      : { queries: [query], hits: await runSearch(query), answer: '' }

    return {
      query,
      kbName,
      queries: result.queries,
      hits: result.hits,
      answer: result.answer,
      responseTime: Date.now() - startedAt,
    }
  }

  /** 除路由外的能力集合；路由需要它们，因此分两步装配。 */
  const capabilities: Omit<KbService, 'router'> = {
    available,
    listKnowledgeBases: () => store.listKnowledgeBases(),
    hasKnowledgeBase: (kbName) => store.hasKnowledgeBase(kbName),
    createKnowledgeBase: (kbName) => store.createKnowledgeBase(kbName),
    removeKnowledgeBase: (kbName) => store.removeKnowledgeBase(kbName),
    listDocuments: (kbName) => store.listDocuments(kbName),
    index: (input: KbIndexInput) =>
      store.index(input.kbName, input, resolved.chunkSize, resolved.chunkOverlap),
    remove: (kbName, documentId) => store.remove(kbName, documentId),
    search,
    formatContext: formatKbResultsAsContext,
  }

  const service: KbService = {
    ...capabilities,
    // 路由由 http 插件挂在 `/api/kb` 之下（express.json() 之后、501 兜底之前）。
    router: createKbRouter(capabilities),
  }

  ctx.provide('openmaic.kb', service)

  console.log(
    `[openmaic] kb 插件已装配（dir=${resolved.dir}, topK=${resolved.topK}, ` +
      `smart=${resolved.smartRetrieval && complete !== undefined}, available=${available}）`,
  )

  return () => {
    console.log('[openmaic] kb 插件停止')
  }
}