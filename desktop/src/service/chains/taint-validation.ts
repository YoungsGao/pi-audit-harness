import { ApiError } from '../../shared/api-error.ts'
import { propagationChecks } from '../../shared/taint-contracts.ts'
import type { TaintReview } from '../../shared/taint-contracts.ts'
import type { ReviewResult } from '../storage/scan-repository.ts'
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const short = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= 1000

export function validateTaint(step: unknown, text: string | string[]): TaintReview {
  const fail = (): never => {
    throw new ApiError('ANALYSIS_TAINT_INVALID', '传播结果缺少逐项核查、污染值或真实原文引用', 502)
  }
  if (!object(step) || !object(step.checks)) return fail()
  const quotes = (v: unknown, required: boolean): boolean =>
    Array.isArray(v) &&
    v.length <= 5 &&
    (!required || v.length > 0) &&
    v.every(
      (q) => short(q) && (Array.isArray(text) ? text : [text]).some((source) => source.includes(q))
    )
  for (const key of propagationChecks) {
    const check = step.checks[key]
    if (
      !object(check) ||
      !['supported', 'blocked', 'unknown', 'not_applicable'].includes(String(check.status)) ||
      !short(check.reason) ||
      !quotes(check.quotes, check.status === 'supported' || check.status === 'blocked')
    )
      return fail()
    if (check.status === 'blocked' && key !== 'defense') return fail()
  }
  for (const key of ['taintIn', 'taintOut']) {
    const values = step[key]
    if (
      !Array.isArray(values) ||
      values.length > 16 ||
      values.some(
        (v) =>
          !object(v) ||
          !short(v.name) ||
          !short(v.origin) ||
          !quotes(v.quotes, true) ||
          (v.fromStep !== undefined &&
            (!Number.isInteger(v.fromStep) || Number(v.fromStep) < 0 || Number(v.fromStep) >= 16))
      )
    )
      return fail()
  }
  const review = step as unknown as TaintReview
  if (
    step.dangerous === 1 &&
    Number(step.stepIndex) > 0 &&
    !review.taintIn.some((v) => v.fromStep === Number(step.stepIndex) - 1)
  )
    return fail()
  if ((step.dangerous === 0) !== (review.checks.defense.status === 'blocked')) return fail()
  if (
    step.dangerous === 1 &&
    (!review.taintIn.length ||
      !review.taintOut.length ||
      review.checks.argumentMapping.status !== 'supported' ||
      propagationChecks.some((k) => review.checks[k].status === 'unknown'))
  )
    return fail()
  return review
}

export function reconcileTaint(
  result: ReviewResult,
  truncated: boolean,
  sourceRef: string | null
): ReviewResult {
  let insufficient = truncated || !sourceRef?.startsWith('http-entry-candidate:')
  if (
    result.verdict === 'dangerous' &&
    result.steps.find((s) => s.stepIndex === 0)?.checks?.source.status !== 'supported'
  )
    insufficient = true
  if (result.verdict === 'dangerous' && insufficient)
    return {
      ...result,
      verdict: 'unknown',
      summary: result.summary + '\n来源或覆盖范围不足，风险结论降为未知。',
      steps: result.steps.map((s) => ({ ...s, dangerous: null }))
    }
  if (result.verdict === 'unknown')
    return {
      ...result,
      steps: result.steps.map((s) => ({ ...s, dangerous: s.dangerous === 1 ? null : s.dangerous }))
    }
  return result
}
