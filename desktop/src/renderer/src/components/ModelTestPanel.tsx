import { useSyncExternalStore } from 'react'
import type { ModelRecord } from '../../../shared/metadata-contracts'
import { modelTestHint } from '../../../shared/model-test'
import { modelTestController } from '../model-test-controller'
export function ModelTestPanel({
  model,
  disabled,
  pendingSelection
}: {
  model: ModelRecord | null
  disabled: boolean
  pendingSelection: boolean
}): React.JSX.Element {
  const state = useSyncExternalStore(modelTestController.subscribe, modelTestController.getSnapshot)
  const running = state.status === 'running'
  const done = state.status === 'success' || state.status === 'failure'
  const belongs =
    done &&
    model?.configId === state.configId &&
    model.revision ===
      (state.status === 'success' ? state.data.model.revision : state.expectedRevision)
  return (
    <section aria-label="模型连接测试" className="model-test-panel">
      <h3>模型连接测试</h3>
      <p>只测试已保存的当前选择。点击才发送一次 ping，不携带项目源码；不会自动重试。</p>
      {!model && <p>请先保存配置，再在上方应用选择。</p>}
      {pendingSelection && <p role="status">下拉选择尚未应用，请先点击“应用选择”。</p>}
      <button
        type="button"
        disabled={disabled || running || !model || pendingSelection}
        onClick={() => {
          if (model) void modelTestController.run(model, (id) => window.audit.testModel(id))
        }}
      >
        {running ? '测试中…' : '测试当前模型'}
      </button>
      <p role="status" aria-live="polite" data-testid="model-test-status">
        {state.status === 'idle'
          ? '尚未测试'
          : state.status === 'running'
            ? `测试中：${state.name} / ${state.configId}`
            : state.status === 'success'
              ? `测试成功：收到非空文本回复 / ${state.data.latencyMs} ms`
              : `测试失败：${state.code}`}
      </p>
      {done && (
        <div>
          {!belongs && (
            <p role="note">以下是此前配置版本的结果，不代表当前选择已通过；请重新点击测试。</p>
          )}
          <p>
            本次点击配置：{state.name} / {state.configId} / 点击时 revision {state.expectedRevision}
          </p>
          <p>请求编号：{state.requestId}</p>
          {state.status === 'success' ? (
            <>
              <p>
                实际调用：{state.data.model.modelId} / revision {state.data.model.revision}
              </p>
              <p>耗时从后端发起操作开始计时，包含配置读取、会话准备与响应等待。</p>
              <pre aria-label="模型回复">{state.data.reply}</pre>
              <p>仅代表此次请求收到回复，不等于源码审计或工具调用质量已通过。</p>
            </>
          ) : (
            <div role="alert">
              <p>{state.message}</p>
              <p>{modelTestHint(state.code)}</p>
              <p>未判定连通成功；修正问题后可自行点击重试。</p>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
