import type { ModelPingData } from './pi-contracts'
import type { ApiResult } from './service-protocol'
export const MODEL_TEST_TIMEOUT_MS = 15000
export const MODEL_TEST_TRANSPORT_MS = 20000
export function isModelPingData(value: unknown): value is ModelPingData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>,
    model = row.model
  if (Object.keys(row).length !== 3 || !model || typeof model !== 'object' || Array.isArray(model))
    return false
  const id = model as Record<string, unknown>
  return (
    typeof row.reply === 'string' &&
    !!row.reply.trim() &&
    typeof row.latencyMs === 'number' &&
    Number.isFinite(row.latencyMs) &&
    row.latencyMs >= 0 &&
    Object.keys(id).length === 3 &&
    typeof id.configId === 'string' &&
    /^[A-Za-z0-9_-]{1,80}$/.test(id.configId) &&
    typeof id.modelId === 'string' &&
    !!id.modelId.trim() &&
    Number.isSafeInteger(id.revision) &&
    Number(id.revision) > 0
  )
}
const hints: Record<string, string> = {
  MODEL_AUTH_FAILED: '检查 API Key、服务账号和访问权限。',
  MODEL_RATE_LIMIT: '检查额度或限流；稍后自行点击重试，不会自动重发。',
  MODEL_SERVICE_FAILED: '模型服务暂时不可用，稍后自行点击重试。',
  MODEL_OR_ENDPOINT_NOT_FOUND: '核对 Base URL、接口路径和服务支持的模型 ID。',
  MODEL_TIMEOUT: '本次测试已超时；检查网络或服务后再试。',
  MODEL_NETWORK_FAILED: '检查网络、代理和服务地址。',
  MODEL_CREDENTIAL_MISSING: '请先编辑当前配置，重新保存对应的 API Key。',
  EMPTY_REPLY: '服务未返回非空文本；不能判定连通成功。',
  PI_BUSY: '已有 Pi 调用正在执行，请等其结束。',
  SERVICE_NOT_READY: '等待本地服务就绪后重试。',
  LOCAL_SERVICE_UNAVAILABLE: '本地服务通信失败；这不等于已经收到供应商回复。',
  CANCELLED: '请求被取消；本次没有连通成功结论。',
  MODEL_RESPONSE_TOO_LARGE: '回复超出本次测试的大小限制。',
  MODEL_TEST_ID_MISMATCH: '回复所属配置不一致，已拒绝显示为成功。'
}
export function modelTestHint(code: string): string {
  return hints[code] ?? '检查配置和服务状态，可用请求编号定位问题。'
}
export type ModelTestState =
  | { status: 'idle' }
  | { status: 'running'; configId: string; name: string; expectedRevision: number }
  | {
      status: 'success'
      configId: string
      name: string
      expectedRevision: number
      requestId: string
      data: ModelPingData
    }
  | {
      status: 'failure'
      configId: string
      name: string
      expectedRevision: number
      requestId: string
      code: string
      message: string
      retryable: boolean
    }

// 同步设置 running，避免 React 下一次渲染前的第二次点击又发一条请求。
// 实例保留在 renderer 内存；离开页面重进也不会创建第二个在途测试。
export class ModelTestController {
  private state: ModelTestState = { status: 'idle' }
  private listeners = new Set<() => void>()
  getSnapshot = (): ModelTestState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(state: ModelTestState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
  async run(
    model: { configId: string; name: string; revision: number },
    call: (id: string) => Promise<ApiResult<ModelPingData>>
  ): Promise<void> {
    if (this.state.status === 'running') return
    const target = { configId: model.configId, name: model.name, expectedRevision: model.revision }
    this.update({ status: 'running', ...target })
    try {
      const result = await call(model.configId)
      if (!result || typeof result.requestId !== 'string') throw new Error('invalid local response')
      if (result.ok) {
        if (!isModelPingData(result.data)) throw new Error('invalid local response')
        if (result.data.model.configId !== model.configId) {
          this.update({
            status: 'failure',
            ...target,
            requestId: result.requestId,
            code: 'MODEL_TEST_ID_MISMATCH',
            message: '响应不属于本次点击的配置',
            retryable: false
          })
          return
        }
        this.update({
          status: 'success',
          ...target,
          requestId: result.requestId,
          data: result.data
        })
      } else {
        if (
          !result.error ||
          typeof result.error.code !== 'string' ||
          typeof result.error.message !== 'string' ||
          typeof result.error.retryable !== 'boolean'
        )
          throw new Error('invalid local response')
        this.update({
          status: 'failure',
          ...target,
          requestId: result.requestId,
          code: result.error.code,
          message: result.error.message,
          retryable: result.error.retryable
        })
      }
    } catch {
      // 不将未知桥接异常或请求对象直接输出到页面/日志。
      this.update({
        status: 'failure',
        ...target,
        requestId: '未取得后端请求编号',
        code: 'LOCAL_SERVICE_UNAVAILABLE',
        message: '无法完成本地服务测试，请检查服务状态',
        retryable: true
      })
    }
  }
}
