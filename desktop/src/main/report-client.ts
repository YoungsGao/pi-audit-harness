import { randomUUID } from 'node:crypto'
import type { ReportAction, ReportData } from '../shared/report-contracts'
import { reportInput, isReportData } from '../shared/report-contracts.ts'
import type { ApiResult } from '../shared/service-protocol'

export async function reportRequest(
  port: number,
  token: string,
  action: ReportAction,
  input: unknown
): Promise<ApiResult<ReportData>> {
  const failed = (): ApiResult<ReportData> => ({
    ok: false,
    requestId: randomUUID(),
    error: {
      code: 'REPORT_TRANSPORT_FAILED',
      message: '报告服务通信失败或响应无效，请刷新已登记报告',
      retryable: true
    }
  })
  try {
    const scope = reportInput(action, input)
    const response = await fetch(`http://127.0.0.1:${port}/reports/${action}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      redirect: 'error',
      signal: AbortSignal.timeout(['generate', 'export'].includes(action) ? 45000 : 10000)
    })
    const raw = await response.text()
    if (raw.length > 1000000) return failed()
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
      !isReportData(action, body.data) ||
      body.data.projectId !== scope.projectId ||
      body.data.runId !== scope.runId ||
      (action === 'file' &&
        (!('reportId' in body.data) || body.data.reportId !== scope.reportId)) ||
      (['preview', 'export'].includes(action) &&
        'filter' in body.data &&
        (['verdict', 'pathStatus', 'reviewStatus'] as const).some(
          (key) => body.data.filter[key] !== scope.filter?.[key]
        ))
    )
      return failed()
    return { ok: true, requestId: body.requestId, data: body.data }
  } catch {
    return failed()
  }
}
