/**
 * 子智能体委派运行器（`call_agent` 的实际执行体）。
 *
 * 移植自 OpenMAIC `lib/chat/pi/tools/call-agent.ts` 的 **legacy（结构化输出）** 路径：
 * 子智能体被要求只返回一个「文本与动作交织」的 JSON 数组，本模块在**流式**过程中用
 * {@link parseStructuredChunk} 增量解析——文本即时转成 `text_delta` 事件，动作经
 * {@link executeClassroomAction} 派发为 `action` 事件。
 *
 * 与原实现的架构差异（必要适配，非语义简化）：
 * - OpenMAIC 用 pi-agent-core 的 `buildAgent` 建子智能体、订阅其 `message_update` 事件
 *   拿文本增量；本项目改用 DSH `ctx.agents.create({ meta:{ origin:'subagent' } })`
 *   建子智能体（自建 lead/teammate 路径，因 `dsh-experimental-agent-team` 不可用），
 *   并订阅 DSH **agent 作用域**的 `agent/assistant-stream` 事件获取 `text-delta` 分片
 *   （`chunk` 帧的 `frame.chunk` 即 `StreamChunk`）。该事件按 scope 过滤派发，
 *   注册在子智能体自己的 `agentCtx` 上即只收本子智能体的增量。
 * - 子智能体**不注册原生动作工具**（与 OpenMAIC legacy 路径一致：`tools: []`），
 *   动作由结构化解析结果驱动 {@link executeClassroomAction} 执行；`buildChildActionTools`
 *   仅用于推导「本回合可用动作集」以生成提示词。
 * - 子智能体系统提示词经 DSH `systemPrompt.section({ complete: true })` 注入。
 *
 * @module plugins/openmaic-classroom/delegation
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

import type { LoadedLlm } from '@openteach/plugin-llm/loader'
import {
  buildChildPrompt,
  buildChildTurnPrompt,
  sanitizeVisibleSpeech,
  type ChildPromptContext,
  type ClassroomSceneRef,
} from './prompts.js'
import {
  createParserState,
  finalizeParser,
  parseStructuredChunk,
  type ParseResult,
} from './structured-output.js'
import {
  buildChildActionTools,
  executeClassroomAction,
  type ClassroomActionContext,
  type ClassroomToolRuntime,
  type DelegateAgentInput,
} from './tools.js'
import {
  getActionsForRole,
  type AgentTurnSummary,
  type WhiteboardActionRecord,
} from './types.js'

/** 委派运行器依赖。 */
export interface ChildDelegatorDeps {
  /** 用于 `ctx.agents.create` 的上下文（其 fiber 决定子智能体归属）。 */
  ctx: Context
  /** 提供默认 provider / model 路由。 */
  loaded: LoadedLlm
  /** 取得当前会话的工具运行上下文（延迟读取，避免构造顺序上的循环依赖）。 */
  getRuntime: () => ClassroomToolRuntime
}

/** 子智能体一轮委派的执行函数（即 `ClassroomToolRuntime.delegateAgent`）。 */
export type ChildDelegator = (input: DelegateAgentInput) => Promise<AgentTurnSummary>

/** 由工具运行上下文推导子智能体提示词上下文（精简版，Phase 3 可据落库数据充实）。 */
function buildChildPromptContext(runtime: ClassroomToolRuntime): ChildPromptContext {
  const scenes: ClassroomSceneRef[] = runtime.scenes.map(scene => ({
    id: scene.id,
    order: scene.order,
    type: scene.type,
    title: scene.title,
  }))
  const responses = runtime.getAgentResponses()
  return {
    scenes,
    currentSceneId: runtime.currentSceneId ?? null,
    whiteboardOpen: runtime.whiteboard.open,
    directorState: {
      turnCount: responses.length,
      agentResponses: responses,
      whiteboardLedger: runtime.getWhiteboardLedger?.() ?? [],
    },
  }
}

/**
 * 创建子智能体委派运行器。
 *
 * 返回的函数实现 `ClassroomToolRuntime.delegateAgent`：建子智能体 → 流式结构化解析
 * → 归一为 {@link AgentTurnSummary}。
 */
