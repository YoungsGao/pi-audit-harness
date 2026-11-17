export const evaluationActions = ['catalog', 'list', 'start', 'detail', 'stop'] as const
export type EvaluationAction = (typeof evaluationActions)[number]
export type EvaluationGroup = 'steps' | 'codegraph' | 'full'
export type EvaluationMode = 'engineering' | 'live'
export interface EvaluationRow {
  pathCount?: number
  pathHash?: string
  caseId: string
  group: EvaluationGroup
  trial: number
  sourceDigest: string
  expected: string
  verdict: string | null
  status: 'completed' | 'failed' | 'no-candidate'
  durationMs: number
  requests: number
  tools: number
  repairs: number
  reportedUsage: number
  uncertainUsage: number
  evidenceValid: boolean
  errorCode: string | null
  scanStatus: string | null
  gaps: string[]
  trace: { status: string; tool: string | null; summary: string | null }[]
}
export interface EvaluationJob {
  staticRulesDigest?: string
  limits?: Record<string, number>
  id: string
  mode: EvaluationMode
  state: 'running' | 'completed' | 'stopped' | 'failed' | 'interrupted'
  createdAt: string
  finishedAt: string | null
  corpusVersion: string
  rulesVersion: string
  promptVersion: string
  model: { id: string; modelId: string; revision: number; baseUrl: string } | null
  caseIds: string[]
  trials: number
  tokenBudget: number
  reportedUsage: number
  uncertainUsage: number
  reserved: number
  current: string
  errorCode: string | null
  rows: EvaluationRow[]
}
export interface EvaluationCatalog {
  cases: { id: string; title: string; category: string; expected: string }[]
  corpusVersion: string
}
export function evaluationMetrics(
  job: EvaluationJob,
  group: EvaluationGroup
): {
  total: number
  completed: number
  agreement: number | null
  falseSafe: number
  falseRisk: number
  unknown: number
  failed: number
  evidenceValid: number
  usage: number
  p50: number | null
  p95: number | null
} {
  const rows = job.rows.filter((r) => r.group === group),
    durations = rows.map((r) => r.durationMs).sort((a, b) => a - b)
  const percentile = (p: number): number | null =>
    durations.length ? durations[Math.max(0, Math.ceil(p * durations.length) - 1)] : null
  return {
    total: rows.length,
    completed: rows.filter((r) => r.status === 'completed').length,
    agreement:
      job.mode === 'live'
        ? rows.filter((r) => r.status === 'completed' && r.verdict === r.expected).length
        : null,
    falseSafe: rows.filter((r) => r.expected === 'dangerous' && r.verdict === 'safe').length,
    falseRisk: rows.filter((r) => r.expected === 'safe' && r.verdict === 'dangerous').length,
    unknown: rows.filter((r) => r.status === 'completed' && r.verdict === 'unknown').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    evidenceValid: rows.filter((r) => r.evidenceValid).length,
    usage: rows.reduce((n, r) => n + r.reportedUsage, 0),
    p50: percentile(0.5),
    p95: percentile(0.95)
  }
}
export function isEvaluationData(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    Array.isArray(v.cases) ||
    Array.isArray(v.jobs) ||
    (typeof v.id === 'string' && Array.isArray(v.rows) && typeof v.state === 'string')
  )
}
