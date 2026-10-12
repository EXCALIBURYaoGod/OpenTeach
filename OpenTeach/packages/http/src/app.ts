/**
 * Express 应用装配。
 *
 * @module app
 */

import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import cors from 'cors'
import express, { type Express, type RequestHandler } from 'express'
import type { AppContext } from './context.js'
import type { AppMode } from '@openteach/shared'
import { createLlmRouter } from './http/routes/llm.js'
import { createAgentsRouter, createClassroomRouter } from './http/routes/classroom.js'

export interface AppOptions {
  /** 运行模式；生产模式下前端由本服务单端口托管，开发模式下前端独立跑在 vite。 */
  mode?: AppMode
  /** 生产模式下前端构建产物目录。 */
  webDist?: string
  /** 插件诊断拓扑（可选）：用于暴露 /api/plugins。 */
  plugins?: {
    listPlugins(): string[]
    listServices(): Array<{ name: string; providedBy?: string; available: boolean }>
  }
  /**
   * OpenMAIC 核心 API 处理器（可选）。由 `openmaic:core` 插件提供。
   *
   * 必须挂在 `express.json()` **之前**：它按原始请求流读取请求体（OpenMAIC 的
   * route handler 依赖 `request.json()` / `formData()` / `request.body` 三种形态），
   * 一旦上游解析过 JSON，流即被消费，`/api/persistence` 等路由会读到空体。
   */
  openmaicCore?: NodeMiddleware
  /**
   * 知识库（KB）子路由（可选）。由 `openmaic:kb` 插件提供，挂在 `/api/kb` 之下。
   *
   * 与 `openmaicCore` 相反，它挂在 `express.json()` **之后**：KB 路由是普通
   * Express Router，直接读已解析的 `req.body`。但必须早于下方 `/api` 的 501
   * 兜底——`app.use` 是追加语义，晚挂的中间件永远不会被命中。
   */
  kb?: RequestHandler
}

/** Express 可直接 `app.use()` 的 Node 风格中间件。 */
export type NodeMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void

export function createApp(context: AppContext, options: AppOptions = {}): Express {
  const mode = options.mode ?? 'development'
  const app = express()
  // 开发模式前端跑在 5173，需放开跨域；生产为同源单端口，无须 CORS。
  if (mode === 'development') app.use(cors())

  // OpenMAIC 核心 API：必须在 body 解析之前接管命中的路由（未命中则透传）。
  if (options.openmaicCore !== undefined) {
    app.use(options.openmaicCore as unknown as RequestHandler)
  }

  app.use(express.json({ limit: '2mb' }))

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      mode,
      defaultProvider: context.llm.defaultProvider,
      defaultModel: context.llm.defaultModel,
      providers: context.runtime.listProviders(),
      time: new Date().toISOString(),
    })
  })

  // 插件/服务诊断拓扑（在 /api 404 兜底之前挂载）。
  if (options.plugins !== undefined) {
    app.get('/api/plugins', (_req, res) => {
      res.json({ plugins: options.plugins!.listPlugins(), services: options.plugins!.listServices() })
    })
  }

  app.use('/api/llm', createLlmRouter(context))
  // 互动课堂：课堂编排（SSE）+ 角色 CRUD。
  app.use('/api/classroom', createClassroomRouter(context))
  app.use('/api/agents', createAgentsRouter(context))

  // 知识库：普通 Express 路由，依赖已解析的 JSON body，且必须早于 /api 501 兜底。
  if (options.kb !== undefined) {
    app.use('/api/kb', options.kb)
  }

  // 未实现的 OpenMAIC 能力域：统一 501，前端据此屏蔽对应入口（不再返回笼统 404）。
  app.use('/api', (_req, res) => {
    res.status(501).json({
      success: false,
      errorCode: 'NOT_IMPLEMENTED',
      error: '该接口尚未由 OpenTeach 后端实现',
    })
  })

  // 生产模式：若前端已构建，直接由后端托管静态资源（单端口即可访问）。
  const webDist = options.webDist
  if (webDist !== undefined && existsSync(join(webDist, 'index.html'))) {
    app.use(express.static(webDist))
    app.get('*', (_req, res) => {
      res.sendFile(join(webDist, 'index.html'))
    })
  }

  return app
}