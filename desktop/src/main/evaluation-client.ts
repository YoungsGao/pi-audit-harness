import { randomUUID } from 'node:crypto'
import { evaluationActions, isEvaluationData } from '../shared/evaluation.ts'
import type { EvaluationAction } from '../shared/evaluation.ts'
import type { ApiResult } from '../shared/service-protocol.ts'
export async function evaluationRequest(
  port: number,
  token: string,
  action: EvaluationAction,
  input: unknown
): Promise<ApiResult<unknown>> {
  const requestId = randomUUID()
  try {
    if (!evaluationActions.includes(action)) throw Error('action')
    const response = await fetch(`http://127.0.0.1:${port}/evaluations/${action}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      redirect: 'error',
      signal: AbortSignal.timeout(45000)
    })
    const raw = await response.text()
    if (raw.length > 4 * 1024 * 1024) throw Error('limit')
    const body = JSON.parse(raw)
    if (
      body.ok === false &&
      typeof body.error?.code === 'string' &&
      typeof body.error.message === 'string'
    )
      return body
    if (!response.ok || body.ok !== true || !isEvaluationData(body.data)) throw Error('shape')
    return body
  } catch {
    return {
      ok: false,
      requestId,
      error: {
        code: 'EVAL_TRANSPORT_FAILED',
        message: '评测中心通信失败，请刷新核对状态',
        retryable: true
      }
    }
  }
}
