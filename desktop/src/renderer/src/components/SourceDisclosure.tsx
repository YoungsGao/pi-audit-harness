import { useEffect, useState } from 'react'
import type { DisclosureScope } from '../../../shared/input-enhancements'

export function SourceDisclosure({
  projectId,
  runId,
  modelConfigId,
  onChange
}: {
  projectId: string
  runId: string
  modelConfigId: string
  onChange: (scope: DisclosureScope | null) => void
}): React.JSX.Element {
  const [scope, setScope] = useState<DisclosureScope | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(true),
    [revision, refresh] = useState(0),
    [cancelled, setCancelled] = useState(false)
  useEffect(() => {
    let active = true
    void window.audit
      .audit('disclosure', { projectId, runId, modelConfigId })
      .then((result) => {
        if (!active) return
        if (!result.ok) throw new Error(result.error.code + '：' + result.error.message)
        const data = result.data as DisclosureScope
        setScope(data)
        setError('')
        onChange(data.authorized ? data : null)
      })
      .catch((e: unknown) => {
        if (active) {
          setError(e instanceof Error ? e.message : '无法读取发送范围')
          onChange(null)
        }
      })
      .finally(() => {
        if (active) setBusy(false)
      })
    return () => {
      active = false
    }
  }, [projectId, runId, modelConfigId, onChange, revision])
  async function confirm(): Promise<void> {
    if (!scope || busy) return
    setBusy(true)
    try {
      const result = await window.audit.audit('authorize', {
        projectId,
        runId,
        modelConfigId,
        scopeKey: scope.scopeKey
      })
      if (!result.ok) throw new Error(result.error.code + '：' + result.error.message)
      const data = result.data as DisclosureScope
      setScope(data)
      onChange(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : '确认失败，请重新读取范围')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="input-help" aria-label="源码发送范围确认" data-testid="source-disclosure">
      <h3>源码发送范围确认</h3>
      {scope && <p>审查材料摘要：{scope.reviewContextHash}</p>}
      {busy && <p role="status">正在读取或保存发送范围…</p>}
      {error && <p role="alert">{error}</p>}
      {scope && !cancelled && (
        <>
          <p>
            目标服务：<strong>{scope.baseUrl}</strong>
          </p>
          <p>
            模型：{scope.modelId} · 配置 {scope.configId} · 版本 {scope.revision}
          </p>
          <p>
            项目：{scope.projectId} · 快照：{scope.snapshotId}
          </p>
          <p>
            授权文件范围：当前快照全部 {scope.fileCount} 个 Java 文件，共 {scope.totalBytes}{' '}
            字节；具体文件和忽略范围见上方快照清单。
          </p>
          <ul>
            {scope.categories.map((category) => (
              <li key={category}>{category}</li>
            ))}
          </ul>
          <p>
            按需发送片段；工具可能读取上述范围内的函数源码。相同范围可复用授权，快照、服务、模型或配置版本变化后需要重新确认。经
            OpenRouter 等中转服务时还可能转发至其上游供应商。
          </p>
          {scope.authorized ? (
            <p role="status" data-testid="disclosure-authorized">
              已确认此范围；开始分析仍由你主动触发。
            </p>
          ) : (
            <>
              <button
                type="button"
                className="button-primary"
                data-testid="confirm-source-disclosure"
                disabled={busy}
                onClick={() => void confirm()}
              >
                确认允许发送上述范围
              </button>
              <button type="button" disabled={busy} onClick={() => setCancelled(true)}>
                暂不发送
              </button>
            </>
          )}
        </>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setCancelled(false)
          setScope(null)
          setError('')
          setBusy(true)
          onChange(null)
          refresh((n) => n + 1)
        }}
      >
        重新查看发送范围
      </button>
    </section>
  )
}
