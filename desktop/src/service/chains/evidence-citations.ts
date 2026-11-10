import { createHash } from 'node:crypto'
import type { ReviewInput } from './path-analysis.ts'
import { invalidResult } from './result-validation.ts'
import { propagationChecks } from '../../shared/taint-contracts.ts'

type Scope = Pick<ReviewInput, 'projectId' | 'runId' | 'pathId'>
export function evidenceCards(
  evidence: ReviewInput['evidence'][number],
  stepIndex: number,
  scope: Scope
): { id: string; filePath: string; startLine: number; endLine: number; text: string }[] {
  return (evidence.ranges ?? [evidence]).flatMap((range, r) => {
    const digest = createHash('sha256')
      .update(JSON.stringify([scope.projectId, scope.runId, scope.pathId, stepIndex, range]))
      .digest('hex')
      .slice(0, 16)
    return range.text.split(/\r?\n/).flatMap((text, i) =>
      text.trim() && text.length <= 1000
        ? [
            {
              id: `ev-${stepIndex}-${r}-${range.startLine + i}-${digest}`,
              filePath: range.filePath,
              startLine: range.startLine + i,
              endLine: range.startLine + i,
              text
            }
          ]
        : []
    )
  })
}

// The stored ReviewResult keeps original source strings; only the model transport uses IDs.
// No fuzzy matching or implicit repair of a changed identifier is allowed.
export function resolveResultCitations(value: unknown, input: ReviewInput): unknown {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { steps?: unknown }).steps))
    return value
  const result = structuredClone(value) as { steps: Record<string, unknown>[] }
  const registered = new Map(
    input.evidence.flatMap((e, i) =>
      e ? evidenceCards(e, i, input).map((c) => [c.id, c.text] as const) : []
    )
  )
  for (const step of result.steps) {
    if (!step || typeof step !== 'object') continue
    const index = Number(step.stepIndex),
      evidence = input.evidence[index]
    if (!Number.isInteger(step.stepIndex) || !evidence) continue
    const cards = new Map(evidenceCards(evidence, index, input).map((c) => [c.id, c.text]))
    const quotes = (v: unknown, field: string): unknown =>
      Array.isArray(v)
        ? v.map((q, i) => {
            if (typeof q !== 'string' || !q.startsWith('ev-')) return q
            const text = cards.get(q) ?? registered.get(q)
            if (
              text === undefined ||
              !(evidence.ranges ?? [evidence]).some((r) => r.text.includes(text))
            )
              invalidResult(
                'ANALYSIS_EVIDENCE_INVALID',
                `steps[${index}].${field}[${i}]`,
                'registered-citation',
                '证据编号必须来自当前任务、本步骤实际返回的证据卡',
                index
              )
            return text
          })
        : v
    step.quotes = quotes(step.quotes, 'quotes')
    for (const key of ['taintIn', 'taintOut'])
      if (Array.isArray(step[key]))
        for (const [i, item] of (step[key] as unknown[]).entries())
          if (item && typeof item === 'object') {
            const v = item as Record<string, unknown>
            v.quotes = quotes(v.quotes, `${key}[${i}].quotes`)
          }
    if (step.checks && typeof step.checks === 'object')
      for (const key of propagationChecks) {
        const check = (step.checks as Record<string, unknown>)[key]
        if (check && typeof check === 'object') {
          const v = check as Record<string, unknown>
          if (key === 'defense') {
            if (v.status === 'effective') v.status = 'blocked'
            else if (v.status === 'absent') v.status = 'not_applicable'
          }
          v.quotes = quotes(v.quotes, `checks.${key}.quotes`)
        }
      }
  }
  return result
}
