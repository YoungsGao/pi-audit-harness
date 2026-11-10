import { ApiError } from '../../shared/api-error.ts'

export interface ValidationIssue {
  field: string
  rule: string
  stepIndex: number | null
  message: string
}

// Diagnostics contain field names and fixed explanations, never the rejected model text.
export class ResultValidationError extends ApiError {
  readonly issue: ValidationIssue
  constructor(
    code: string,
    field: string,
    rule: string,
    message: string,
    stepIndex: number | null = null
  ) {
    super(code, message, 502)
    this.issue = { field, rule, stepIndex, message }
  }
}

export function invalidResult(
  code: string,
  field: string,
  rule: string,
  message: string,
  stepIndex: number | null = null
): never {
  throw new ResultValidationError(code, field, rule, message, stepIndex)
}

// A bounded projection of the public structured submission, excluding arbitrary
// provider fields (e.g. hidden reasoning). The event layer redacts it again.
export function publicSubmission(value: unknown): unknown {
  const record = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  const text = (v: unknown): unknown => (typeof v === 'string' ? v.slice(0, 400) : typeof v)
  const quotes = (v: unknown): unknown => (Array.isArray(v) ? v.slice(0, 5).map(text) : typeof v)
  const result = record(value)
  const preview = {
    verdict: text(result.verdict),
    summary: text(result.summary),
    stepCount: Array.isArray(result.steps) ? result.steps.length : null,
    steps: Array.isArray(result.steps)
      ? result.steps.slice(0, 5).map((s) => {
          const step = record(s),
            checks = record(step.checks)
          return {
            stepIndex: typeof step.stepIndex === 'number' ? step.stepIndex : null,
            dangerous: [0, 1, null].includes(step.dangerous as number | null)
              ? step.dangerous
              : typeof step.dangerous,
            reason: text(step.reason),
            quotes: quotes(step.quotes),
            checks: Object.fromEntries(
              ['source', 'argumentMapping', 'assignment', 'returnValue', 'field', 'defense'].map(
                (k) => {
                  const c = record(checks[k])
                  return [
                    k,
                    { status: text(c.status), reason: text(c.reason), quotes: quotes(c.quotes) }
                  ]
                }
              )
            )
          }
        })
      : []
  }
  if (Buffer.byteLength(JSON.stringify(preview)) > 3072)
    return {
      verdict: text(result.verdict),
      stepCount: preview.stepCount,
      omitted: 'public submission preview exceeds 3KiB'
    }
  return preview
}
