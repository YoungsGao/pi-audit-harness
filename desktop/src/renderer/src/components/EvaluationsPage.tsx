import { useEffect, useState } from 'react'
import type {
  EvaluationCatalog,
  EvaluationJob,
  EvaluationMode,
  EvaluationAction
} from '../../../shared/evaluation'
import { evaluationMetrics } from '../../../shared/evaluation'
import type { ModelCatalog } from '../../../shared/model-settings'

export function EvaluationsPage(): React.JSX.Element {
  const [catalog, setCatalog] = useState<EvaluationCatalog | null>(null),
    [models, setModels] = useState<ModelCatalog | null>(null),
    [jobs, setJobs] = useState<EvaluationJob[]>([])
  const [selected, setSelected] = useState(''),
    [job, setJob] = useState<EvaluationJob | null>(null),
    [mode, setMode] = useState<EvaluationMode>('engineering')
  const [caseIds, setCaseIds] = useState(['jdbc-concat', 'jdbc-bound', 'external-policy']),
    [trials, setTrials] = useState(1),
    [budget, setBudget] = useState(50000),
    [modelId, setModelId] = useState(''),
    [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  async function request<T>(action: EvaluationAction, value: unknown = {}): Promise<T> {
    const result = await window.audit.evaluations(action, value)
    if (!result.ok) throw Error(result.error.code + '：' + result.error.message)
    return result.data as T
  }
  useEffect(() => {
    let alive = true
    void Promise.all([
      request<EvaluationCatalog>('catalog'),
      request<{ jobs: EvaluationJob[] }>('list'),
      window.audit.getModelCatalog()
    ])
      .then(([c, list, m]) => {
        if (!alive) return
        setCatalog(c)
        setJobs(list.jobs)
        setSelected(list.jobs[0]?.id ?? '')
        if (m.ok) {
          setModels(m.data)
          setModelId(m.data.selection.configId ?? '')
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : '读取评测失败')
      })
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => {
    let alive = true,
      reading = false
    const read = async (): Promise<void> => {
      if (!selected || reading) return
      reading = true
      try {
        const [data, list] = await Promise.all([
          request<EvaluationJob>('detail', { id: selected }),
          request<{ jobs: EvaluationJob[] }>('list')
        ])
        if (alive) {
          setJob(data)
          setJobs(list.jobs)
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : '读取评测失败')
      } finally {
        reading = false
      }
    }
    void read()
    const timer = setInterval(() => void read(), 1500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [selected])
  const model = models?.models.find((m) => m.configId === modelId)
  const active =
    job?.state === 'running' || jobs.some((j) => j.state === 'running' && j.id !== job?.id)
  async function start(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const data = await request<EvaluationJob>('start', {
        mode,
        caseIds,
        trials,
        tokenBudget: budget,
        modelConfigId: modelId,
        modelRevision: model?.revision,
        allowPaid: consent
      })
      setSelected(data.id)
      setJob(data)
      setConsent(false)
      setJobs((old) => [data, ...old.filter((j) => j.id !== data.id)].slice(0, 20))
    } catch (e) {
      setError(e instanceof Error ? e.message : '启动失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="evaluations-page" data-testid="evaluations-page">
      <h2>对照评测中心</h2>
      <p>
        同一场景分别运行：A 只读步骤 → B 加 CodeGraph → C
        再加静态扫描。各组使用相同模型、提示版本、源码与单路径预算；只改变允许工具。
      </p>
      <fieldset disabled={busy || active}>
        <legend>新建对照实验</legend>
        <label>
          运行方式
          <select
            aria-label="评测运行方式"
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as EvaluationMode)
              setConsent(false)
            }}
          >
            <option value="engineering">工程回归 · 本地协议替身 · 无付费请求</option>
            <option value="live">真实模型 · 记录实际质量与用量</option>
          </select>
        </label>
        <div className="evaluation-cases">
          {catalog?.cases.map((c) => (
            <label key={c.id}>
              <input
                type="checkbox"
                checked={caseIds.includes(c.id)}
                onChange={(e) => {
                  setConsent(false)
                  setCaseIds((ids) =>
                    e.target.checked ? [...ids, c.id] : ids.filter((id) => id !== c.id)
                  )
                }}
              />
              {c.title} · 参考 {c.expected}
            </label>
          ))}
        </div>
        <label>
          每组重复次数
          <input
            aria-label="评测重复次数"
            type="number"
            min={1}
            max={3}
            value={trials}
            onChange={(e) => {
              setTrials(Number(e.target.value))
              setConsent(false)
            }}
          />
        </label>
        {mode === 'live' && (
          <>
            <label>
              已保存模型
              <select
                aria-label="评测模型"
                value={modelId}
                onChange={(e) => {
                  setModelId(e.target.value)
                  setConsent(false)
                }}
              >
                <option value="">请选择</option>
                {models?.models.map((m) => (
                  <option key={m.configId} value={m.configId}>
                    {m.name} · {m.modelId}
                  </option>
                ))}
              </select>
            </label>
            <label>
              总用量上限（Tokens）
              <input
                aria-label="评测Token预算"
                type="number"
                min={1000}
                max={500000}
                value={budget}
                onChange={(e) => {
                  setBudget(Number(e.target.value))
                  setConsent(false)
                }}
              />
            </label>
            <p>
              发送范围：所选固定原创 Java 样例，共 {caseIds.length * trials * 3} 次路径调查。目标：
              {model?.baseUrl ?? '尚未选择'}，模型 {model?.modelId ?? '未选择'}，配置版本{' '}
              {model?.revision ?? '—'}
              。共享预算覆盖三组；单次失败仍可能产生费用，缺失用量会保守占用预算。
            </p>
            <label>
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              确认发送上述样例并在本轮预算内调用模型
            </label>
          </>
        )}
        <button
          disabled={!caseIds.length || (mode === 'live' && (!model || !consent))}
          onClick={() => void start()}
        >
          开始三组对照
        </button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <label>
        历史实验
        <select
          aria-label="评测历史"
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value)
            setJob(null)
          }}
        >
          <option value="">尚未选择</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.createdAt} · {j.mode} · {j.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </label>
      {job && (
        <>
          <button
            onClick={() => {
              void window.audit
                .saveEvaluation(job.id)
                .catch((e: unknown) => setError(e instanceof Error ? e.message : '导出失败'))
            }}
          >
            导出本轮 JSON
          </button>
          <p role="status" data-testid="evaluation-status">
            {job.state} · 已运行 {job.rows.length}/{job.caseIds.length * job.trials * 3} 行 ·{' '}
            {job.current}
            {job.errorCode ? ` · ${job.errorCode}` : ''}
          </p>
          {job.state === 'running' && (
            <button
              onClick={() => {
                void request<EvaluationJob>('stop', { id: job.id })
                  .then(setJob)
                  .catch((e: unknown) => setError(e instanceof Error ? e.message : '停止失败'))
              }}
            >
              停止本轮评测
            </button>
          )}
          <p>
            {job.mode === 'engineering'
              ? '工程替身始终返回未知，只验证真实宿主、工具、持久化与校验链路；下列数据不代表模型检测准确率。'
              : `真实模型 ${job.model?.modelId}；已报告 ${job.reportedUsage} Tokens，未确认用量按上界占用 ${job.uncertainUsage}，当前预留 ${job.reserved}，上限 ${job.tokenBudget}。`}
          </p>
          <div className="table-scroll">
            <table data-testid="evaluation-comparison">
              <thead>
                <tr>
                  <th>组别</th>
                  <th>已运行</th>
                  <th>调查完成</th>
                  <th>参考一致</th>
                  <th>错误判安全</th>
                  <th>误报风险</th>
                  <th>完成未知</th>
                  <th>协议校验通过</th>
                  <th>报告用量</th>
                  <th>p50 / p95 ms</th>
                </tr>
              </thead>
              <tbody>
                {(['steps', 'codegraph', 'full'] as const).map((g, i) => {
                  const m = evaluationMetrics(job, g)
                  return (
                    <tr key={g}>
                      <th>{['A 只读步骤', 'B +CodeGraph', 'C +静态扫描'][i]}</th>
                      <td>{m.total}</td>
                      <td>{m.completed}</td>
                      <td>{m.agreement ?? '不评质量'}</td>
                      <td>{job.mode === 'live' ? m.falseSafe : '—'}</td>
                      <td>{job.mode === 'live' ? m.falseRisk : '—'}</td>
                      <td>{m.unknown}</td>
                      <td>{m.evidenceValid}</td>
                      <td>{job.mode === 'live' ? m.usage : '无付费请求'}</td>
                      <td>
                        {m.p50 ?? '—'} / {m.p95 ?? '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="muted">
            参考一致以完成行计数；失败、未找到候选、未知分别保留。证据合法表示引用与结构通过校验，不代表语义结论一定正确。扫描器不可用时
            C 组会如实记录。
          </p>
          <details>
            <summary>逐场景结果与实际操作摘要</summary>
            {job.rows.map((r, i) => (
              <details key={i}>
                <summary>
                  {r.caseId} / {r.group} / 第{r.trial}次 · {r.status} · {r.verdict ?? r.errorCode}
                </summary>
                <p>
                  参考 {r.expected} · 工具 {r.tools} · 请求 {r.requests} · 纠错 {r.repairs} · 扫描{' '}
                  {r.scanStatus ?? '未执行'} · {r.durationMs} ms
                </p>
                <p>源码摘要：{r.sourceDigest}</p>
                <ol>
                  {r.trace.map((t, n) => (
                    <li key={n}>
                      {t.status} {t.tool} {t.summary}
                    </li>
                  ))}
                </ol>
              </details>
            ))}
          </details>
          <details>
            <summary>实验版本与原始汇总 JSON</summary>
            <pre>{JSON.stringify(job, null, 2)}</pre>
          </details>
        </>
      )}
    </section>
  )
}
