import type { CallEdgeInput, CandidateGraph, GraphSaved } from './call-chain-contracts'

export type PathStatus = 'pending' | 'analyzing' | 'completed' | 'failed' | 'unresolved' | 'invalid'
export type Verdict = 'unknown' | 'safe' | 'dangerous'
export interface ScanWarning {
  code: string
  filePath: string | null
  message: string
}
export interface ScanSummary {
  state: 'ready' | 'partial' | 'empty' | 'failed'
  candidateCount: number
  unresolvedCalls: number
  truncated: boolean
  warnings: ScanWarning[]
}
export interface ScanRun extends Omit<ScanSummary, 'state'> {
  state: ScanSummary['state'] | 'scanning'
  errorCode: string | null
  projectId: string
  runId: string
  sourceStamp: string
  rulesVersion: string
  createdAt: string
  analysisStatus: string
  modelConfigId: string | null
}
export interface ScanStatistics {
  paths: number
  sinks: number
  edges: number
  dangerous: number
  safe: number
  unknown: number
  pending: number
  analyzing: number
  completed: number
  failed: number
  unresolved: number
  invalid: number
}
export interface PathSummary {
  pathId: string
  runId: string
  projectId: string
  pathHash: string
  sourceRef: string | null
  sinkEdgeUid: string | null
  ruleId: string | null
  status: PathStatus
  verdict: Verdict
  dangerous: number | null
  truncated: boolean
  truncationReason: string
  summary: string
  createdAt: string
  updatedAt: string
}
export interface PathDetail extends PathSummary {
  manualPoint?: import('./input-enhancements').ManualRiskPoint
  steps: {
    stepIndex: number
    edge: CallEdgeInput & { uid: string }
    dangerous: number | null
    taintIn: unknown[]
    taintOut: unknown[]
    evidence: unknown[]
    defenseSummary: string
    propagation: Record<string, unknown>
  }[]
}
export interface PathList {
  projectId: string
  runId: string
  sourceStamp: string
  rulesVersion: string
  total: number
  paths: PathSummary[]
}
export interface ScanCatalog {
  projectId: string
  runs: ScanRun[]
}
export interface PreparedScan extends GraphSaved, ScanSummary {
  sourceStamp: string
  rulesVersion: string
  scope: 'bounded-java-call-paths'
}
export interface ScanOutput {
  graph: CandidateGraph
  summary: ScanSummary
}
export type AuditAction =
  | 'stop'
  | 'recovery'
  | 'resume'
  | 'snapshot'
  | 'disclosure'
  | 'authorize'
  | 'manualRisk'
  | 'prepare'
  | 'runs'
  | 'list'
  | 'detail'
  | 'statistics'
  | 'analyze'
  | 'analyzePending'
  | 'events'
  | 'runState'
  | 'history'
export interface AnalysisAccepted {
  projectId: string
  runId: string
  pathId: string
  status: 'analyzing'
}
export type AuditData =
  | import('./run-contracts').RunRecoveryView
  | import('./input-enhancements').SnapshotInfo
  | import('./input-enhancements').DisclosureScope
  | (GraphSaved & { snapshotId: string })
  | PreparedScan
  | ScanCatalog
  | PathList
  | PathDetail
  | ScanStatistics
  | AnalysisAccepted
  | import('./agent-contracts').AnalysisEvents
  | import('./agent-contracts').RunState
  | import('./agent-contracts').QueueAccepted
  | import('./sse-contracts').AnalysisHistory
