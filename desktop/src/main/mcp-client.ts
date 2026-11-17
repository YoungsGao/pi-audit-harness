import { randomUUID } from 'node:crypto'
import type { ApiResult } from '../shared/service-protocol.ts'
import { mcpActions, isMcpData } from '../shared/mcp-settings.ts'
import type { McpAction, McpData } from '../shared/mcp-settings.ts'
import { publicAnalysisValue } from '../shared/path-detail-view.ts'
export async function mcpRequest(
  port: number,
  token: string,
  action: McpAction,
  input: unknown
): Promise<ApiResult<McpData>> {
  const failed = (): ApiResult<McpData> => ({
    ok: false,
    requestId: randomUUID(),
    error: {
      code: 'MCP_TRANSPORT_FAILED',
      message: 'MCP管理服务通信失败，请刷新后重试',
      retryable: true
    }
  })
  if (!mcpActions.includes(action)) return failed()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/mcp/${action}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      redirect: 'error',
      signal: AbortSignal.timeout(45000)
    })
    const raw = await response.text()
    if (raw.length > 4 * 1024 * 1024) return failed()
    const body = JSON.parse(raw)
    if (
      body?.ok === false &&
      typeof body.requestId === 'string' &&
      typeof body.error?.code === 'string' &&
      typeof body.error.message === 'string'
    )
      return {
        ok: false,
        requestId: body.requestId,
        error: {
          code: body.error.code,
          message: body.error.message,
          retryable: body.error.retryable === true
        }
      }
    if (
      !response.ok ||
      body?.ok !== true ||
      typeof body.requestId !== 'string' ||
      !isMcpData(body.data)
    )
      return failed()
    return {
      ok: true,
      requestId: body.requestId,
      data: action === 'call' ? (publicAnalysisValue(body.data) as McpData) : body.data
    }
  } catch {
    return failed()
  }
}
