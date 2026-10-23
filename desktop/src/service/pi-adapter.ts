import type {
  CreateAgentSessionOptions,
  CreateAgentSessionResult
} from '@earendil-works/pi-coding-agent'
import { ApiError } from '../shared/api-error.ts'
import { loadPiSdk } from './pi-sdk.ts'
export { loadPiSdk } from './pi-sdk.ts'
export { PiOperations } from './pi-operations.ts'
import type { RequestContext } from '../shared/service-protocol'

export type BackendPiOptions = Required<
  Pick<CreateAgentSessionOptions, 'cwd' | 'agentDir' | 'modelRuntime' | 'model' | 'resourceLoader'>
>

export interface PiPromptInput {
  context: RequestContext
  prompt: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface PiPromptResult extends RequestContext {
  reply: string
  latencyMs: number
}

// API-01 兼容入口；正式业务通过 PiOperations 使用共用运行时。
export async function runPiPrompt(
  options: BackendPiOptions,
  input: PiPromptInput
): Promise<PiPromptResult> {
  if (input.signal?.aborted) throw new ApiError('CANCELLED', '调用已取消', 409)
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
    throw new ApiError('INVALID_REQUEST', '提示词不能为空', 400)
  }
  const timeoutMs = input.timeoutMs ?? 15000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
    throw new ApiError('INVALID_REQUEST', '超时必须在 100～120000 毫秒之间', 400)
  }

  const startedAt = performance.now()
  let session: CreateAgentSessionResult['session'] | undefined
  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined

  try {
    const sdk = await loadPiSdk()
    const created = await sdk.createAgentSession({
      ...options,
      thinkingLevel: 'off',
      tools: [],
      noTools: 'all',
      sessionManager: sdk.SessionManager.inMemory(options.cwd),
      settingsManager: sdk.SettingsManager.inMemory({
        retry: { enabled: false },
        compaction: { enabled: false }
      })
    })
    session = created.session
    const activeSession = session
    let assistantFailed = false
    unsubscribe = activeSession.subscribe((event) => {
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        assistantFailed = ['error', 'aborted'].includes(event.message.stopReason)
      }
    })

    const interrupted = new Promise<never>((_, reject) => {
      const interrupt = (error: ApiError): void => {
        void activeSession.abort().catch(() => {})
        reject(error)
      }
      abortListener = () => interrupt(new ApiError('CANCELLED', '调用已取消', 409))
      input.signal?.addEventListener('abort', abortListener, { once: true })
      timer = setTimeout(
        () => interrupt(new ApiError('MODEL_TIMEOUT', '模型调用超时', 504, true)),
        timeoutMs
      )
    })
    if (input.signal?.aborted) abortListener?.()
    const prompting = input.signal?.aborted ? interrupted : activeSession.prompt(input.prompt)
    await Promise.race([prompting, interrupted])

    if (assistantFailed)
      throw new ApiError('PI_CALL_FAILED', 'Pi 调用失败，请检查模型配置和服务状态', 502)
    const reply = activeSession.getLastAssistantText()?.trim()
    if (!reply) throw new ApiError('EMPTY_REPLY', '模型没有返回有效文本', 502)
    return { ...input.context, reply, latencyMs: Math.round(performance.now() - startedAt) }
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('PI_CALL_FAILED', 'Pi 调用失败，请根据请求编号排查', 502)
  } finally {
    clearTimeout(timer)
    if (abortListener) input.signal?.removeEventListener('abort', abortListener)
    try {
      unsubscribe?.()
    } finally {
      session?.dispose()
    }
  }
}
