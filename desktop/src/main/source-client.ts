import { randomUUID } from 'node:crypto'
import {
  isTools,
  isSourceCatalog,
  isSourceProject,
  isSourceOpened
} from '../shared/source-contracts.ts'
import type { ApiResult } from '../shared/service-protocol'
export type SourceAction = 'tools' | 'list' | 'local' | 'github' | 'open'
export async function sourceRequest<T>(
  port: number,
  token: string,
  action: SourceAction,
  input?: unknown
): Promise<ApiResult<T>> {
  const paths = {
    tools: '/sources/tools',
    list: '/sources',
    local: '/sources/local',
    github: '/sources/github',
    open: '/sources/open'
  }
  try {
    const reading = action === 'tools' || action === 'list'
    const response = await fetch(`http://127.0.0.1:${port}${paths[action]}`, {
      method: reading ? 'GET' : 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        ...(!reading ? { 'Content-Type': 'application/json' } : {})
      },
      ...(!reading ? { body: JSON.stringify(input) } : {}),
      signal: AbortSignal.timeout(75000),
      redirect: 'error'
    })
    const body = (await response.json()) as ApiResult<unknown>
    if (
      body &&
      typeof body.requestId === 'string' &&
      body.ok === false &&
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
    const valid =
      action === 'tools'
        ? isTools
        : action === 'list'
          ? isSourceCatalog
          : action === 'open'
            ? isSourceOpened
            : isSourceProject
    if (
      !response.ok ||
      !body ||
      body.ok !== true ||
      typeof body.requestId !== 'string' ||
      !valid(body.data)
    )
      throw new Error('invalid source response')
    return { ok: true, requestId: body.requestId, data: body.data as T }
  } catch {
    return {
      ok: false,
      requestId: randomUUID(),
      error: {
        code: 'SOURCE_TRANSPORT_FAILED',
        message: '本地源码服务通信失败；请刷新列表核对是否已登记',
        retryable: true
      }
    }
  }
}
