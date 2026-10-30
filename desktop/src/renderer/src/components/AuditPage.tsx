import { useCallback, useEffect, useRef, useState } from 'react'
import { SourceDisclosure } from './SourceDisclosure'
import { ManualRiskForm } from './ManualRiskForm'
import { AuditReviewEditor } from './AuditReviewEditor'
import type { ReviewSelection } from './AuditReviewEditor'
import { RunReviewPanel } from './RunReviewPanel'
import { RunControlPanel } from './RunControlPanel'
import type { DisclosureScope } from '../../../shared/input-enhancements'
import { AnalysisStreamPanel } from './AnalysisStreamPanel'
import { CallChainDetail } from './CallChainDetail'
import { detailSelectionKey, parseDetailSelection } from '../../../shared/path-detail-view'
import type { DetailTab } from '../../../shared/path-detail-view'
import type { RunState } from '../../../shared/agent-contracts'
import { analysisErrorHelp } from '../../../shared/analysis-view'
import type { SourceProject } from '../../../shared/source-contracts'
import type { ModelCatalog } from '../../../shared/model-settings'
import type { ApiResult } from '../../../shared/service-protocol'
import type {
  AuditAction,
  AuditData,
  ScanRun,
  ScanCatalog,
  ScanStatistics,
  PathList,
  PathDetail,
  PreparedScan,
  PathStatus
} from '../../../shared/scan-contracts'

