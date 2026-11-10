import { invalidResult } from './result-validation.ts'
import { propagationChecks } from '../../shared/taint-contracts.ts'
import type { TaintReview } from '../../shared/taint-contracts.ts'
import type { ReviewResult } from '../storage/scan-repository.ts'
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const short = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= 1000

export function validateTaint(
  step: unknown,
  text: string | string[],
  constantArguments = false
): TaintReview {
  const index = object(step) && Number.isInteger(step.stepIndex) ? Number(step.stepIndex) : null
  const fail = (
    field = 'checks',
    rule = 'shape',
    message = '传播结果需要六项检查和污染值数组'
  ): never => {
    return invalidResult(
      'ANALYSIS_TAINT_INVALID',
      `steps[${index ?? '?'}].${field}`,
      rule,
      message,
      index
    )
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
      return fail(
        `checks.${key}`,
        'check-shape-and-quotes',
        `${key}须含有效status、非空reason和quotes数组；supported/blocked必须引用本步骤原文`
      )
    if (check.status === 'blocked' && key !== 'defense')
      return fail(`checks.${key}.status`, 'defense-only', 'blocked只能用于defense检查')
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
      return fail(
        key,
        'taint-values',
        `${key}必须为数组；每个值包含name、origin、真实quotes，可选fromStep须为有效整数`
      )
  }
  const review = step as unknown as TaintReview
  if (
    step.dangerous === 1 &&
    Number(step.stepIndex) > 0 &&
    !review.taintIn.some((v) => v.fromStep === Number(step.stepIndex) - 1)
  )
    return fail(
      'taintIn',
      'previous-step',
      '非首步骤的dangerous=1需要taintIn.fromStep指向上一编号步骤，并引用真实映射'
    )
  const fixedInput =
    constantArguments &&
    step.dangerous === 0 &&
    review.checks.defense.status === 'not_applicable' &&
    !review.taintIn.length &&
    !review.taintOut.length &&
    review.checks.argumentMapping.status !== 'unknown'
  if (!fixedInput && (step.dangerous === 0) !== (review.checks.defense.status === 'blocked'))
    return fail(
      'checks.defense.status',
      'defense-consistency',
      'effective/blocked表示攻击被有效防护阻断，须dangerous=0；防护缺失请用absent，不能用blocked，也不能为了通过校验改成安全'
    )
  if (
    step.dangerous === 1 &&
    (!review.taintIn.length ||
      !review.taintOut.length ||
      review.checks.argumentMapping.status !== 'supported' ||
      propagationChecks.some((k) => review.checks[k].status === 'unknown'))
  )
    return fail(
      'dangerous',
      'supported-propagation',
      'dangerous=1须有污染输入输出、argumentMapping=supported且六项检查均不能unknown；证据不足用unknown/null'
    )
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
