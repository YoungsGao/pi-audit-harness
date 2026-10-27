import { useEffect, useRef, useState } from 'react'
import type { ReportCatalog, ReportRecord, ReportScope } from '../../../shared/report-contracts'
import { reportInput } from '../../../shared/report-contracts'
import type { ScanCatalog } from '../../../shared/scan-contracts'
import type { SourceProject } from '../../../shared/source-contracts'
import {
  detailSelectionKey,
  parseDetailSelection,
  publicAnalysisText
} from '../../../shared/path-detail-view'
import type { ApiResult } from '../../../shared/service-protocol'

const selectionKey = 'audit.reports.selection.v1'
function unwrap<T>(result: ApiResult<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}：${result.error.message}（请求 ${result.requestId}）`)
  return result.data
}
export function ReportsPage(): React.JSX.Element {
  const [saved] = useState<ReportScope | null>(() => {
    try {
      const own = localStorage.getItem(selectionKey)
      if (own && own.length < 400) return reportInput('list', JSON.parse(own))
      const detail = parseDetailSelection(localStorage.getItem(detailSelectionKey))
      return detail ? { projectId: detail.projectId, runId: detail.runId } : null
    } catch {
      return null
    }
  })
  const [projects, setProjects] = useState<SourceProject[]>([])
  const [projectId, setProjectId] = useState(''),
    [runId, setRunId] = useState('')
  const [runs, setRuns] = useState<ScanCatalog['runs']>([]),
    [catalog, setCatalog] = useState<ReportCatalog | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [readError, setReadError] = useState(''),
    [message, setMessage] = useState('选择已保存任务；生成报告不额外请求模型。')
  const [revision, refresh] = useState(0)
  const locked = useRef(false),
    mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    let alive = true
    void window.audit
      .listSources()
      .then((result) => {
        if (!alive) return
        const data = unwrap(result)
        setProjects(data.projects)
        setProjectId(
          data.projects.some((p) => p.projectId === saved?.projectId)
            ? saved!.projectId
            : (data.projects[0]?.projectId ?? '')
        )
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : '项目读取失败')
      })
    return () => {
      alive = false
      mounted.current = false
    }
  }, [saved])
  useEffect(() => {
    let alive = true
    if (projectId)
      void window.audit
        .audit('runs', { projectId })
        .then((result) => {
          if (!alive) return
          const data = unwrap(result) as ScanCatalog
          setRuns(data.runs)
          setRunId(
            data.runs.some((run) => run.runId === saved?.runId)
              ? saved!.runId
              : (data.runs[0]?.runId ?? '')
          )
        })
        .catch((e: unknown) => {
          if (alive) setReadError(e instanceof Error ? e.message : '任务读取失败')
        })
    return () => {
      alive = false
    }
  }, [projectId, saved])
  useEffect(() => {
    let alive = true,
      reading = false
    const read = async (): Promise<void> => {
      if (!projectId || !runId || reading) return
      reading = true
      try {
        const data = unwrap(
          await window.audit.reports('list', { projectId, runId })
        ) as ReportCatalog
        if (!alive) return
        setCatalog(data)
        setReadError('')
        try {
          localStorage.setItem(selectionKey, JSON.stringify({ projectId, runId }))
        } catch {
          /* Selection is optional; saved reports remain in SQLite. */
        }
      } catch (e) {
        if (alive) setReadError(e instanceof Error ? e.message : '报告列表读取失败')
      } finally {
        reading = false
      }
    }
    void read()
    const timer = setInterval(() => void read(), 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [projectId, runId, revision])
  async function act(work: () => Promise<string>): Promise<void> {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError('')
    try {
      const text = await work()
      if (mounted.current) setMessage(text)
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : '报告操作未确认成功')
    } finally {
      locked.current = false
      if (mounted.current) {
        setBusy(false)
        refresh((n) => n + 1)
      }
    }
  }
  return (
    <section className="card audit-page reports-page" aria-label="已登记审计报告">
      <h2>HTML 报告</h2>
      <p>
        按项目与任务从 SQLite 读取已保存结果，由 Pi /report 扩展生成独立
        HTML；不额外调用模型。存在待办、未知、失败或部分覆盖时标记为阶段报告。
      </p>
      <div className="audit-controls">
        <label>
          项目
          <select
            aria-label="报告项目"
            value={projectId}
            disabled={busy}
            onChange={(e) => {
              setProjectId(e.target.value)
              setRunId('')
              setRuns([])
              setCatalog(null)
              setReadError('')
              setError('')
            }}
          >
            <option value="">请选择项目</option>
            {projects.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.projectName}
              </option>
            ))}
          </select>
        </label>
        <label>
          任务
          <select
            aria-label="报告任务"
            value={runId}
            disabled={busy || !runs.length}
            onChange={(e) => {
              setRunId(e.target.value)
              setCatalog(null)
              setError('')
              setReadError('')
            }}
          >
            <option value="">尚无任务</option>
            {runs.map((run) => (
              <option key={run.runId} value={run.runId}>
                {run.runId.slice(0, 8)} · {new Date(run.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button
        className="button-primary"
        data-testid="generate-report"
        disabled={busy || !projectId || !runId || !!readError}
        onClick={() =>
          void act(async () => {
            const report = unwrap(
              await window.audit.reports('generate', { projectId, runId })
            ) as ReportRecord
            if (report.status !== 'ready')
              throw new Error(
                `报告生成失败：${report.errorCode ?? '状态未确认'} · reportId=${report.reportId}`
              )
            return `${report.stageReport ? '阶段报告' : '审计结果报告'}已登记：${report.reportId}`
          })
        }
      >
        {busy ? '报告操作进行中…' : '生成 HTML 报告'}
      </button>
      <button disabled={busy || !runId} onClick={() => refresh((n) => n + 1)}>
        刷新已登记报告
      </button>
      <p role="status" data-testid="report-message">
        {message}
      </p>
      <p className="audit-id">
        projectId={projectId || '未选择'} / runId={runId || '未选择'}
      </p>
      {error && (
        <p role="alert" data-testid="report-error">
          {publicAnalysisText(error)}
        </p>
      )}
      {readError && (
        <p role="alert">
          当前报告列表未确认：{publicAnalysisText(readError)}；下方仅为最近成功读取的登记记录。
        </p>
      )}
      {!projects.length && <p>请先导入项目；报告只读取已有任务，不会自行开始扫描或分析。</p>}
      {catalog && !catalog.reports.length && <p>该任务尚无已登记报告。</p>}
      {catalog && (
        <p className="muted">显示本任务最近 100 份登记；再次生成会创建新报告并保留旧报告。</p>
      )}
      <div data-testid="report-list">
        {catalog?.reports.map((report) => (
          <article className="report-record" key={report.reportId} data-report-id={report.reportId}>
            <h3>
              {report.stageReport === true
                ? '阶段报告'
                : report.stageReport === false
                  ? '审计结果报告'
                  : '报告类型尚未登记'}{' '}
              ·{' '}
              {report.status === 'ready'
                ? '已生成'
                : report.status === 'pending'
                  ? '生成中'
                  : '失败'}
            </h3>
            <p className="audit-id">
              reportId={report.reportId}
              <br />
              文件：{report.filePath}
            </p>
            <p>
              创建：{report.createdAt}；生成：{report.generatedAt ?? '尚未成功生成'}
            </p>
            {report.statistics ? (
              <p data-testid="report-statistics">
                危险路径 {report.statistics.dangerous} · 风险点{' '}
                {report.statistics.riskPoints ?? '旧记录未保存'} · 阻断 {report.statistics.safe} ·
                未知 {report.statistics.unknown} · 待分析 {report.statistics.pending} · 分析中{' '}
                {report.statistics.analyzing} · 证据不足 {report.statistics.unresolved} · 失败{' '}
                {report.statistics.failed}
              </p>
            ) : (
              <p>统计快照尚未保存。</p>
            )}
            {report.errorCode && <p role="alert">报告生成失败：{report.errorCode}</p>}
            <button
              data-testid="open-report"
              disabled={busy || report.status !== 'ready' || !report.sha256}
              onClick={() =>
                void act(async () => {
                  unwrap(
                    await window.audit.openReport({
                      projectId: report.projectId,
                      runId: report.runId,
                      reportId: report.reportId
                    })
                  )
                  return '已请求系统打开报告：' + report.reportId
                })
              }
            >
              打开已登记 HTML
            </button>
          </article>
        ))}
      </div>
      <p className="muted">
        登记成功表示生成时文件已验证。打开时还会核对归属与
        SHA-256；文件被删除或修改会提示重新生成。未知包含未分析等状态，不能与这些状态直接相加；步骤数量不作为漏洞数。
      </p>
    </section>
  )
}
