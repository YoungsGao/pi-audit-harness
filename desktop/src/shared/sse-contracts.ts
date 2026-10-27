export const streamEvents = [
  'queued',
  'analyzing',
  'thoughts_execute',
  'tool_call_info',
  'completed',
  'failed',
  'timed_out',
  'stopped',
  'cancelled'
] as const
export type StreamEventName = (typeof streamEvents)[number]
export const streamEventSpec: Record<
  StreamEventName,
  { from: string[]; status: string; type: string }
> = {
  queued: { from: ['queue'], status: 'queue', type: 'process' },
  analyzing: { from: ['queue'], status: 'analyze', type: 'process' },
  thoughts_execute: { from: ['analyze'], status: 'analyze', type: 'thinking' },
  tool_call_info: { from: ['analyze'], status: 'analyze', type: 'process' },
  completed: { from: ['analyze'], status: 'completed', type: 'result' },
  failed: { from: ['analyze'], status: 'error', type: 'result' },
  timed_out: { from: ['analyze'], status: 'timeout', type: 'result' },
  stopped: { from: ['analyze'], status: 'stop', type: 'result' },
  cancelled: { from: ['analyze'], status: 'cancel', type: 'result' }
}
export interface AnalyzeRequest {
  projectId: string
  runId: string
  chainId: string
  modelConfigId: string
  sessionId?: string
  afterId?: number
}
export interface StreamFrame {
  event: StreamEventName
  id: number
  data: {
    projectId: string
    runId: string
    chainId: string
    sessionId: string
    attemptId: number
    type: 'thinking' | 'process' | 'result'
    status: 'queue' | 'analyze' | 'completed' | 'error' | 'timeout' | 'stop' | 'cancel'
    message: string | null
    summaryMissing: boolean
    details: unknown
  }
}
export const terminalEvents = new Set<StreamEventName>([
  'completed',
  'failed',
  'timed_out',
  'stopped',
  'cancelled'
])
export interface StreamHandle {
  connectionId: string
  sessionId: string
}
export interface AnalysisSessionSummary {
  sessionId: string
  attemptId: number
  modelConfigId: string
  state: StreamFrame['data']['status']
  minEventId: number
  createdAt: string
  finishedAt: string | null
}
export interface AnalysisHistory {
  projectId: string
  runId: string
  pathId: string
  sessions: AnalysisSessionSummary[]
  selectedSessionId: string | null
  frames: StreamFrame[]
  nextAfterId: number
  hasMore: boolean
  historyExpired: boolean
}
export type StreamNotice =
  | { connectionId: string; frame: StreamFrame }
  | { connectionId: string; ended: true }
  | { connectionId: string; errorCode: string }
export function validateAnalyze(value: unknown): AnalyzeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_ANALYZE')
  const v = value as Record<string, unknown>
  if (
    Object.keys(v).some(
      (k) => !['projectId', 'runId', 'chainId', 'modelConfigId', 'sessionId', 'afterId'].includes(k)
    ) ||
    !['projectId', 'runId', 'chainId', 'modelConfigId'].every(
      (k) => typeof v[k] === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v[k] as string)
    ) ||
    (v.sessionId !== undefined &&
      (typeof v.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(v.sessionId))) ||
    (v.afterId !== undefined && (!Number.isSafeInteger(v.afterId) || Number(v.afterId) < 0)) ||
    (!v.sessionId && v.afterId !== undefined && v.afterId !== 0)
  )
    throw new Error('INVALID_ANALYZE')
  return value as AnalyzeRequest
}