export function createChildDelegator(deps: ChildDelegatorDeps): ChildDelegator {
  let childSeq = 0

  return async function delegate(input: DelegateAgentInput): Promise<AgentTurnSummary> {
    const runtime = deps.getRuntime()
    const { agent, instruction, sceneEvidence, messageId } = input

    // 本回合动作上下文：预算与可用动作集（allowlist 与 OpenMAIC buildChildActionTools 一致）。
    const availableActions = agent.allowedActions.length > 0
      ? agent.allowedActions
      : getActionsForRole(agent.role)
    const actionCtx: ClassroomActionContext = {
      runtime,
      agent,
      messageId,
      actionBudget: { used: 0, max: runtime.maxActionsPerAgent },
    }
    const allowedActionNames = new Set(buildChildActionTools(actionCtx).map(tool => tool.name))
    // 提示词里的可用动作描述应与 allowlist 一致（allowlist 之外的描述会诱导无效动作）。
    const promptActions = availableActions.filter(name => allowedActionNames.has(name))

    const systemPrompt = buildChildPrompt(buildChildPromptContext(runtime), agent, promptActions)
    const turnPrompt = buildChildTurnPrompt(
      instruction,
      agent.role,
      sceneEvidence ? { scene: sceneEvidence } : {},
    )

    // 结构化解析与动作派发（流式）：文本增量即时发文本事件，动作即时派发。
    const parserState = createParserState()
    let text = ''
    let actionCount = 0
    const whiteboardActions: WhiteboardActionRecord[] = []
    const childSessionId = SessionId(`${messageId}:child-${++childSeq}`)

    // 串行化异步发事件，保证事件顺序与解析顺序一致（DSH 的会话监听器是同步的）。
    let chain: Promise<void> = Promise.resolve()
    const enqueue = (task: () => Promise<void>): void => {
      chain = chain.then(task, task)
    }

    async function processResult(result: ParseResult): Promise<void> {
      for (const entry of result.ordered) {
        if (entry.type === 'text') {
          const content = result.textChunks[entry.index]
          if (!content) continue
          const visible = sanitizeVisibleSpeech(content)
          if (!visible) continue
          text += visible
          await runtime.send({ type: 'text_delta', data: { content: visible, messageId } })
          continue
        }
        const action = result.actions[entry.index]
        if (!action) continue
        // 未知/未授权动作：静默跳过（不泄漏到可见语音）。
        if (!allowedActionNames.has(action.actionName)) continue
        const actionResult = await executeClassroomAction(action.actionName, action.params, actionCtx)
        if (actionResult.skipped) continue
        actionCount += 1
        if (action.actionName.startsWith('wb_') && actionResult.params) {
          whiteboardActions.push({
            actionName: action.actionName,
            agentId: agent.id,
            agentName: agent.name,
            params: actionResult.params,
          })
        }
      }
    }

    const handle = await deps.ctx.agents.create({
      sessionId: childSessionId,
      meta: { origin: 'subagent', delegationDepth: 1 },
      agentOptions: { provider: deps.loaded.defaultProvider, model: deps.loaded.defaultModel },
      setup: (agentCtx) => {
        // 子智能体系统提示词＝整段课堂提示词（complete 使其成为唯一 section）。
        agentCtx.systemPrompt.section({
          name: 'classroom:child',
          order: 0,
          text: systemPrompt,
          complete: true,
        })
        // agent 作用域监听：DSH 按 scope 过滤派发，本子智能体的流式帧只到这里。
        agentCtx.on('agent/assistant-stream', ({ frame }) => {
          if (frame.type !== 'chunk') return
          const chunk = frame.chunk
          if (chunk.type !== 'text-delta') return
          const result = parseStructuredChunk(chunk.text, parserState)
          enqueue(() => processResult(result))
        })
      },
    })

    try {
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: turnPrompt }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
      // 流结束后收尾：冲刷解析器尚能恢复的部分（含残渣抑制）。
      const finalResult = finalizeParser(parserState)
      enqueue(() => processResult(finalResult))
      await chain
    } finally {
      await handle.dispose()
    }

    return {
      agentId: agent.id,
      agentName: agent.name,
      contentPreview: text.trim().slice(0, 300),
      actionCount,
      whiteboardActions,
    }
  }
}