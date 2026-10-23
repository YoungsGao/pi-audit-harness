import { isModelPingData, MODEL_TEST_TRANSPORT_MS } from '../shared/model-test.ts'
import { randomUUID } from 'node:crypto'
import type { ApiResult, HealthData } from '../shared/service-protocol'
import type { ModelPingData } from '../shared/pi-contracts'
import { isDatabaseInfo } from '../shared/storage-contracts.ts'
import { isPiRuntimeInfo } from '../shared/pi-contracts.ts'
import { ApiError } from '../shared/api-error.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseFailure(body: unknown, status: number): ApiError | undefined {
  if (
    isRecord(body) &&
    body.ok === false &&
    typeof body.requestId === 'string' &&
    isRecord(body.error) &&
    typeof body.error.code === 'string' &&
    typeof body.error.message === 'string' &&
    typeof body.error.retryable === 'boolean'
  ) {
    return new ApiError(
      body.error.code,
      body.error.message,
      status,
      body.error.retryable,
      body.requestId
    )
  }
  return undefined
}

export async function checkLocalHealth(port: number, token: string): Promise<HealthData> {
  const response = await fetch('http://127.0.0.1:' + port + '/health', {
    headers: { Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(2000),
    redirect: 'error'
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok)
    throw (
      parseFailure(body, response.status) ??
      new ApiError('INVALID_HEALTH_RESPONSE', '健康检查错误响应格式无效', 502)
    )
  if (
    !isRecord(body) ||
    body.ok !== true ||
    typeof body.requestId !== 'string' ||
    !isRecord(body.data) ||
    body.data.service !== 'pi-audit-local' ||
    body.data.stage !== 'http-ready'
  ) {
    throw new ApiError('INVALID_HEALTH_RESPONSE', '健康检查响应格式或服务身份不正确', 502)
  }
  if (body.data.database !== undefined && !isDatabaseInfo(body.data.database))
    throw new ApiError('INVALID_HEALTH_RESPONSE', '数据库健康状态无效', 502)
  const database = isDatabaseInfo(body.data.database) ? body.data.database : undefined
  if (body.data.pi === 'not-integrated' && body.data.runtime === undefined) {
    return {
      service: 'pi-audit-local',
      stage: 'http-ready',
      pi: 'not-integrated',
      ...(database ? { database } : {})
    }
  }
  if (!isPiRuntimeInfo(body.data.runtime) || body.data.pi !== body.data.runtime.state) {
    throw new ApiError('INVALID_HEALTH_RESPONSE', 'Pi 健康状态无效', 502)
  }
  return {
    service: 'pi-audit-local',
    stage: 'http-ready',
    pi: body.data.runtime.state,
    runtime: body.data.runtime,
    ...(database ? { database } : {})
  }
}

export async function postModelTest(
  port: number,
  token: string,
  configId: string
): Promise<ApiResult<ModelPingData>> {
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/test', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelConfigId: configId }),
      signal: AbortSignal.timeout(MODEL_TEST_TRANSPORT_MS),
      redirect: 'error'
    })
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok)
      throw (
        parseFailure(body, response.status) ??
        new ApiError('INVALID_TEST_RESPONSE', '模型测试错误响应格式无效', 502)
      )
    if (
      !isRecord(body) ||
      body.ok !== true ||
      typeof body.requestId !== 'string' ||
      !isModelPingData(body.data) ||
      body.data.model.configId !== configId
    ) {
      throw new ApiError('INVALID_TEST_RESPONSE', '模型测试成功响应格式无效', 502)
    }
    return {
      ok: true,
      requestId: body.requestId,
      data: {
        reply: body.data.reply,
        latencyMs: body.data.latencyMs,
        model: {
          configId: body.data.model.configId,
          revision: body.data.model.revision,
          modelId: body.data.model.modelId
        }
      }
    }
  } catch (error) {
    const failure =
      error instanceof ApiError
        ? error
        : new ApiError('LOCAL_SERVICE_UNAVAILABLE', '无法完成本地服务请求', 503, true)
    return {
      ok: false,
      requestId: failure.requestId ?? randomUUID(),
      error: { code: failure.code, message: failure.message, retryable: failure.retryable }
    }
  }
}
