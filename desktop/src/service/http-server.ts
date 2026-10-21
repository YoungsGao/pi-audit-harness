import { createServer } from 'node:http'
import { ApiError } from '../shared/api-error.ts'
import { createRequestContext, successResult, failureResult } from './response.ts'
import type { RequestContext, HealthData } from '../shared/service-protocol'
import type { ModelPingData, PiRuntimeInfo } from '../shared/pi-contracts'

export interface RunningHttpServer {
  port: number
  close: () => Promise<void>
}

export interface LocalApi {
  getRuntime?: () => PiRuntimeInfo
  testModel?: (id: string, context: RequestContext, signal: AbortSignal) => Promise<ModelPingData>
}

export async function startHttpServer(
  token: string,
  api: LocalApi = {}
): Promise<RunningHttpServer> {
  if (!token) throw new Error('启动令牌不能为空')
  let closing: Promise<void> | undefined
  const requests = new Set<AbortController>()
  const server = createServer((request, response) => {
    const context = createRequestContext()
    const controller = new AbortController()
    requests.add(controller)
    const abort = (): void => {
      if (!response.writableEnded) controller.abort()
      requests.delete(controller)
    }
    request.once('aborted', abort)
    response.once('close', abort)
    const send = (status: number, body: unknown): void => {
      if (response.destroyed || response.writableEnded) return
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Request-Id': context.requestId
      })
      response.end(JSON.stringify(body))
    }
    void (async () => {
      if (request.headers.authorization !== 'Bearer ' + token)
        throw new ApiError('UNAUTHORIZED', '本地服务认证失败', 401)
      if (closing) throw new ApiError('SERVICE_STOPPING', '服务正在关闭', 503)
      if (request.method === 'GET' && request.url === '/health') {
        const runtime = api.getRuntime?.()
        const data: HealthData = {
          service: 'pi-audit-local',
          stage: 'http-ready',
          pi: runtime?.state ?? 'not-integrated',
          ...(runtime ? { runtime } : {})
        }
        send(200, successResult(context, data))
        return
      }
      if (request.method === 'POST' && request.url === '/test') {
        if (!api.testModel) throw new ApiError('MODEL_TEST_NOT_READY', '模型测试入口尚未接入', 503)
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of request) {
          size += chunk.length
          if (size > 8192) throw new ApiError('INVALID_REQUEST', '测试请求体超过 8 KiB', 413)
          chunks.push(chunk)
        }
        let body: unknown
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          throw new ApiError('INVALID_REQUEST', '请求体必须为 JSON', 400)
        }
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          !('modelConfigId' in body) ||
          typeof body.modelConfigId !== 'string' ||
          Object.keys(body).some((key) => key !== 'modelConfigId')
        ) {
          throw new ApiError('INVALID_REQUEST', '模型测试只接受 modelConfigId', 400)
        }
        const result = await api.testModel(body.modelConfigId, context, controller.signal)
        send(
          200,
          successResult(context, {
            reply: result.reply,
            latencyMs: result.latencyMs,
            model: result.model
          })
        )
        return
      }
      throw new ApiError('NOT_FOUND', '接口不存在', 404)
    })()
      .catch((error: unknown) => {
        const failure = failureResult(context, error)
        send(failure.status, failure.body)
      })
      .finally(() => requests.delete(controller))
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法取得本地服务端口')
  return {
    port: address.port,
    close: () => {
      closing ??= new Promise<void>((resolve, reject) => {
        for (const controller of requests) controller.abort()
        const timer = setTimeout(() => server.closeAllConnections(), 2000)
        server.close((error) => {
          clearTimeout(timer)
          if (error) reject(error)
          else resolve()
        })
      })
      return closing
    }
  }
}
