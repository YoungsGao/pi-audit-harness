import type { ScanStatistics } from './scan-contracts'
export interface AnalysisEvent {
  eventId: string
  projectId: string
  runId: string
  chainId: string | null
  seq: number
  time: string
  type: 'process' | 'model' | 'tool' | 'result'
  summary: string | null
  summaryMissing: boolean
  toolCallId: string | null
  toolName: string | null
  status: string
  durationMs: number | null
  payload: unknown
  truncated: boolean
}
export interface EventInput {
  type: AnalysisEvent['type']
  status: string
  summary?: string | null
  toolCallId?: string
  toolName?: string
  durationMs?: number
  payload?: unknown
  truncated?: boolean
  attemptId?: number
}
export interface AnalysisEvents {
  projectId: string
  runId: string
  pathId: string | null
  events: AnalysisEvent[]
  nextSeq: number
}
export interface QueueAccepted {
  projectId: string
  runId: string
  status: 'running'
  maxPaths: number
}
export interface RunState {
  projectId: string
  runId: string
  stage: string
  status: string
  sourceStamp: string
  rulesVersion: string
  modelConfigId: string | null
  startedAt: string | null
  finishedAt: string | null
  errorCode: string | null
  statistics: ScanStatistics
}
