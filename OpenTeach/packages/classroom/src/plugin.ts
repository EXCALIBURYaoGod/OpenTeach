/**
 * openmaic-classroom 插件：多智能体互动课堂的领域编排层。
 *
 * 定位（见方案架构图）：本插件是「OpenMAIC 课堂领域逻辑」的落点——Director 提示词、
 * 课堂工具语义、课堂动作、结构化解析。其下的编排内核由 DSH（DeepSeek Harness）
 * 承担：`ctx.agents`（AgentRegistry，由 `dsh-agent-loop` 实现工厂）创建 Director 与
 * 子智能体，`ctx.llm`（DSH `LlmRuntime`，经 `DshLlmAdapter` 桥接本项目 provider）
 * 作为模型出口。装配见 `./dsh-kernel.ts`。
 *
 * 命名契约：提供 `openmaic.classroom` 服务；`Context['openmaic.classroom']` 由本模块
 * 声明合并补充。与其它 openmaic 插件一致——能力可降级、不阻断闭环。
 *
 * 本文件当前为 Phase 2 编排层骨架：确立**课堂事件契约**与**会话事件存储**，
 * 暴露 `runSession()` / `getSessionEvents()`，使 HTTP 层（Phase 4 的
 * `GET /api/classroom/sessions/:id/events` + `Last-Event-ID` 续传）可先行对接。
 * Director 提示词与结构化解析（p2-5）、课堂工具集（p2-6）、多智能体协作（p2-7）
 * 将在后续填充 `runSession` 内部实现。
 *
 * @module plugins/openmaic-classroom/plugin
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { LoadedLlm } from '@openteach/plugin-llm/loader'
import { buildDirectorPrompt, buildUserPrompt, type DirectorPromptContext } from './prompts.js'
import { createChildDelegator } from './delegation.js'
import {
  createDirectorCompactionRuntime,
  resolveContextWindow,
  type DirectorCompactionRuntime,
  type DirectorCompactionTrace,
} from './compaction.js'
import {
  createClassroomAgentRegistry,
  createSqliteAgentRegistry,
  resolveClassroomAgents,
  type ClassroomAgentRegistry,
} from './registry.js'
import type { ClassroomEventRecord, ClassroomSessionRecord, Repository } from '@openteach/plugin-db/repo'
import {
  buildDirectorTools,
  createClassroomWhiteboardState,
  type ClassroomSceneSnapshot,
  type ClassroomToolRuntime,
  type DirectorSceneEvidencePacket,
} from './tools.js'
import type {
  AgentTurnSummary,
  ClassroomAgentConfig,
  ClassroomSessionType,
  WhiteboardActionRecord,
} from './types.js'

export type { ClassroomSessionType }

// ---------------------------------------------------------------------------
// 课堂事件契约（对齐 OpenMAIC `StatelessEvent` 的可接入子集）
// ---------------------------------------------------------------------------

/** 子智能体在事件流中的身份快照（前端据此渲染头像/颜色气泡）。 */
export interface ClassroomAgentRef {
  agentId: string
  agentName: string
  agentAvatar?: string
  agentColor?: string
}

/**
 * 课堂事件。
 *
 * 每条事件带 `sessionId` 与自增 `seq`，使 Phase 4 的 SSE tail 可直接用
 * `Last-Event-ID`（＝上次收到的 `seq`）做断点续传，无需依赖内存游标。
 */
export type ClassroomEvent =
  | {
      type: 'agent_start'
      data: ClassroomAgentRef & { messageId: string }
    }
  | { type: 'agent_end'; data: { messageId: string; agentId: string } }
  | { type: 'text_delta'; data: { content: string; messageId?: string } }
  | {
      type: 'action'
      data: {
        actionId: string
        actionName: string
        params: Record<string, unknown>
        agentId: string
        messageId?: string
      }
    }
  | { type: 'cue_user'; data: { fromAgentId?: string; prompt?: string } }
  | { type: 'done'; data: ClassroomSummary }
  | { type: 'error'; data: { message: string } }

/** 事件在存储/传输中的信封（事件本体 + 会话与序号）。 */
export type ClassroomEventEnvelope = ClassroomEvent & {
  /** 所属课堂会话。 */
  sessionId: string
  /** 会话内单调自增序号（从 1 开始），用作 SSE 的事件 id。 */
  seq: number
}

/** 会话结束摘要（对齐 OpenMAIC `done` 事件载荷的可接入子集）。 */
export interface ClassroomSummary {
  totalActions: number
  totalAgents: number
  agentHadContent?: boolean
  cueUserReceived?: boolean
  sessionClosed?: boolean
  endReason?: string
}

// ---------------------------------------------------------------------------
// 会话请求 / 元信息
// ---------------------------------------------------------------------------

