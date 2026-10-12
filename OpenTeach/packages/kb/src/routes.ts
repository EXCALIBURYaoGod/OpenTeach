/**
 * KB 子路由。
 *
 * 与 openmaic-core 的 Next 风格分发不同：本路由由 http 插件挂在
 * `express.json()` **之后**（见 `packages/http/src/app.ts`），请求体已解析，直接
 * 读 `req.body` 即可，不需要原始流缓冲。挂载点 `/api/kb` 在 `/api` 501 兜底之前，
 * 因此不会被兜底吞掉。
 *
 * 响应信封与 openmaic-core 的 `apiSuccess` / `apiError` 保持一致
 * （`{ success: true, ... }` / `{ success: false, errorCode, error }`），前端无需
 * 为 KB 单独适配。
 *
 * @module kb/routes
 */

import { Router, type Request, type Response } from 'express'
import { isValidKbName } from './store.js'
import type { KbIndexInput, KbSearchInput, KbService } from './types.js'

function success(res: Response, data: Record<string, unknown>, status = 200): void {
  res.status(status).json({ success: true, ...data })
}

function failure(res: Response, status: number, errorCode: string, error: string, details?: string): void {
  res.status(status).json({
    success: false,
    errorCode,
    error,
    ...(details === undefined ? {} : { details }),
  })
}

/** 非空字符串读取；不是字符串时返回 undefined。 */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 正整数读取（用于 topK）。 */
function readPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** 校验知识库名：非法名会让路径穿越到存储目录之外，属请求错误而非服务错误。 */
function rejectInvalidKbName(res: Response, kbName: string): boolean {
  if (isValidKbName(kbName)) return false
  failure(res, 400, 'INVALID_REQUEST', '知识库名非法（仅允许字母/数字/下划线/连字符，1-64 位）')
  return true
}

export function createKbRouter(service: Omit<KbService, 'router'>): Router {
  const router = Router()

  /** 统一把 async handler 的异常转成 500，避免 Express 4 上的未处理 rejection。 */
  function handle(
    handler: (req: Request, res: Response) => Promise<void>,
  ): (req: Request, res: Response) => void {
    return (req, res) => {
      handler(req, res).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error('[openmaic] KB 路由失败:', error)
        failure(res, 500, 'INTERNAL_ERROR', '知识库操作失败', message)
      })
    }
  }

  /** 存储不可用时直接 503，与其他插件的降级语义一致。 */
  function requireAvailable(res: Response): boolean {
    if (service.available) return true
    failure(res, 503, 'KB_UNAVAILABLE', '知识库存储不可用', '请检查 OPENTEACH_KB_DIR 指向的目录是否可写')
    return false
  }

  router.get(
    '/knowledge-bases',
    handle(async (_req, res) => {
      if (!requireAvailable(res)) return
      success(res, { data: { knowledgeBases: await service.listKnowledgeBases() } })
    }),
  )

  router.get(
    '/:kbName/documents',
    handle(async (req, res) => {
      if (!requireAvailable(res)) return
      if (rejectInvalidKbName(res, req.params.kbName)) return
      success(res, { data: { documents: await service.listDocuments(req.params.kbName) } })
    }),
  )

  router.delete(
    '/:kbName/documents/:documentId',
    handle(async (req, res) => {
      if (!requireAvailable(res)) return
      if (rejectInvalidKbName(res, req.params.kbName)) return
      const removed = await service.remove(req.params.kbName, req.params.documentId)
      if (!removed) {
        failure(res, 404, 'ASSET_NOT_FOUND', '文档不存在')
        return
      }
      success(res, { data: { removed } })
    }),
  )

  router.post(
    '/index',
    handle(async (req, res) => {
      if (!requireAvailable(res)) return
      const body = (req.body ?? {}) as Partial<KbIndexInput>
      const kbName = readString(body.kbName)
      const title = readString(body.title)
      const text = readString(body.text)
      if (kbName === undefined || title === undefined || text === undefined) {
        failure(res, 400, 'MISSING_REQUIRED_FIELD', '缺少必填字段：kbName / title / text')
        return
      }
      if (rejectInvalidKbName(res, kbName)) return
      const source = readString(body.source)
      const mimeType = readString(body.mimeType)
      const document = await service.index({
        kbName,
        title,
        text,
        ...(source === undefined ? {} : { source }),
        ...(mimeType === undefined ? {} : { mimeType }),
      })
      success(res, { data: { document } }, 201)
    }),
  )

  router.post(
    '/search',
    handle(async (req, res) => {
      if (!requireAvailable(res)) return
      const body = (req.body ?? {}) as Partial<KbSearchInput>
      const kbName = readString(body.kbName)
      const query = readString(body.query)
      if (kbName === undefined || query === undefined) {
        failure(res, 400, 'MISSING_REQUIRED_FIELD', '缺少必填字段：kbName / query')
        return
      }
      if (rejectInvalidKbName(res, kbName)) return
      const topK = readPositiveInt(body.topK)
      const result = await service.search({
        kbName,
        query,
        ...(topK === undefined ? {} : { topK }),
        ...(typeof body.smart === 'boolean' ? { smart: body.smart } : {}),
      })
      // 同时回传已格式化好的上下文字符串：调用方可直接把它作为 `externalContext`
      // 透传给 `POST /api/generate-classroom`，无需自行拼装。
      success(res, { data: { ...result, context: service.formatContext(result) } })
    }),
  )

  return router
}