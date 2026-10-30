import { randomUUID } from 'node:crypto'
import { auditActions, isAuditData } from '../shared/audit-validation.ts'
import { runControlInput } from '../shared/run-contracts.ts'
import type { AuditAction, AuditData } from '../shared/scan-contracts'
import type { ApiResult } from '../shared/service-protocol'

export async function auditRequest(
  port: number,
  token: string,
  action: AuditAction,
  input: unknown
): Promise<ApiResult<AuditData>> {
  const failed = (): ApiResult<AuditData> => ({
    ok: false,
    requestId: randomUUID(),
    error: {
      code: 'AUDIT_TRANSPORT_FAILED',
      message: '审计服务响应无效或通信中断，请刷新数据库状态',
      retryable: true
    }
  })
  if (!auditActions.includes(action)) return failed()
  try {
    if (action === 'stop' || action === 'resume' || action === 'recovery')
      runControlInput(action, input)
    const response = await fetch(`http://127.0.0.1:${port}/chains/${action}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      redirect: 'error',
      signal: AbortSignal.timeout(action === 'prepare' ? 90000 : 10000)
    })
    const raw = await response.text()
    // 2000 项快照清单可包含较长相对路径；仍单独设置有界响应上限。
    if (raw.length > (action === 'snapshot' ? 20 * 1024 * 1024 : 1000000)) return failed()
    const body = JSON.parse(raw)
    if (
      body?.ok === false &&
      typeof body.requestId === 'string' &&
      typeof body.error?.code === 'string' &&
      typeof body.error.message === 'string' &&
      typeof body.error.retryable === 'boolean'
    )
      return {
        ok: false,
        requestId: body.requestId,
        error: {
          code: body.error.code,
          message: body.error.message,
          retryable: body.error.retryable
        }
      }
    if (
      !response.ok ||
      body?.ok !== true ||
      typeof body.requestId !== 'string' ||
      !isAuditData(action, body.data)
    )
      return failed()
    const scope = input as Record<string, unknown>
    for (const key of ['projectId', 'runId', 'pathId'])
      if (key in body.data && key in scope && body.data[key] !== scope[key]) return failed()
    return { ok: true, requestId: body.requestId, data: body.data }
  } catch {
    return failed()
  }
}