/** 课堂会话类型见 `./types.ts` 的 {@link ClassroomSessionType}。 */

/** 发起一次课堂会话的输入。 */
export interface ClassroomSessionInput {
  /** 关联课程/课次（可选；用于取数与持久化）。 */
  courseId?: string
  lessonId?: string
  /** 关联的 dsl Stage id（场景容器）。 */
  stageId?: string
  /** 本轮场景快照（Phase 3 落库前由调用方透传）。 */
  scenes?: unknown[]
  /** 用户输入（提问/触发语）。 */
  message?: string
  /** 参与的智能体 id 列表（Director 从其中选择发言人）。 */
  agentIds: string[]
  sessionType?: ClassroomSessionType
  /** 讨论触发者（discussion 场景下的首位发言人）。 */
  triggerAgentId?: string
}

/** 运行选项。 */
export interface RunSessionOptions {
  /** 复用已有会话 id（续聊）；省略时新建。 */
  sessionId?: string
  /** 中断信号。 */
  signal?: AbortSignal
}

/** 会话元信息（供列表与诊断）。 */
export interface ClassroomSessionMeta {
  sessionId: string
  status: 'active' | 'completed' | 'error'
  input: ClassroomSessionInput
  createdAt: number
  updatedAt: number
  /** 已产生的最大序号。 */
  lastSeq: number
}

/** 对外暴露的课堂编排能力。 */
export interface OpenmaicClassroomService {
  /** DSH 编排内核（`ctx.agents`）是否可用；false 时走确定性降级路径。 */
  available: boolean
  /** 能力来源：'dsh' 为接入 DSH agent 内核，'fallback' 为内置降级。 */
  source: 'dsh' | 'fallback'
  /**
   * 运行一轮课堂会话，逐条产出课堂事件。
   *
   * 注：这是「一轮」——与 OpenMAIC `statelessGenerate` 对齐，客户端持
   * `directorState` 外部循环多次请求推进整堂课。
   */
  runSession(input: ClassroomSessionInput, options?: RunSessionOptions): AsyncIterable<ClassroomEventEnvelope>
  /** 读取某会话已产生的事件（`afterSeq` 之前的跳过，用于 SSE 续传）。 */
  getSessionEvents(sessionId: string, afterSeq?: number): ClassroomEventEnvelope[]
  /** Director 上下文压缩轨迹（诊断 / Phase 4 运维面板）。 */
  getCompactionTrace(): DirectorCompactionTrace
  /** 列出全部会话元信息。 */
  listSessions(): ClassroomSessionMeta[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 多智能体互动课堂编排服务。 */
    'openmaic.classroom': OpenmaicClassroomService
  }
}

// ---------------------------------------------------------------------------
// Director 循环辅助（模块级：不持有会话状态，状态经 runtime / 参数传入）
// ---------------------------------------------------------------------------

/** 把请求透传的场景快照归一化为工具层可用的 {@link ClassroomSceneSnapshot}。 */
function normalizeClassroomScenes(raw: unknown[] | undefined): ClassroomSceneSnapshot[] {
  if (!Array.isArray(raw)) return []
  const scenes: ClassroomSceneSnapshot[] = []
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') return
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.title !== 'string') return
    scenes.push({
      id: record.id,
      title: record.title,
      order: typeof record.order === 'number' ? record.order : index,
      type: typeof record.type === 'string' ? record.type : 'unknown',
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
      ...(Array.isArray(record.keyPoints)
        ? { keyPoints: record.keyPoints.filter((point): point is string => typeof point === 'string') }
        : {}),
      ...(record.content === undefined ? {} : { content: record.content }),
      ...(typeof record.updatedAt === 'string' || typeof record.updatedAt === 'number'
        ? { updatedAt: record.updatedAt }
        : {}),
    })
  })
  return scenes
}

/** 由本轮角色与场景推导 Director 提示词上下文。 */
function buildDirectorContext(
  agents: ClassroomAgentConfig[],
  scenes: ClassroomSceneSnapshot[],
  currentSceneId: string | null,
  input: ClassroomSessionInput,
): DirectorPromptContext {
  return {
    agents,
    scenes: scenes.map(scene => ({
      id: scene.id,
      order: scene.order,
      type: scene.type,
      title: scene.title,
    })),
    currentSceneId,
    whiteboardOpen: false,
    sessionType: input.sessionType ?? 'qa',
    ...(input.triggerAgentId ? { triggerAgentId: input.triggerAgentId } : {}),
  }
}

