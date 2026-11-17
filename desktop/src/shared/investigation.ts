export interface InvestigationStep {
  stepIndex: number
  read: 'pending' | 'complete' | 'partial'
  related: number
  relatedRead: number
  graph: 'pending' | 'ok' | 'partial' | 'unavailable' | 'failed'
  scan: 'pending' | 'ok' | 'partial' | 'unavailable' | 'failed'
  findings: number
  cards: number
}
export interface InvestigationSnapshot {
  version: 1
  phase: 'collecting' | 'verifying' | 'repairing' | 'verified'
  activeTool: string | null
  nextAction: string
  tools: string[]
  calls: number
  requests: number
  repairs: number
  evidenceBytes: number
  meter: { total: number; responses: number }
  steps: InvestigationStep[]
  gaps: { stepIndex: number | null; code: string; message: string }[]
}
export function isInvestigation(value: unknown): value is InvestigationSnapshot {
  const s = value as InvestigationSnapshot | null
  return (
    !!s &&
    s.version === 1 &&
    ['collecting', 'verifying', 'repairing', 'verified'].includes(s.phase) &&
    typeof s.nextAction === 'string' &&
    s.nextAction.length <= 600 &&
    Array.isArray(s.steps) &&
    s.steps.length <= 16 &&
    s.steps.every(
      (r) => Number.isInteger(r.stepIndex) && ['pending', 'complete', 'partial'].includes(r.read)
    ) &&
    Array.isArray(s.gaps) &&
    s.gaps.length <= 20 &&
    Array.isArray(s.tools) &&
    s.tools.every((t) => typeof t === 'string') &&
    Number.isFinite(s.meter?.total)
  )
}