function unwrap<T>(result: ApiResult<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}：${result.error.message}（请求 ${result.requestId}）`)
  return result.data
}
async function request<T extends AuditData>(action: AuditAction, input: unknown): Promise<T> {
  return unwrap(await window.audit.audit(action, input)) as T
}
const statusLabel: Record<PathStatus, string> = {
  pending: '待分析',
  analyzing: '分析中',
  completed: '已完成',
  failed: '失败',
  unresolved: '证据不足',
  invalid: '无效调用链'
}
const scanLabel: Record<string, string> = {
  scanning: '预处理中',
  ready: '预处理完成',
  partial: '部分完成',
  empty: '零命中',
  failed: '预处理失败'
}
const verdictLabel = { unknown: '未知', safe: '当前路径已阻断', dangerous: '静态证据支持风险' }
export function AuditPage(): React.JSX.Element {
  const [reviewSelection, setReviewSelection] = useState<
    (ReviewSelection & { projectId: string }) | null
  >(null)
  const [disclosure, setDisclosure] = useState<DisclosureScope | null>(null)
  const onDisclosureChange = useCallback(
    (scope: DisclosureScope | null) => setDisclosure(scope),
    []
  )
  const [initialSelection] = useState(() => {
    try {
      return parseDetailSelection(localStorage.getItem(detailSelectionKey))
    } catch {
      return null
    }
  })
  const restoreSelection = useRef(initialSelection)
  const [detailTab, setDetailTab] = useState<DetailTab>(initialSelection?.tab ?? 'path')
  const [projects, setProjects] = useState<SourceProject[]>([]),
    [models, setModels] = useState<ModelCatalog | null>(null)
  const [projectId, setProjectId] = useState(''),
    [runId, setRunId] = useState(''),
    [pathId, setPathId] = useState(''),
    [modelId, setModelId] = useState('')
  const [runs, setRuns] = useState<ScanRun[]>([]),
    [listing, setListing] = useState<PathList | null>(null),
    [stats, setStats] = useState<ScanStatistics | null>(null),
    [detail, setDetail] = useState<PathDetail | null>(null),
    [runState, setRunState] = useState<RunState | null>(null),
    [readError, setReadError] = useState(''),
    [readAt, setReadAt] = useState('')
  const [offset, setOffset] = useState(0),
    [revision, refresh] = useState(0),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('选择已登记项目，预处理生成调用链；不会自动调用模型。'),
    [error, setError] = useState('')
  const mounted = useRef(false),
    locked = useRef(false),
    selectionEpoch = useRef(0)
  useEffect(() => {
    mounted.current = true
    let active = true
    void Promise.all([window.audit.listSources(), window.audit.getModelCatalog()])
      .then(([sources, catalog]) => {
        if (!active) return
        setProjects(unwrap(sources).projects)
        const data = unwrap(catalog)
        setModels(data)
        setModelId(data.selection.configId ?? '')
        if (
          initialSelection &&
          unwrap(sources).projects.some((p) => p.projectId === initialSelection.projectId)
        )
          setProjectId(initialSelection.projectId)
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : '读取项目与模型失败')
      })
    return () => {
      active = false
      mounted.current = false
    }
  }, [initialSelection])
  useEffect(() => {
    let active = true
    const epoch = selectionEpoch.current
    if (projectId)
      void request<ScanCatalog>('runs', { projectId })
        .then(async (data) => {
          if (!active || epoch !== selectionEpoch.current) return
          const saved =
            restoreSelection.current?.projectId === projectId ? restoreSelection.current : null
          const restoredRun = data.runs.find((run) => run.runId === saved?.runId)
          let restoredPath = ''
          if (restoredRun && saved) {
            try {
              await request<PathDetail>('detail', {
                projectId,
                runId: restoredRun.runId,
                pathId: saved.pathId
              })
              restoredPath = saved.pathId
            } catch (e) {
              if (!(e instanceof Error && e.message.startsWith('CHAIN_NOT_FOUND：'))) throw e
            }
          }
          if (!active || epoch !== selectionEpoch.current) return
          restoreSelection.current = null
          setRuns(data.runs)
          setRunId(restoredRun?.runId ?? data.runs[0]?.runId ?? '')
          setPathId(restoredPath)
        })
        .catch((e: unknown) => {
          if (active) setError(e instanceof Error ? e.message : '读取任务失败')
        })
    return () => {
      active = false
    }
  }, [projectId])
  useEffect(() => {
    if (
      !detail ||
      detail.projectId !== projectId ||
      detail.runId !== runId ||
      detail.pathId !== pathId
    )
      return
    try {
      localStorage.setItem(
        detailSelectionKey,
        JSON.stringify({ projectId, runId, pathId, tab: detailTab })
      )
    } catch {
      // Storage can be disabled; SQLite history remains available through explicit selection.
    }
  }, [projectId, runId, pathId, detailTab, detail])
  useEffect(() => {
    let active = true,
      inFlight = false
    const read = async (): Promise<void> => {
      if (!projectId || !runId || inFlight) return
      inFlight = true
      try {
        const [paths, totals, history, current, state] = await Promise.all([
          request<PathList>('list', { projectId, runId, limit: 20, offset }),
          request<ScanStatistics>('statistics', { projectId, runId }),
          request<ScanCatalog>('runs', { projectId }),
          pathId
            ? request<PathDetail>('detail', { projectId, runId, pathId })
            : Promise.resolve(null),
          request<RunState>('runState', { projectId, runId })
        ])
        if (!active) return
        setListing(paths)
        setStats(totals)
        setRuns(history.runs)
        setDetail(current)
        setRunState(state)
        setReadError('')
        setReadAt(new Date().toLocaleTimeString())
        if (totals.analyzing === 0)
          setMessage((previous) =>
            previous.startsWith('后端正在串行')
              ? `本批待办处理已结束：失败 ${totals.failed} 条，仍待分析 ${totals.pending} 条；风险未知 ${totals.unknown} 条。`
              : previous
          )
        if (current && current.status !== 'analyzing')
          setMessage((previous) =>
            previous.startsWith('路径已由后端领取')
              ? `当前路径审阅已结束：${statusLabel[current.status]}。结果与统计已从数据库读取。`
              : previous
          )
        if (!pathId && paths.paths[0]) setPathId(paths.paths[0].pathId)
      } catch (e) {
        if (active)
          setReadError(
            (e instanceof Error ? e.message : '读取调用链失败') +
              ` · projectId=${projectId} / runId=${runId} / chainId=${pathId || '未选择'}`
          )
      } finally {
        inFlight = false
      }
    }
    void read()
    const timer = setInterval(() => {
      void read()
    }, 2000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [projectId, runId, pathId, offset, revision])
  async function action(work: () => Promise<void>): Promise<void> {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (e) {
      if (mounted.current) {
        setError(
          (e instanceof Error ? e.message : '操作失败') +
            ` · projectId=${projectId || '尚未生成'} / runId=${runId || '尚未生成'} / chainId=${pathId || '尚未生成'}`
        )
        setMessage('本次操作未确认成功。请查看错误原因并刷新数据库状态。')
        refresh((n) => n + 1)
        if (projectId)
          void request<ScanCatalog>('runs', { projectId })
            .then((data) => {
              if (mounted.current) setRuns(data.runs)
            })
            .catch(() => {})
      }
    } finally {
      locked.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const onReviewChange = useCallback(
    (selection: ReviewSelection | null) =>
      setReviewSelection(selection ? { ...selection, projectId } : null),
    [projectId]
  )
  const selectedRun = runs.find((run) => run.runId === runId)
  const canSend =
    disclosure?.authorized === true &&
    disclosure.projectId === projectId &&
    disclosure.runId === runId &&
    disclosure.configId === modelId
  return (
    <div className="audit-page">
      <section className="card" aria-label="审计工作台">
        <div className="audit-heading">
          <div>
            <h2>项目调用链</h2>
            <p className="muted">从实际源码生成候选路径，保留每条路径的独立证据与结论。</p>
          </div>
          <button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const [sources, catalog] = await Promise.all([
                  window.audit.listSources(),
                  window.audit.getModelCatalog()
                ])
                if (!mounted.current) return
                setProjects(unwrap(sources).projects)
                setModels(unwrap(catalog))
                refresh((n) => n + 1)
                setMessage('已刷新项目、模型和数据库状态')
              })
            }
          >
            刷新项目与状态
          </button>
        </div>
        <div className="audit-controls">
          <label>
            源码项目
            <select
              aria-label="审计项目"
              value={projectId}
              disabled={busy}
              onChange={(e) => {
                restoreSelection.current = null
                selectionEpoch.current++
                setProjectId(e.target.value)
                setRunId('')
                setPathId('')
                setRuns([])
                setListing(null)
                setStats(null)
                setDetail(null)
                setRunState(null)
                setReadError('')
                setReadAt('')
                setOffset(0)
                setError('')
              }}
            >
              <option value="">请选择已登记项目</option>
              {projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.projectName} · {p.projectId.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label>
            分析任务
            <select
              aria-label="审计任务"
              value={runId}
              disabled={busy || !runs.length}
              onChange={(e) => {
                setRunId(e.target.value)
                setPathId('')
                setDetail(null)
                setListing(null)
                setStats(null)
                setRunState(null)
                setReadError('')
                setReadAt('')
                setOffset(0)
              }}
            >
              <option value="">尚无任务</option>
              {runs.map((r) => (
                <option key={r.runId} value={r.runId}>
                  {scanLabel[r.state]} · {new Date(r.createdAt).toLocaleString()} ·{' '}
                  {r.runId.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {projectId && (
          <AuditReviewEditor
            key={projectId}
            projectId={projectId}
            disabled={busy}
            onChange={onReviewChange}
          />
        )}
        <button
          className="button-primary"
          disabled={
            busy ||
            !projectId ||
            selectedRun?.state === 'scanning' ||
            reviewSelection?.projectId !== projectId
          }
          onClick={() =>
            void action(async () => {
              setMessage('正在校验源码、提取调用并写入候选队列…')
              const prepared = await request<PreparedScan>('prepare', {
                projectId,
                templateRefs: reviewSelection?.templateRefs,
                projectReviewRevision: reviewSelection?.projectReviewRevision
              })
              if (!mounted.current) return
              const history = await request<ScanCatalog>('runs', { projectId })
              selectionEpoch.current++
              setRuns(history.runs)
              setRunId(prepared.runId)
              setPathId('')
              setDetail(null)
              setOffset(0)
              refresh((n) => n + 1)
              setMessage(
                `${scanLabel[prepared.state]}：${prepared.candidateCount} 个候选 Sink，${prepared.pathIds.length} 条待调查路径。`
              )
            })
          }
        >
          {busy ? '操作进行中…' : '预处理并生成调用链'}
        </button>
        <p role="status" data-testid="audit-message">
          {message}
        </p>
        {error && <p role="alert">{error}</p>}
        {!projects.length && <p className="muted">先到项目管理导入 Java 源码，再刷新项目列表。</p>}
        {selectedRun && (
          <div className="audit-run-meta">
            <span className="audit-badge">{scanLabel[selectedRun.state]}</span>
            <span>规则：{selectedRun.rulesVersion}</span>
            <p>源码指纹：{selectedRun.sourceStamp}</p>
            {selectedRun.errorCode && (
              <p role="alert">
                {selectedRun.errorCode} · {analysisErrorHelp(selectedRun.errorCode)}
                <br />
                projectId={projectId} / runId={runId}
              </p>
            )}
            <ul>
              {selectedRun.warnings.map((w, i) => (
                <li key={i}>
                  {w.code}：{w.filePath ? w.filePath + ' · ' : ''}
                  {w.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      {projectId && runId && (
        <RunReviewPanel
          key={'review:' + projectId + ':' + runId}
          projectId={projectId}
          runId={runId}
        />
      )}
      {projectId && runId && (
        <ManualRiskForm
          key={'manual:' + projectId + ':' + runId}
          projectId={projectId}
          runId={runId}
          disabled={busy || !!stats?.analyzing || selectedRun?.state === 'failed'}
          onSaved={(id) => {
            setPathId(id)
            setOffset(0)
            refresh((n) => n + 1)
          }}
        />
      )}
      {runState && (
        <p data-testid="audit-run-state">
          任务阶段：{runState.stage} · 状态：{runState.status} · 最近成功读取：{readAt}
        </p>
      )}
      {projectId && runId && (
        <RunControlPanel
          key={'control:' + projectId + ':' + runId}
          projectId={projectId}
          runId={runId}
          onChanged={() => refresh((n) => n + 1)}
        />
      )}
      {readError && (
        <p role="alert" data-testid="audit-read-error">
          当前数据库状态未确认：{readError}
          <br />
          下方仅为上次成功读取的快照，不能据此认定任务仍在运行或已完成。请检查服务与磁盘后刷新。
        </p>
      )}
      {stats && (
        <section className="audit-stats" aria-label="调用链统计" data-testid="audit-statistics">
          {(
            [
              ['候选路径', stats.paths],
              ['独立 Sink', stats.sinks],
              ['风险路径', stats.dangerous],
              ['已阻断路径', stats.safe],
              ['未知路径', stats.unknown],
              ['待分析', stats.pending],
              ['分析中', stats.analyzing]
            ] as const
          ).map(([label, n]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{n}</strong>
            </div>
          ))}
          <p>统计来自 SQLite；未知或未完成路径不会计入安全，步骤数量不作为风险数量。</p>
        </section>
      )}
      <div className="audit-layout">
        <section className="card audit-list" aria-label="调用链列表">
          <h2>调用链列表</h2>
          {!listing?.paths.length ? (
            <p>
              {selectedRun?.state === 'empty'
                ? '本次支持范围内零命中；不代表整个项目安全。'
                : '当前没有可展示的路径。'}
            </p>
          ) : (
            <>
              <div className="audit-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>路径 / 规则</th>
                      <th>调查状态</th>
                      <th>风险判断</th>
                      <th>覆盖情况</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listing.paths.map((p) => (
                      <tr key={p.pathId} aria-selected={p.pathId === pathId}>
                        <td>
                          <button
                            aria-label={'查看调用链 ' + p.pathId}
                            onClick={() => {
                              setPathId(p.pathId)
                              setDetail(null)
                            }}
                          >
                            {p.pathId.slice(0, 15)}
                          </button>
                          <small>{p.ruleId}</small>
                        </td>
                        <td>
                          <span className={'audit-badge ' + p.status}>{statusLabel[p.status]}</span>
                        </td>
                        <td>{verdictLabel[p.verdict]}</td>
                        <td>
                          {p.truncated ? '部分覆盖 · ' + p.truncationReason : '已展开候选路径'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="audit-pager">
                <button
                  disabled={offset === 0}
                  onClick={() => {
                    setOffset(Math.max(0, offset - 20))
                    setPathId('')
                    setDetail(null)
                  }}
                >
                  上一页
                </button>
                <span>
                  {offset + 1}–{offset + listing.paths.length} / {listing.total}
                </span>
                <button
                  disabled={offset + 20 >= listing.total}
                  onClick={() => {
                    setOffset(offset + 20)
                    setPathId('')
                    setDetail(null)
                  }}
                >
                  下一页
                </button>
              </div>
            </>
          )}
        </section>
        <section className="card audit-detail" aria-label="调用链简要详情">
          <h2>路径详情</h2>
          {detail ? (
            <>
              <CallChainDetail
                detail={detail}
                tab={detailTab}
                onTabChange={setDetailTab}
                paths={listing?.paths ?? []}
                onSelectPath={(selected) => {
                  setPathId(selected)
                  setDetail(null)
                  setDetailTab('path')
                }}
              >
                <label>
                  本次分析模型
                  <select
                    aria-label="路径分析模型"
                    value={modelId}
                    disabled={busy || stats?.analyzing !== 0}
                    onChange={(e) => setModelId(e.target.value)}
                  >
                    <option value="">请选择已保存配置</option>
                    {models?.models.map((m) => (
                      <option value={m.configId} key={m.configId}>
                        {m.name} · {m.modelId}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="muted">
                  开始后将通过 Pi
                  受控工具读取源码并发送给所选模型，在预算内循环补证。分析待办队列会串行处理当前任务的
                  pending 路径；失败后停止，剩余待办保留。
                </p>
                <AnalysisStreamPanel
                  key={runId + ':' + detail.pathId}
                  projectId={projectId}
                  runId={runId}
                  chainId={detail.pathId}
                  modelConfigId={modelId}
                  detail={detail}
                  statistics={stats}
                  sourceStamp={selectedRun?.sourceStamp ?? ''}
                  rulesVersion={selectedRun?.rulesVersion ?? ''}
                  disabled={
                    busy ||
                    !!readError ||
                    !modelId ||
                    !canSend ||
                    !!stats?.analyzing ||
                    !['pending', 'failed', 'unresolved'].includes(detail.status)
                  }
                  onUpdate={() => refresh((n) => n + 1)}
                />
                {modelId && (
                  <SourceDisclosure
                    key={projectId + ':' + runId + ':' + modelId}
                    projectId={projectId}
                    runId={runId}
                    modelConfigId={modelId}
                    onChange={onDisclosureChange}
                  />
                )}
                <button
                  disabled={
                    busy ||
                    !!readError ||
                    !modelId ||
                    !canSend ||
                    !!stats?.analyzing ||
                    !stats?.pending
                  }
                  data-testid="start-pending-analysis"
                  onClick={() =>
                    void action(async () => {
                      await request('analyzePending', {
                        projectId,
                        runId,
                        modelConfigId: modelId,
                        maxPaths: 10
                      })
                      if (mounted.current) {
                        setMessage('后端正在串行处理待办路径，每次最多 10 条。')
                        refresh((n) => n + 1)
                      }
                    })
                  }
                >
                  分析本任务待办路径（最多 10 条）
                </button>
              </CallChainDetail>
            </>
          ) : (
            <p>选择一条调用链查看函数顺序、源码位置和覆盖限制。</p>
          )}
        </section>
      </div>
    </div>
  )
}