// ---------------------------------------------------------------------------
// Director 常驻会话（跨轮记忆）
// ---------------------------------------------------------------------------
//
// 同一课堂会话（classroom sessionId）只建一次 Director DSH 会话并让它跨轮存活，
// 上下文因此逐轮累积——这就是「课堂跨轮记忆」。为此需要四件事：
// 1. **串行化**：同 sessionId 的轮次经 Promise 链排队。DSH 对同一会话并发 `create`
//    会以 `session "...:director" already exists` 拒绝，而客户端切轮会 abort 上一轮
//    并立刻发下一轮，故必须由本层保证同会话同一时刻只有一轮在跑。
// 2. **逐轮刷新**：系统提示词（场景/角色/白板态）与工具集都随轮次变化，且工具闭包持有
//    本轮的守卫计数（连续空回合/总尝试次数），必须撤旧注册再按本轮重建。
// 3. **回收**：句柄不再随轮结束销毁，改由空闲 TTL / 常驻上限与插件停止统一释放。
// 4. **续接历史**：DSH 的 JSONL 持久化把会话落到 `<root>/<转义 id>/session.v3.jsonl.zstd`，
//    且其 `create` 会拒绝「磁盘上已有日志」的 id（错误文本与内存 store 的完全一致）。
//    所以 id 撞车不是异常而是常态：重启后，上一进程用过的课堂必然撞上自己的历史日志。
//    此时用 `ctx.agents.resume` 打开那份日志，课堂即跨重启续接上下文；仅当历史不可读
//    时才退回进程内唯一的后备 id 新建。

/** Director 常驻句柄（类型取自 DSH `ctx.agents.create` 的返回）。 */
type DirectorHandle = Awaited<ReturnType<Context['agents']['create']>>

/** 一个课堂会话的常驻 Director 槽位。 */
interface DirectorSlot {
  /**
   * 该槽位当前使用的 DSH 会话 id。正常即 `${classroomSessionId}:director`；
   * 若该 id 的历史日志无法 resume，则改为进程内唯一的后备 id（见 {@link runTurn}）。
   */
  sessionId: string
  /** 常驻句柄；创建失败时保持 undefined，由下一轮重试。 */
  handle?: DirectorHandle
  /** Director 智能体作用域上下文（逐轮重注册工具用）。 */
  agentCtx?: Context
  /** 本轮提示词上下文（section provider 在每次组装时读取）。 */
  promptRef: { current: DirectorPromptContext }
  /** 本轮工具注册的撤销句柄。 */
  toolDisposers: (() => void)[]
  /** 队尾 Promise：前一轮结束后放行下一轮。 */
  chain: Promise<void>
  /** 进行中/排队中的轮次数；>0 时不得回收。 */
  pending: number
  /** 最近一次转为空闲的时刻（TTL / LRU 回收依据）。 */
  idleAt: number
}

/** 空闲回收阈值：超过该时长未使用的 Director 会话被关闭。 */
const DIRECTOR_IDLE_TTL_MS = 30 * 60 * 1000
/** 常驻上限：超出的按最久未使用优先回收，防内存无界增长。 */
const DIRECTOR_MAX_SLOTS = 32
/** 回收扫描间隔。 */
const DIRECTOR_SWEEP_MS = 60 * 1000

/** 门闩（无依赖的 deferred）。 */
function createGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** 错误 → 单行文本（日志用）。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 判定 DSH 会话重名错误（`session "..." already exists`）。 */
function isSessionAlreadyExists(error: unknown): boolean {
  return /already exists/.test(describeError(error))
}

/** 后备会话 id 序号：仅在历史无法 resume 时递增。 */
let directorFallbackSeq = 0

/**
 * 本进程唯一标记（时间戳 + 随机）。DSH 的 JSONL 持久化会拒绝「磁盘上已有日志」的
 * session id，故后备 id 必须随进程变化：只用自增序号的话，第二次重启会再次选中同一个
 * 后缀，而它的日志已经落盘，后备重建同样会失败。
 */
const directorProcessNonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/** Director 常驻会话管理器（每个插件实例一份）。 */
interface DirectorSessions {
  /** 驱动一轮编排：同 sessionId 串行，且跨轮复用同一 DSH 会话。 */
  runTurn(
    runtime: ClassroomToolRuntime,
    directorContext: DirectorPromptContext,
    latestUserMessage: string | undefined,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<void>
  /** 关闭全部常驻会话并停止回收定时器。 */
  dispose(): Promise<void>
}

function createDirectorSessions(deps: {
  ctx: Context
  loaded: LoadedLlm
  compaction: DirectorCompactionRuntime
  maxAgentTurns: number
}): DirectorSessions {
  const slots = new Map<string, DirectorSlot>()

  /** 撤掉上一轮的工具注册，并按本轮运行态重新注册（工具闭包持有本轮队列与守卫计数）。 */
  function registerTools(slot: DirectorSlot, runtime: ClassroomToolRuntime): void {
    const agentCtx = slot.agentCtx
    if (agentCtx === undefined) return
    for (const dispose of slot.toolDisposers) {
      try {
        dispose()
      } catch (error) {
        console.warn(`[openmaic] director 工具撤注册失败（已忽略）：${describeError(error)}`)
      }
    }
    slot.toolDisposers = buildDirectorTools(runtime).map(tool => agentCtx.tools.register(tool))
  }

  /** 关闭并移出一个槽位（撤销工具注册 + 释放 DSH 会话）。 */
  async function closeSlot(key: string, slot: DirectorSlot): Promise<void> {
    if (slots.get(key) === slot) slots.delete(key)
    for (const dispose of slot.toolDisposers) {
      try {
        dispose()
      } catch {
        // 撤注册失败不影响后续释放。
      }
    }
    slot.toolDisposers = []
    slot.agentCtx = undefined
    const handle = slot.handle
    slot.handle = undefined
    try {
      await handle?.dispose()
    } catch (error) {
      console.warn(`[openmaic] director 会话释放失败（已忽略）：${describeError(error)}`)
    }
  }

  // 空闲/超限回收（unref：不因该定时器阻止进程退出）。
  const sweeper = setInterval(() => {
    const now = Date.now()
    const idle: [string, DirectorSlot][] = []
    for (const entry of slots) {
      if (entry[1].handle !== undefined && entry[1].pending === 0) idle.push(entry)
    }
    idle.sort((a, b) => a[1].idleAt - b[1].idleAt)
    const overflow = idle.length - DIRECTOR_MAX_SLOTS
    idle.forEach(([key, slot], index) => {
      if (index < overflow || now - slot.idleAt >= DIRECTOR_IDLE_TTL_MS) void closeSlot(key, slot)
    })
  }, DIRECTOR_SWEEP_MS)
  ;(sweeper as unknown as { unref?: () => void }).unref?.()

  async function runTurn(
    runtime: ClassroomToolRuntime,
    directorContext: DirectorPromptContext,
    latestUserMessage: string | undefined,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = `${sessionId}:director`
    // 同步建槽（其间无 await）：保证同 id 的并发轮次看到同一槽位。
    let slot = slots.get(key)
    if (slot === undefined) {
      slot = {
        sessionId: key,
        promptRef: { current: directorContext },
        toolDisposers: [],
        chain: Promise.resolve(),
        pending: 0,
        idleAt: Date.now(),
      }
      slots.set(key, slot)
    }
    const current = slot
    current.pending += 1
    // 入队：本轮排在前一轮之后（同一 DSH 会话不可并发驱动）。
    const previous = current.chain
    const gate = createGate()
    current.chain = gate.promise
    await previous

    // 本轮开始后收到取消（客户端切轮）：中止当前活动以收敛回 idle——会话记录保留，
    // 下一轮因此不必等本轮把 LLM 流跑完。
    const onAbort = (): void => {
      current.handle?.agent.cancel({ kind: 'user' })
    }
    try {
      // 已取消的排队轮次：直接放弃，会话保持存活供下一轮复用。
      if (signal?.aborted) return
      // 本轮上下文在本轮真正开始时写入（而非入队时），避免影响仍在跑的前一轮的组装。
      current.promptRef.current = directorContext
      signal?.addEventListener('abort', onAbort, { once: true })

      if (current.handle === undefined) {
        const agentOptions = { provider: deps.loaded.defaultProvider, model: deps.loaded.defaultModel }
        // create 与 resume 共用的作用域组装：resume 会重建一套全新的作用域世界，
        // 故续接历史后工具与提示词同样是本轮最新的。
        const setup = (agentCtx: Context): void => {
          current.agentCtx = agentCtx
          // 提示词以 provider 形式注册一次：每次组装都按「本轮」场景/角色/白板态求值，
          // 故跨轮复用同一会话时不会残留上一轮的课堂上下文。
          agentCtx.systemPrompt.section({
            name: 'classroom:director',
            order: 0,
            complete: true,
            text: () => buildDirectorPrompt(current.promptRef.current, deps.maxAgentTurns),
          })
          registerTools(current, runtime)
        }
        const createHandle = (id: string): Promise<DirectorHandle> =>
          deps.ctx.agents.create({ sessionId: SessionId(id), agentOptions, setup })
        /** 打开该 id 已落盘的历史日志并续接（create 会拒绝「磁盘上已有日志」的 id）。 */
        const resumeHandle = (id: string): Promise<DirectorHandle> =>
          deps.ctx.agents.resume({ resumeSessionId: SessionId(id), agentOptions, setup })
        try {
          current.handle = await createHandle(current.sessionId)
        } catch (error) {
          if (!isSessionAlreadyExists(error)) {
            if (current.handle === undefined && slots.get(key) === current) slots.delete(key)
            throw error
          }
          // 该 id 已被占用。这在本设计里是常态而非异常：DSH 的 JSONL 持久化会拒绝
          // 「磁盘上已有日志」的 session id，所以重启后，上一进程用过的课堂必然撞上
          // 自己的历史日志。首选 resume——把那份历史读回来，课堂即跨重启续接上下文。
          try {
            current.handle = await resumeHandle(current.sessionId)
            console.log(
              `[openmaic] director 会话 "${current.sessionId}" 已存在，改为 resume 续接历史上下文。`,
            )
          } catch (resumeError) {
            // 历史不可读（宿主未装配持久化服务 / 日志损坏等）：退回本进程唯一的后备 id 新建。
            // 后备 id 必须带进程标记：只用自增序号的话，第二次重启会再次选中同一个后缀，
            // 而它的日志已经落盘，届时后备重建同样会失败。
            directorFallbackSeq += 1
            const fallbackId = `${key}#r${directorProcessNonce}-${directorFallbackSeq.toString(36)}`
            console.warn(
              `[openmaic] director 会话 "${current.sessionId}" 无法 resume（${describeError(resumeError)}），`
              + `改用后备 id "${fallbackId}" 新建。`,
            )
            current.sessionId = fallbackId
            try {
              current.handle = await createHandle(fallbackId)
            } catch (retryError) {
              // 后备新建也失败：仍不留空槽，下一轮重新尝试。
              if (current.handle === undefined && slots.get(key) === current) slots.delete(key)
              throw retryError
            }
          }
        }
      } else {
        // 复用常驻会话：只刷新本轮工具集（提示词由 provider 在每次组装时求值）。
        registerTools(current, runtime)
      }

      const handle = current.handle
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: buildUserPrompt(latestUserMessage) }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
      // 上下文压缩：安全边界＝本步已空闲、会话无打开 turn。按 DSH/provider 的 contextWindow
      // 判定；超阈值时用一段课堂取向的摘要替换较早的 surface 节点，控制下一轮请求体量。
      // 会话现在跨轮存活，压缩同时承担「让长课堂的记忆有界」的职责。
      // 压缩是机会性优化：它失败不能把已经跑完的一轮课堂判为出错（否则整轮只剩 error 帧）。
      try {
        const compacted = await deps.compaction.compactSession(handle.agent.session, signal)
        if (compacted) {
          console.log(
            `[openmaic] director 上下文压缩：${compacted.messagesBefore}→${compacted.messagesAfter} 条消息，` +
              `${compacted.tokensBefore}→${compacted.tokensAfter} tokens`,
          )
        }
      } catch (error) {
        console.warn(
          `[openmaic] director 上下文压缩失败（已忽略，不影响本轮）：${describeError(error)}`,
        )
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      current.pending -= 1
      current.idleAt = Date.now()
      gate.resolve()
    }
  }

  async function dispose(): Promise<void> {
    clearInterval(sweeper)
    await Promise.all([...slots].map(([key, slot]) => closeSlot(key, slot)))
  }

  return { runTurn, dispose }
}

/** 降级路径：无内核或 Mock 未产生任何发言时，产出确定性教师发言，保证课堂可渲染。 */
async function emitFallbackAgentTurn(
  runtime: ClassroomToolRuntime,
  agents: ClassroomAgentConfig[],
  sessionId: string,
): Promise<void> {
  const speaker = agents.find(agent => agent.role === 'teacher') ?? agents[0]
  if (!speaker) return
  const messageId = `${sessionId}:fallback`
  await runtime.send({
    type: 'agent_start',
    data: {
      messageId,
      agentId: speaker.id,
      agentName: speaker.name,
      agentAvatar: speaker.avatar,
      agentColor: speaker.color,
    },
  })
  const preview = `（本地降级模式）${speaker.name} 已就绪：配置模型凭据后即可开启多智能体互动课堂。`
  await runtime.send({ type: 'text_delta', data: { content: preview, messageId } })
  await runtime.send({ type: 'agent_end', data: { messageId, agentId: speaker.id } })
  runtime.onAgentTurn({
    agentId: speaker.id,
    agentName: speaker.name,
    contentPreview: preview,
    actionCount: 0,
    whiteboardActions: [],
  })
}

/** 库内事件行 → 事件信封（用于以 SQLite 为源的读取路径）。 */
function mapEventRecord(record: ClassroomEventRecord): ClassroomEventEnvelope {
  return {
    type: record.type,
    data: record.data,
    sessionId: record.sessionId,
    seq: record.seq,
  } as ClassroomEventEnvelope
}

/** 库内会话行 → 会话元信息。 */
function mapSessionRecord(record: ClassroomSessionRecord): ClassroomSessionMeta {
  return {
    sessionId: record.id,
    status: record.status as ClassroomSessionMeta['status'],
    input: record.input as ClassroomSessionInput,
    createdAt: Date.parse(record.createdAt),
    updatedAt: Date.parse(record.updatedAt),
    lastSeq: record.lastSeq,
  }
}

// ---------------------------------------------------------------------------
// 插件（Cordis 原生：命名导出 name / inject / provide / Config / apply）
// ---------------------------------------------------------------------------

export interface ClassroomConfig {
  /** 未显式传 agentIds 时的默认参与角色。 */
  defaultAgentIds?: string[]
  /** 单轮会话允许的最大子智能体发言轮数（对齐 OpenMAIC piMaxAgentTurns）。 */
  maxAgentTurns?: number
  /** 单个子智能体每轮允许的最大动作数（对齐 piMaxActionsPerAgent）。 */
  maxActionsPerAgent?: number
  /** 是否允许子智能体使用白板类动作（对齐 OpenMAIC `enableWhiteboardTools`）。 */
  enableWhiteboardTools?: boolean
}

export const name = 'openmaic:classroom'
/**
 * 依赖：`eduLlm`（本项目 provider 运行时，用于解析降级态）、`llm`（DSH LlmRuntime
 * 编排内核，由 dsh-kernel 装配）、`agents`（DSH AgentRegistry）。后两者在
 * `dsh-kernel` 之后加载即已就绪。
 */
export const inject = ['eduLlm', 'llm', 'agents']
export const provide = 'openmaic.classroom'

export const Config = z.object({
  defaultAgentIds: z.array(z.string()),
  maxAgentTurns: z.number(),
  maxActionsPerAgent: z.number(),
  enableWhiteboardTools: z.boolean(),
})

export function apply(ctx: Context, config: ClassroomConfig = {}): () => void {
  const loaded = ctx.get('eduLlm')! as LoadedLlm
  // DSH 编排内核由 dsh-kernel 装配；inject 保证进入 apply 时已就绪。
  const hasDshKernel = ctx.get('agents') !== undefined && ctx.get('llm') !== undefined
  const source: OpenmaicClassroomService['source'] = hasDshKernel ? 'dsh' : 'fallback'

  const maxAgentTurns = config.maxAgentTurns ?? 6
  const maxActionsPerAgent = config.maxActionsPerAgent ?? 8

  // -------------------------------------------------------------------------
  // 会话与事件存储（内存为运行时权威源；repo 可用时同步落库，可降级）
  // -------------------------------------------------------------------------
  const repo = ctx.get('repo')
  const events = new Map<string, ClassroomEventEnvelope[]>()
  const sessions = new Map<string, ClassroomSessionMeta>()

  const toIso = (ms: number): string => new Date(ms).toISOString()

  /** 尽力把写操作同步到 SQLite；失败仅告警一次并继续走内存（不阻断课堂）。 */
  let persistWarned = false
  function tryPersist(label: string, action: (repo: Repository) => void): void {
    if (!repo) return
    try {
      action(repo)
    } catch (error) {
      if (!persistWarned) {
        persistWarned = true
        console.warn(
          `[openmaic] classroom ${label} 落库失败，后续回退内存：` +
            (error instanceof Error ? error.message : String(error)),
        )
      }
    }
  }

  let sessionSeq = 0
  const newSessionId = (): string => `cls-${Date.now().toString(36)}-${(++sessionSeq).toString(36)}`

  /** 写入并返回一条带信封的事件（同时落库 classroom_events / whiteboard_elements）。 */
  function record(sessionId: string, event: ClassroomEvent): ClassroomEventEnvelope {
    const meta = sessions.get(sessionId)
    const seq = (meta?.lastSeq ?? 0) + 1
    const envelope = { ...event, sessionId, seq } as ClassroomEventEnvelope
    const list = events.get(sessionId) ?? []
    list.push(envelope)
    events.set(sessionId, list)
    if (meta) {
      meta.lastSeq = seq
      meta.updatedAt = Date.now()
    }
    const createdAt = toIso(Date.now())
    const courseId = meta?.input.courseId ?? null
    tryPersist('事件', (r) => {
      r.appendClassroomEvent({ sessionId, seq, type: event.type, data: event.data, createdAt })
      if (event.type === 'action') {
        const { actionId, actionName, params, agentId } = event.data
        r.appendWhiteboardElements([
          {
            id: actionId,
            sessionId,
            seq,
            courseId,
            sceneId: null,
            actionName,
            agentId,
            agentName: registry.get(agentId)?.name ?? '',
            params,
            createdAt,
          },
        ])
      }
    })
    return envelope
  }

  function upsertMeta(sessionId: string, input: ClassroomSessionInput): ClassroomSessionMeta {
    const existing = sessions.get(sessionId)
    if (existing) return existing
    const now = Date.now()
    const meta: ClassroomSessionMeta = {
      sessionId,
      status: 'active',
      input,
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
    }
    sessions.set(sessionId, meta)
    tryPersist('会话', (r) => {
      r.upsertClassroomSession({
        id: sessionId,
        courseId: input.courseId ?? null,
        lessonId: input.lessonId ?? null,
        stageId: input.stageId ?? null,
        sessionType: input.sessionType ?? 'qa',
        status: 'active',
        input,
        lastSeq: 0,
        createdAt: toIso(now),
        updatedAt: toIso(now),
      })
    })
    return meta
  }

  // -------------------------------------------------------------------------
  // 角色注册表（repo 可用时用 SQLite `agents` 表；否则内存版，接口一致）
  // -------------------------------------------------------------------------
  const registry: ClassroomAgentRegistry = repo
    ? createSqliteAgentRegistry(repo)
    : createClassroomAgentRegistry()

  // -------------------------------------------------------------------------
  // Director 上下文压缩（接 provider/model 的 contextWindow）
  // -------------------------------------------------------------------------
  const compactionContextWindow = resolveContextWindow(loaded)
  const compaction = createDirectorCompactionRuntime({
    loaded,
    ...(compactionContextWindow === undefined ? {} : { contextWindow: compactionContextWindow }),
  })

  // Director 常驻会话：跨轮复用同一 DSH 会话（课堂跨轮记忆），同 sessionId 串行，
  // 并按空闲 TTL / 常驻上限回收。
  const directors = createDirectorSessions({ ctx, loaded, compaction, maxAgentTurns })

  // -------------------------------------------------------------------------
  // runSession：真实 Director 循环
  // -------------------------------------------------------------------------
  /**
   * 运行一轮课堂会话：
   * 1. 组装本轮角色/场景/白板运行态，构造 {@link ClassroomToolRuntime}；
   * 2. 经 DSH `ctx.agents` 建 Director 智能体，注册 `read_scene/call_agent/cue_user/
   *    close_session` 工具；
   * 3. Director 调用 `call_agent` → 经 `delegateAgent` 委派子智能体，流式产出文本与动作；
   * 4. 以唯一终态收束（`cue_user` / `close_session`），产出 `done`。
   *
   * 事件由工具执行与子智能体会话监听回调写入队列，本生成器并发排出并逐条 `yield`
   * 给上层（Phase 4 的 SSE 层据此分帧下发）。
   */
  async function* runSession(
    input: ClassroomSessionInput,
    options: RunSessionOptions = {},
  ): AsyncGenerator<ClassroomEventEnvelope> {
    const sessionId = options.sessionId ?? newSessionId()
    upsertMeta(sessionId, input)

    // 事件队列：send 由（异步的）工具执行与子智能体会话回调调用。
    const queue: ClassroomEventEnvelope[] = []
    let wake: (() => void) | null = null
    const send = (event: ClassroomEvent): void => {
      const envelope = record(sessionId, event)
      if (event.type === 'done') {
        const meta = sessions.get(sessionId)
        if (meta) {
          meta.status = 'completed'
          tryPersist('会话状态', (r) => {
            r.updateClassroomSessionState(sessionId, 'completed', meta.lastSeq, toIso(meta.updatedAt))
          })
        }
      }
      queue.push(envelope)
      if (wake) {
        const notify = wake
        wake = null
        notify()
      }
    }

    const agentConfigs = resolveClassroomAgents(
      registry,
      input.agentIds,
      config.defaultAgentIds ?? [],
    )
    const scenes = normalizeClassroomScenes(input.scenes)
    const currentSceneId = scenes[0]?.id ?? null

    const agentResponses: AgentTurnSummary[] = []
    const whiteboardLedger: WhiteboardActionRecord[] = []
    let pendingEvidence: DirectorSceneEvidencePacket | undefined
    let userCued = false
    let sessionClosed = false
    let endReason: string | undefined

    const runtime: ClassroomToolRuntime = {
      send,
      agentConfigs,
      scenes,
      currentSceneId,
      maxAgentTurns,
      maxActionsPerAgent,
      enableWhiteboardTools: config.enableWhiteboardTools ?? true,
      whiteboard: createClassroomWhiteboardState(),
      getAgentResponses: () => agentResponses,
      getWhiteboardLedger: () => whiteboardLedger,
      onAgentTurn: (summary) => {
        agentResponses.push(summary)
      },
      onAction: (actionRecord) => {
        if (actionRecord) whiteboardLedger.push(actionRecord)
      },
      recordSceneEvidence: (packet) => {
        pendingEvidence = packet
      },
      takeSceneEvidence: () => {
        const packet = pendingEvidence
        pendingEvidence = undefined
        return packet
      },
      cueUser: async (data) => {
        if (userCued || sessionClosed) return false
        userCued = true
        await send({ type: 'cue_user', data: { fromAgentId: data.fromAgentId, prompt: data.prompt } })
        return true
      },
      closeSession: async (data) => {
        if (userCued || sessionClosed) return false
        sessionClosed = true
        endReason = data.endReason
        return true
      },
      isUserCued: () => userCued,
      isSessionClosed: () => sessionClosed,
    }
    runtime.delegateAgent = createChildDelegator({ ctx, loaded, getRuntime: () => runtime })

    // 真实编排仅在内核可用时启用；否则直接走确定性降级。
    const useDirector = source === 'dsh'

    // 整轮编排（Director + 收束）作为一个异步任务；生成器并发排出其产生的事件。
    let finished = false
    const turnTask = (async () => {
      if (useDirector) {
        try {
          await directors.runTurn(
            runtime,
            buildDirectorContext(agentConfigs, scenes, currentSceneId, input),
            input.message,
            sessionId,
            options.signal,
          )
        } catch (error) {
          send({
            type: 'error',
            data: { message: error instanceof Error ? error.message : String(error) },
          })
        }
      }
      // 降级兜底：Mock/无 Key 场景下 Director 无从真实编排（无法产出子智能体发言），
      // 产出确定性教师发言，保证课堂在无凭据时仍可渲染。
      // 本轮已被取消（客户端切轮）时不补发言与收束：这不是「模型没说话」而是本轮作废，
      // 补出来的假发言会污染会话事件（断线续传时会显示）。
      if (options.signal?.aborted !== true) {
        if (agentResponses.length === 0) {
          await emitFallbackAgentTurn(runtime, agentConfigs, sessionId)
        }
        if (!userCued && !sessionClosed) {
          await runtime.cueUser({})
        }
      }
    })()
    const markFinished = (): void => {
      finished = true
      if (wake) {
        const notify = wake
        wake = null
        notify()
      }
    }
    turnTask.then(markFinished, markFinished)

    while (!finished || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        continue
      }
      yield queue.shift()!
    }

    const totalActions = agentResponses.reduce((sum, item) => sum + item.actionCount, 0)
    send({
      type: 'done',
      data: {
        totalActions,
        totalAgents: new Set(agentResponses.map(item => item.agentId)).size,
        agentHadContent: agentResponses.some(item => item.contentPreview.trim().length > 0),
        cueUserReceived: userCued,
        sessionClosed,
        endReason: endReason ?? (sessionClosed ? 'close_session' : 'cue_user'),
      },
    })
    while (queue.length > 0) yield queue.shift()!
  }

