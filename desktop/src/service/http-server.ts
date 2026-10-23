import { createServer } from 'node:http'
import type { ModelCatalog } from '../shared/model-settings'
import type { MetadataOverview, ModelSaveResult, ProjectRecord } from '../shared/metadata-contracts'
import type { DatabaseInfo, StorageOverview } from '../shared/storage-contracts'
import { ApiError } from '../shared/api-error.ts'
import { createRequestContext, successResult, failureResult } from './response.ts'
import type { RequestContext, HealthData } from '../shared/service-protocol'
import type { ModelPingData, PiRuntimeInfo } from '../shared/pi-contracts'
import type { CodeQueryAction, RuleCatalog } from '../shared/code-query-contracts'
import type { ChainAction } from './chains/service'

export interface RunningHttpServer {
  port: number
  close: () => Promise<void>
}

export interface LocalApi {
  getRules?: () => RuleCatalog
  codeQuery?: (action: CodeQueryAction, input: unknown, signal: AbortSignal) => Promise<unknown>
  chainAction?: (action: ChainAction, input: unknown, signal: AbortSignal) => Promise<unknown>
  getSourceTools?: (signal: AbortSignal) => Promise<unknown>
  getSources?: () => unknown
  sourceAction?: (
    action: 'local' | 'github' | 'open',
    input: unknown,
    signal: AbortSignal
  ) => Promise<unknown>
  getModelCatalog?: () => ModelCatalog
  selectModel?: (input: unknown, signal: AbortSignal) => Promise<ModelCatalog>
  getMetadata?: () => MetadataOverview
  saveProject?: (input: unknown, signal: AbortSignal) => Promise<ProjectRecord>
  saveModel?: (input: unknown, signal: AbortSignal) => Promise<ModelSaveResult>
  getDatabase?: () => DatabaseInfo
  getStorageOverview?: () => StorageOverview
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
          ...(runtime ? { runtime } : {}),
          ...(api.getDatabase ? { database: api.getDatabase() } : {})
        }
        send(200, successResult(context, data))
        return
      }

      if (request.method === 'GET' && request.url === '/rules') {
        if (!api.getRules) throw new ApiError('RULES_NOT_READY', '内置规则尚未接入', 503)
        send(200, successResult(context, api.getRules()))
        return
      }
      const codeRoutes = ['/code/search', '/code/read', '/code/risks']
      const chainRoutes = [
        '/chains/prepare',
        '/chains/list',
        '/chains/detail',
        '/chains/runs',
        '/chains/statistics',
        '/chains/analyze'
      ]
      if (
        request.method === 'POST' &&
        [...codeRoutes, ...chainRoutes].includes(request.url ?? '')
      ) {
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json'))
          throw new ApiError('QUERY_INVALID_INPUT', '代码查询请求必须为 JSON', 415)
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of request) {
          size += chunk.length
          if (size > 16384) throw new ApiError('QUERY_INVALID_INPUT', '查询请求体超过 16KiB', 413)
          chunks.push(chunk)
        }
        let value: unknown
        try {
          value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          throw new ApiError('QUERY_INVALID_INPUT', '查询请求 JSON 无效', 400)
        }
        const route = request.url!
        let data: unknown
        if (codeRoutes.includes(route)) {
          if (!api.codeQuery) throw new ApiError('QUERY_NOT_READY', '代码查询尚未接入', 503)
          data = await api.codeQuery(
            route.slice('/code/'.length) as CodeQueryAction,
            value,
            controller.signal
          )
        } else {
          if (!api.chainAction) throw new ApiError('CHAIN_NOT_READY', '调用链服务尚未接入', 503)
          data = await api.chainAction(
            route.slice('/chains/'.length) as ChainAction,
            value,
            controller.signal
          )
        }
        send(200, successResult(context, data))
        return
      }

      if (request.method === 'GET' && request.url === '/sources/tools') {
        if (!api.getSourceTools) throw new ApiError('SOURCE_NOT_READY', '源码服务尚未接入', 503)
        send(200, successResult(context, await api.getSourceTools(controller.signal)))
        return
      }
      if (request.method === 'GET' && request.url === '/sources') {
        if (!api.getSources) throw new ApiError('SOURCE_NOT_READY', '源码服务尚未接入', 503)
        send(200, successResult(context, api.getSources()))
        return
      }
      if (
        request.method === 'POST' &&
        ['/sources/local', '/sources/github', '/sources/open'].includes(request.url ?? '')
      ) {
        if (!api.sourceAction) throw new ApiError('SOURCE_NOT_READY', '源码服务尚未接入', 503)
        if (!request.headers['content-type']?.startsWith('application/json'))
          throw new ApiError('SOURCE_INPUT_INVALID', '源码请求必须为 JSON', 415)
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of request) {
          size += chunk.length
          if (size > 8192) throw new ApiError('SOURCE_INPUT_INVALID', '源码请求体超过 8KiB', 413)
          chunks.push(chunk)
        }
        let value: unknown
        try {
          value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          throw new ApiError('SOURCE_INPUT_INVALID', '源码请求 JSON 无效', 400)
        }
        const action = request.url!.slice('/sources/'.length) as 'local' | 'github' | 'open'
        send(200, successResult(context, await api.sourceAction(action, value, controller.signal)))
        return
      }
      // 精确匹配固定只读路由，不接受路径、SQL 或任意查询参数。
      if (request.method === 'GET' && request.url === '/storage/overview') {
        if (!api.getStorageOverview) throw new ApiError('DB_NOT_READY', '数据库尚未接入', 503)
        send(200, successResult(context, api.getStorageOverview()))
        return
      }
      if (request.method === 'GET' && request.url === '/models') {
        if (!api.getModelCatalog)
          throw new ApiError('MODEL_SETTINGS_NOT_READY', '模型选择尚未接入', 503)
        send(200, successResult(context, api.getModelCatalog()))
        return
      }
      if (request.method === 'GET' && request.url === '/metadata') {
        if (!api.getMetadata) throw new ApiError('METADATA_NOT_READY', '元数据服务尚未接入', 503)
        send(200, successResult(context, api.getMetadata()))
        return
      }
      if (
        request.method === 'POST' &&
        ['/metadata/projects', '/metadata/models', '/models/selection'].includes(request.url ?? '')
      ) {
        const operation =
          request.url === '/models/selection'
            ? api.selectModel
            : request.url === '/metadata/projects'
              ? api.saveProject
              : api.saveModel
        if (!operation) throw new ApiError('METADATA_NOT_READY', '元数据服务尚未接入', 503)
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json'))
          throw new ApiError('INVALID_METADATA', '元数据请求必须为 JSON', 415)
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of request) {
          size += chunk.length
          if (size > 16384) throw new ApiError('INVALID_METADATA', '元数据请求体超过 16 KiB', 413)
          chunks.push(chunk)
        }
        let input: unknown
        try {
          input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          throw new ApiError('INVALID_METADATA', '元数据请求必须为有效 JSON', 400)
        }
        const result = await operation(input, controller.signal)
        send(200, successResult(context, result))
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
