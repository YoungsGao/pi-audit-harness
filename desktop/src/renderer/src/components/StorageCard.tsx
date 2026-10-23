import { useState } from 'react'
import type { StorageOverview } from '../../../shared/storage-contracts'

export function StorageCard(): React.JSX.Element {
  const [overview, setOverview] = useState<StorageOverview | null>(null)
  const [message, setMessage] = useState('点击读取本地存储；新数据库的记录数为 0。')
  const [loading, setLoading] = useState(false)
  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      // 固定桥接方法；React 不导入 fs、SQLite、HTTP token 或任意 IPC 通道。
      const result = await window.audit.getStorageOverview()
      if (result.ok) {
        setOverview(result.data)
        setMessage('本地存储读取成功')
      } else {
        setOverview(null)
        setMessage(`${result.error.code}：${result.error.message}（请求 ${result.requestId}）`)
      }
    } catch {
      setOverview(null)
      setMessage('客户端桥接调用失败，请检查应用是否正常启动')
    } finally {
      setLoading(false)
    }
  }
  return (
    <section className="card" aria-label="本地存储">
      <h2>SQLite 本地存储</h2>
      <p role="status">{message}</p>
      <button type="button" disabled={loading} onClick={refresh}>
        {loading ? '读取中…' : '读取本地存储'}
      </button>
      {overview && (
        <div>
          <p>
            数据库：{overview.database.state} / schema {overview.database.schemaVersion} / WAL
          </p>
          <p>
            项目 {overview.counts.projects} / 任务 {overview.counts.runs} / 分析结果{' '}
            {overview.counts.results} / 报告元数据 {overview.counts.reports}
          </p>
          <p className="muted">各类仅展示最近 20 条。此阶段不提供导入、分析或报告生成操作。</p>
          <ul>
            {overview.projects.map((project) => (
              <li key={project.id}>
                项目：{project.name}（{project.id}）
              </li>
            ))}
          </ul>
          <ul>
            {overview.results.map((result) => (
              <li key={result.id}>
                结果：{result.verdict} / {result.summary}（{result.id}）
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
