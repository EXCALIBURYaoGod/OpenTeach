/**
 * http 插件：从 Cordis 服务容器读取依赖并装配 Express 应用。
 *
 * Cordis 原生范式：`inject: ['eduLlm', 'repo']`；`provide: 'app'`。路由逻辑保持与
 * 改造前一致，只是把依赖来源从手工 `AppContext` 改为 Cordis 注册的服务。
 * `/api/plugins` 诊断拓扑直接读取 `ctx.registry`（已加载插件）与 `ctx.reflect.store`
 * （已注册服务），不再依赖额外的 kernel 服务。
 *
 * @module http/plugin
 */

import type { Express } from 'express'
import type { Context } from '@deepseek-ai/cordis'
import type { AppContext } from '../context.js'
import type { AppMode } from '@openteach/shared'
import type { OpenmaicSlideService } from '@openteach/plugin-slide'
import type { OpenmaicCoreService } from '@openteach/plugin-openmaic-core'
import type { KbService } from '@openteach/plugin-kb'
import { createApp } from '../app.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 已装配的 Express 应用。 */
    app: Express
  }
}

export interface HttpPluginConfig {
  /** 运行模式；生产模式托管前端构建产物，开发模式仅提供 API。 */
  mode?: AppMode
  /** 生产模式下前端构建产物目录；缺省则不托管静态资源。 */
  webDist?: string
}

export const name = 'edu-loop:http'
export const inject = ['eduLlm', 'repo']
export const provide = 'app'

/** 已加载插件名（来自 Cordis 插件注册表）。 */
function listPlugins(ctx: Context): string[] {
  const names: string[] = []
  for (const runtime of ctx.registry.values()) {
    if (runtime.name) names.push(runtime.name)
  }
  return names
}

/** 已注册服务（来自 Cordis 反射层）；providedBy 取提供者 fiber 名。 */
function listServices(ctx: Context): Array<{ name: string; providedBy: string; available: boolean }> {
  const entries = new Map<string, { name: string; providedBy: string; available: boolean }>()
  for (const key of Object.getOwnPropertySymbols(ctx.reflect.store)) {
    const impl = ctx.reflect.store[key]
    if (impl === undefined) continue
    entries.set(impl.name, {
      name: impl.name,
      providedBy: impl.fiber.name,
      available: impl.value !== undefined && impl.value !== null,
    })
  }
  return [...entries.values()]
}

export function apply(ctx: Context, config: HttpPluginConfig = {}): void {
  const llm = ctx.get('eduLlm')!
  const repo = ctx.get('repo')!

  // 组装与原签名一致的 AppContext，路由层无需任何改动。
  const slide: OpenmaicSlideService | undefined = ctx.get('openmaic.slide')
  const classroom = ctx.get('openmaic.classroom')
  const storage = ctx.get('openmaic.storage')
  const openmaicCore: OpenmaicCoreService | undefined = ctx.get('openmaic.core')
  const kb: KbService | undefined = ctx.get('openmaic.kb')
  const appContext: AppContext = {
    runtime: llm.runtime,
    repo,
    llm,
    ...(slide === undefined ? {} : { slide }),
    ...(classroom === undefined ? {} : { classroom }),
    ...(storage === undefined ? {} : { storage }),
  }

  const app: Express = createApp(appContext, {
    ...(config.mode === undefined ? {} : { mode: config.mode }),
    ...(config.webDist === undefined ? {} : { webDist: config.webDist }),
    ...(openmaicCore === undefined ? {} : { openmaicCore: openmaicCore.handler }),
    ...(kb === undefined ? {} : { kb: kb.router }),
    plugins: {
      listPlugins: () => listPlugins(ctx),
      listServices: () => listServices(ctx),
    },
  })

  ctx.provide('app', app)
}
