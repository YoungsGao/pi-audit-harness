import { randomUUID } from 'node:crypto'
import { isTemplateData, templateActions } from '../shared/template-contracts.ts'
import type { TemplateAction, TemplateData } from '../shared/template-contracts'
import type { ApiResult } from '../shared/service-protocol'
export async function templateRequest(
  port: number,
  token: string,
  action: TemplateAction,
  input: unknown
): Promise<ApiResult<TemplateData>> {
  const failed = (): ApiResult<TemplateData> => ({
    ok: false,
    requestId: randomUUID(),
    error: {
      code: 'TEMPLATE_TRANSPORT_FAILED',
      message: '模板服务通信失败或响应无效，请刷新',
      retryable: true
    }
  })
  if (!templateActions.includes(action)) return failed()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/templates/${action}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      redirect: 'error',
      signal: AbortSignal.timeout(10000)
    })
    const raw = await response.text()
    if (raw.length > 4 * 1024 * 1024) return failed()
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
      !isTemplateData(action, body.data)
    )
      return failed()
    const scope = input as Record<string, unknown>
    for (const key of ['projectId', 'runId'])
      if (key in body.data && key in scope && body.data[key] !== scope[key]) return failed()
    return { ok: true, requestId: body.requestId, data: body.data }
  } catch {
    return failed()
  }
}