  const service: OpenmaicClassroomService = {
    available: source === 'dsh',
    source,
    runSession,
    getSessionEvents(sessionId, afterSeq = 0) {
      // 内存为权威源；未命中（如进程重启后）再回退到 SQLite 事件流。
      const inMemory = events.get(sessionId)
      if (inMemory) return inMemory.filter(e => e.seq > afterSeq)
      return repo ? repo.listClassroomEvents(sessionId, afterSeq).map(mapEventRecord) : []
    },
    getCompactionTrace() {
      return compaction.getTrace()
    },
    listSessions() {
      if (sessions.size > 0 || !repo) return [...sessions.values()]
      return repo.listClassroomSessions().map(mapSessionRecord)
    },
  }

  ctx.provide('openmaic.classroom', service)

  if (source === 'fallback') {
    console.warn('[openmaic] classroom 未探测到 DSH 编排内核（ctx.agents/ctx.llm），降级为骨架占位实现。')
  } else {
    console.log(`[openmaic] classroom 编排层已接入 DSH 内核（defaultProvider=${loaded.defaultProvider}）`)
  }

  return async () => {
    // 常驻 Director 会话随插件停止一并释放（含回收定时器）。必须 await：
    // 若放任其异步释放，重新加载后的同名 create 会与尚未释放的残留会话撞车。
    await directors.dispose()
    events.clear()
    sessions.clear()
    console.log(`[openmaic] classroom 插件停止（source=${service.source}）`)
  }
}

/** 便捷读取（可能降级，调用方需看 available）。 */
export function useOpenmaicClassroom(ctx: Context): OpenmaicClassroomService {
  return ctx.get('openmaic.classroom')!
}