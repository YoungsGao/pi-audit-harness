import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { SnapshotInfo } from '../../../shared/input-enhancements'

const rules = [
  ['JAVA-SQL-STATEMENT', 'SQL 注入'],
  ['JAVA-CMD-RUNTIME', '命令执行 Runtime'],
  ['JAVA-CMD-PROCESS-BUILDER', '命令执行 ProcessBuilder'],
  ['JAVA-PATH-FILES', '路径遍历 Files'],
  ['JAVA-PATH-STREAM', '路径遍历 Stream']
]
export function ManualRiskForm({
  projectId,
  runId,
  disabled,
  onSaved
}: {
  projectId: string
  runId: string
  disabled: boolean
  onSaved: (pathId: string) => void
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<SnapshotInfo | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, refresh] = useState(0),
    [message, setMessage] = useState('')
  const [filePath, setFile] = useState(''),
    [line, setLine] = useState('1'),
    [column, setColumn] = useState(''),
    [functionKey, setFunction] = useState(''),
    [ruleId, setRule] = useState(rules[0][0]),
    [note, setNote] = useState('')
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    let active = true
    void window.audit
      .audit('snapshot', { projectId, runId })
      .then((result) => {
        if (!active) return
        if (!result.ok) throw new Error(`${result.error.code}：${result.error.message}`)
        const data = result.data as SnapshotInfo
        setSnapshot(data)
        setError('')
        setFile(data.files[0]?.filePath ?? '')
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : '快照读取失败')
      })
    return () => {
      active = false
      mounted.current = false
    }
  }, [projectId, runId, revision])
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await window.audit.audit('manualRisk', {
        projectId,
        runId,
        filePath,
        line: Number(line),
        ...(column ? { column: Number(column) } : {}),
        ...(functionKey.trim() ? { functionKey: functionKey.trim() } : {}),
        ruleId,
        note: note.trim()
      })
      if (!mounted.current) return
      if (!result.ok)
        throw new Error(`${result.error.code}：${result.error.message}（请求 ${result.requestId}）`)
      const data = result.data as { pathIds: string[] }
      setMessage(`已登记 ${data.pathIds.length} 条待调查路径，尚未调用模型。`)
      onSaved(data.pathIds[0])
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : '登记失败')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <section className="card" aria-label="任务快照与手工风险点">
      <h2>任务快照与手工风险点</h2>
      {error && <p role="alert">{error}</p>}
      {message && (
        <p role="status" data-testid="manual-risk-message">
          {message}
        </p>
      )}
      {snapshot ? (
        <>
          <p data-testid="snapshot-id">
            只读快照：{snapshot.snapshotId} · {snapshot.files.length} 个 Java 文件
          </p>
          <p>
            内容指纹：{snapshot.sourceStamp} · commit：
            {snapshot.commit ?? '本地内容版本，以指纹标记'}
          </p>
          <details>
            <summary>查看文件摘要与忽略范围</summary>
            <ul>
              {snapshot.ignored.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <div className="snapshot-manifest">
              <table>
                <thead>
                  <tr>
                    <th>相对文件路径</th>
                    <th>SHA-256</th>
                    <th>字节数</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.files.map((file) => (
                    <tr key={file.filePath}>
                      <td>{file.filePath}</td>
                      <td>
                        <code>{file.sha256}</code>
                      </td>
                      <td>{file.size}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <details>
            <summary>补充手工风险点</summary>
            <p>
              调查位置来自此任务快照。自动扫描未命中的自定义 API
              也可以登记；登记后按统一流程取证，不直接判定存在漏洞。
            </p>
            <form onSubmit={(event) => void save(event)}>
              <fieldset disabled={disabled || busy}>
                <legend>需要调查的源码位置</legend>
                <label>
                  快照文件
                  <select
                    aria-label="手工风险文件"
                    value={filePath}
                    onChange={(event) => setFile(event.target.value)}
                  >
                    {snapshot.files.map((file) => (
                      <option key={file.filePath} value={file.filePath}>
                        {file.filePath}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="audit-controls">
                  <label>
                    行号
                    <input
                      aria-label="手工风险行号"
                      type="number"
                      min="1"
                      max="1000000"
                      required
                      value={line}
                      onChange={(event) => setLine(event.target.value)}
                    />
                  </label>
                  <label>
                    列号（可选）
                    <input
                      aria-label="手工风险列号"
                      type="number"
                      min="1"
                      max="1000000"
                      value={column}
                      onChange={(event) => setColumn(event.target.value)}
                    />
                  </label>
                </div>
                <label>
                  函数标识（可选，需与位置一致）
                  <input
                    aria-label="手工风险函数"
                    maxLength={1000}
                    value={functionKey}
                    onChange={(event) => setFunction(event.target.value)}
                  />
                </label>
                <label>
                  调查规则
                  <select
                    aria-label="手工风险规则"
                    value={ruleId}
                    onChange={(event) => setRule(event.target.value)}
                  >
                    {rules.map(([id, label]) => (
                      <option key={id} value={id}>
                        {label} · {id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  调查说明
                  <input
                    aria-label="手工风险说明"
                    maxLength={2000}
                    required
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                  />
                </label>
                <button type="submit" className="button-primary" data-testid="save-manual-risk">
                  {busy ? '正在登记…' : '加入待调查路径'}
                </button>
              </fieldset>
            </form>
          </details>
        </>
      ) : (
        <button type="button" onClick={() => refresh((n) => n + 1)}>
          重新读取快照
        </button>
      )}
    </section>
  )
}
