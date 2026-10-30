import { useEffect, useRef, useState } from 'react'
import type {
  ReportCatalog,
  ReportRecord,
  ReportScope,
  ReportFilter,
  ReportPreview,
  ReportFormat
} from '../../../shared/report-contracts'
import { reportInput, defaultReportFilter } from '../../../shared/report-contracts'
import { reviewStates, reviewLabels } from '../../../shared/review-contracts'
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
  const [filter, setFilter] = useState<ReportFilter>({ ...defaultReportFilter })
  const [preview, setPreview] = useState<ReportPreview | null>(null),
    [previewError, setPreviewError] = useState('')
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
  useEffect(() => {
    let alive = true,
      reading = false
    const read = async (): Promise<void> => {
      if (!projectId || !runId || reading) return
      reading = true
      try {
        const data = unwrap(
          await window.audit.reports('preview', { projectId, runId, filter })
        ) as ReportPreview
        if (alive) {
          setPreview(data)
          setPreviewError('')
        }
      } catch (e) {
        if (alive) {
          setPreview(null)
          setPreviewError(e instanceof Error ? e.message : '导出预览读取失败')
        }
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
  }, [projectId, runId, filter, revision])
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
  async function createReport(format: ReportFormat, save: boolean): Promise<string> {
    if (!preview) throw new Error('请先读取导出预览')
    const report = unwrap(
      await window.audit.reports('export', {
        projectId,
        runId,
        format,
        filter,
        expectedSnapshotKey: preview.snapshotKey
      })
    ) as ReportRecord
    if (report.status !== 'ready')
      throw new Error(
        report.errorCode === 'REPORT_SNAPSHOT_CHANGED'
          ? '保存结果或人工复核已变化，请刷新预览后重新生成'
          : `报告生成失败：${report.errorCode ?? '未确认'} · ${report.reportId}`
      )
    if (save) {
      const copied = unwrap(
        await window.audit.saveReport({ projectId, runId, reportId: report.reportId })
      )
      return copied.cancelled
        ? '已登记JSON结果；另存已取消，可在列表中再次另存'
        : 'JSON结果已另存：' + copied.savedPath
    }
    return `${report.stageReport ? '阶段报告' : '审计结果报告'}已登记：${report.reportId}`
  }
  return (
    <section className="card audit-page reports-page" aria-label="已登记审计报告">
      <h2>审计报告与结果导出</h2>
      <p>
        按项目与任务导出已保存结果，不额外调用模型。HTML 与 JSON
        同时保留机器判断、独立人工复核和覆盖缺口；未完成内容明确标为阶段结果。
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
              setPreview(null)
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
              setPreview(null)
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
      <fieldset className="report-filters" disabled={busy || !runId}>
        <legend>导出范围</legend>
        <label>
          机器结论
          <select
            aria-label="导出机器结论"
            value={filter.verdict}
            onChange={(event) => {
              setPreview(null)
              setFilter({ ...filter, verdict: event.target.value as ReportFilter['verdict'] })
            }}
          >
            {[
              ['all', '全部机器结论'],
              ['dangerous', '静态证据支持风险'],
              ['safe', '当前路径已阻断'],
              ['unknown', '风险未知']
            ].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          调查状态
          <select
            aria-label="导出调查状态"
            value={filter.pathStatus}
            onChange={(event) => {
              setPreview(null)
              setFilter({ ...filter, pathStatus: event.target.value as ReportFilter['pathStatus'] })
            }}
          >
            {[
              ['all', '全部调查状态'],
              ['pending', '待分析'],
              ['analyzing', '分析中'],
              ['completed', '已完成'],
              ['failed', '失败'],
              ['unresolved', '证据不足'],
              ['invalid', '无效调用链']
            ].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          人工复核
          <select
            aria-label="导出人工状态"
            value={filter.reviewStatus}
            onChange={(event) => {
              setPreview(null)
              setFilter({
                ...filter,
                reviewStatus: event.target.value as ReportFilter['reviewStatus']
              })
            }}
          >
            <option value="all">全部人工状态</option>
            {reviewStates.map((value) => (
              <option value={value} key={value}>
                {reviewLabels[value]}
              </option>
            ))}
          </select>
        </label>
      </fieldset>
      <div className="report-preview" data-testid="report-preview" aria-live="polite">
        {preview ? (
          <>
            <h3>{preview.stageReport ? '阶段结果预览' : '已保存结果预览'}</h3>
            <p>
              当前范围 {preview.statistics.paths} / 任务共 {preview.allStatistics.paths} 条路径
            </p>
            <div className="report-preview-counts">
              <span>
                机器风险 <strong>{preview.statistics.dangerous}</strong>
              </span>
              <span>
                机器阻断 <strong>{preview.statistics.safe}</strong>
              </span>
              <span>
                风险未知 <strong>{preview.statistics.unknown}</strong>
              </span>
              <span>
                人工确认 <strong>{preview.reviewCounts.confirmed}</strong>
              </span>
              <span>
                人工误报 <strong>{preview.reviewCounts.false_positive}</strong>
              </span>
            </div>
            {preview.stageReasons.length > 0 && (
              <details open>
                <summary>阶段与范围说明</summary>
                <ul>
                  {preview.stageReasons.map((reason) => (
                    <li key={reason}>{publicAnalysisText(reason)}</li>
                  ))}
                </ul>
              </details>
            )}
            <p className="muted">
              机器和人工统计相互独立。筛选无结果不表示安全；生成前会再次核对预览版本。
            </p>
          </>
        ) : (
          <p>{runId ? '正在读取保存结果预览…' : '选择一个任务后查看导出范围。'}</p>
        )}
        {previewError && <p role="alert">{publicAnalysisText(previewError)}</p>}
      </div>
      <button
        className="button-primary"
        data-testid="generate-report"
        disabled={busy || !projectId || !runId || !!readError || !preview}
        onClick={() => void act(() => createReport('html', false))}
      >
        {busy ? '报告操作进行中…' : '生成 HTML 报告'}
      </button>
      <button
        className="button-primary"
        data-testid="export-json"
        disabled={busy || !preview || !!readError}
        onClick={() => void act(() => createReport('json', true))}
      >
        导出 JSON 文件
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
              {report.format === 'json' ? 'JSON · ' : 'HTML · '}
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
            <p>
              本次范围 {report.statistics?.paths ?? '未记录'} / {report.totalPaths ?? '历史未记录'}{' '}
              条路径；人工确认 {report.reviewCounts?.confirmed ?? '未记录'}，人工误报{' '}
              {report.reviewCounts?.false_positive ?? '未记录'}
            </p>
            {report.stageReasons.length > 0 && (
              <details>
                <summary>阶段与结束原因</summary>
                <ul>
                  {report.stageReasons.map((reason) => (
                    <li key={reason}>{publicAnalysisText(reason)}</li>
                  ))}
                </ul>
              </details>
            )}
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
            {report.format === 'html' && (
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
            )}
            <button
              data-testid="save-report"
              disabled={busy || report.status !== 'ready' || !report.sha256}
              onClick={() =>
                void act(async () => {
                  const saved = unwrap(
                    await window.audit.saveReport({
                      projectId: report.projectId,
                      runId: report.runId,
                      reportId: report.reportId
                    })
                  )
                  return saved.cancelled ? '另存已取消' : '已另存：' + saved.savedPath
                })
              }
            >
              另存 {report.format.toUpperCase()}
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
