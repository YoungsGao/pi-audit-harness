import { useEffect, useRef, useState } from 'react'
import type {
  AnalysisHistory,
  AnalysisSessionSummary,
  StreamFrame
} from '../../../shared/sse-contracts'
import { terminalEvents } from '../../../shared/sse-contracts'
import type { PathDetail, ScanStatistics } from '../../../shared/scan-contracts'
import { mergeAnalysisFrames, analysisErrorHelp } from '../../../shared/analysis-view'
import { publicAnalysisText, publicAnalysisValue } from '../../../shared/path-detail-view'
import { AnalysisTimeline } from './AnalysisTimeline'

const verdicts = {
  unknown: '未知，需要补证',
  safe: '当前路径已阻断',
  dangerous: '静态证据支持风险'
}
type ConnectionState = 'idle' | 'connecting' | 'streaming' | 'disconnected' | 'ended' | 'error'
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const connectionLabels: Record<ConnectionState, string> = {
  idle: '只读历史',
  connecting: '正在连接',
  streaming: '正在接收已落库事件',
  disconnected: '连接已主动断开，后台分析仍可继续',
  ended: '事件连接已结束',
  error: '连接异常，分析状态需核对'
}
export function AnalysisStreamPanel({
  projectId,
  runId,
  chainId,
  modelConfigId,
  disabled,
  detail,
  statistics,
  sourceStamp,
  rulesVersion,
  onUpdate
}: {
  projectId: string
  runId: string
  chainId: string
  modelConfigId: string
  disabled: boolean
  detail: PathDetail
  statistics: ScanStatistics | null
  sourceStamp: string
  rulesVersion: string
  onUpdate: () => void
}): React.JSX.Element {
  const [frames, setFrames] = useState<StreamFrame[]>([]),
    [state, setState] = useState<ConnectionState>('idle'),
    [error, setError] = useState(''),
    [historyError, setHistoryError] = useState(''),
    [sessions, setSessions] = useState<AnalysisSessionSummary[]>([]),
    [position, setPosition] = useState({ sessionId: '', cursor: 0 }),
    [historyChoice, setHistoryChoice] = useState(''),
    [historyRevision, refreshHistory] = useState(0),
    [historyLoading, setHistoryLoading] = useState(true),
    [expired, setExpired] = useState(false),
    [hasMore, setHasMore] = useState(false),
    [retries, setRetries] = useState(0)
  const session = useRef(''),
    cursor = useRef(0),
    connection = useRef(''),
    active = useRef(false),
    starting = useRef(false),
    receiving = useRef(false),
    generation = useRef(0),
    retired = useRef(new Set<string>()),
    update = useRef(onUpdate),
    originalModel = useRef('')
  useEffect(() => {
    update.current = onUpdate
  }, [onUpdate])
  useEffect(() => {
    active.current = true
    const unsubscribe = window.audit.onAnalysisStream((notice) => {
      if (!active.current || retired.current.has(notice.connectionId)) return
      if ('frame' in notice) {
        const frame = notice.frame,
          d = frame.data
        if (
          d.projectId !== projectId ||
          d.runId !== runId ||
          d.chainId !== chainId ||
          (session.current && session.current !== d.sessionId) ||
          (!starting.current && connection.current !== notice.connectionId)
        )
          return
        connection.current = notice.connectionId
        session.current = d.sessionId
        if (frame.id <= cursor.current) return
        cursor.current = frame.id
        setPosition({ sessionId: d.sessionId, cursor: frame.id })
        setFrames((previous) =>
          mergeAnalysisFrames(previous, [frame], { projectId, runId, chainId }, d.sessionId)
        )
        if (terminalEvents.has(frame.event)) update.current()
      } else if (
        connection.current === notice.connectionId ||
        (starting.current && !connection.current)
      ) {
        connection.current = notice.connectionId
        receiving.current = false
        setState('errorCode' in notice ? 'error' : 'ended')
        if ('errorCode' in notice)
          setError(notice.errorCode + '：' + analysisErrorHelp(notice.errorCode))
        refreshHistory((n) => n + 1)
        update.current()
      }
    })
    return () => {
      active.current = false
      unsubscribe()
      if (connection.current) void window.audit.stopAnalysisStream(connection.current)
    }
  }, [projectId, runId, chainId])
  useEffect(() => {
    let alive = true,
      reading = false
    const read = async (): Promise<void> => {
      if (reading || starting.current || receiving.current) return
      reading = true
      const version = generation.current
      try {
        const result = await window.audit.audit('history', {
          projectId,
          runId,
          pathId: chainId,
          ...(historyChoice ? { sessionId: historyChoice } : {})
        })
        if (!alive || version !== generation.current || receiving.current) return
        if (!result.ok) throw Error(result.error.code + '：' + result.error.message)
        let data = result.data as AnalysisHistory
        const collected = [...data.frames]
        const alreadyRead = session.current === data.selectedSessionId ? cursor.current : 0
        // Bounded hydration; longer histories have an explicit load-more button.
        for (let page = 1; data.hasMore && page < 4; page++) {
          const next = await window.audit.audit('history', {
            projectId,
            runId,
            pathId: chainId,
            sessionId: data.selectedSessionId,
            afterId: Math.max(data.nextAfterId, alreadyRead)
          })
          if (!alive || version !== generation.current || receiving.current) return
          if (!next.ok) throw Error(next.error.code + '：' + next.error.message)
          data = next.data as AnalysisHistory
          collected.push(...data.frames)
        }
        if (!alive || version !== generation.current) return
        setSessions(data.sessions)
        const id = data.selectedSessionId ?? ''
        originalModel.current = data.sessions.find((s) => s.sessionId === id)?.modelConfigId ?? ''
        session.current = id
        cursor.current = Math.max(data.nextAfterId, alreadyRead)
        setPosition({ sessionId: id, cursor: cursor.current })
        setFrames((previous) =>
          mergeAnalysisFrames(previous, collected, { projectId, runId, chainId }, id)
        )
        setHasMore(data.hasMore)
        setExpired((data.sessions.find((s) => s.sessionId === id)?.minEventId ?? 1) > 1)
        setHistoryError('')
      } catch (e) {
        if (alive && version === generation.current)
          setHistoryError(e instanceof Error ? e.message : '历史读取失败，请刷新状态')
      } finally {
        reading = false
        if (alive) setHistoryLoading(false)
      }
    }
    void read()
    const timer = setInterval(() => void read(), 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [projectId, runId, chainId, historyChoice, historyRevision])
  async function disconnect(): Promise<void> {
    generation.current++
    if (connection.current) {
      retired.current.add(connection.current)
      await window.audit.stopAnalysisStream(connection.current).catch(() => {})
    }
    connection.current = ''
    receiving.current = false
  }
  async function connect(replay: boolean): Promise<void> {
    if (starting.current || (replay && retries >= 2)) return
    starting.current = true
    receiving.current = true
    setError('')
    setState('connecting')
    await disconnect()
    receiving.current = true
    if (!replay) {
      session.current = ''
      cursor.current = 0
      originalModel.current = modelConfigId
      setFrames([])
      setPosition({ sessionId: '', cursor: 0 })
      setExpired(false)
      setRetries(0)
      setHistoryChoice('')
      setSessions([])
    } else setRetries((n) => n + 1)
    try {
      const result = await window.audit.startAnalysisStream({
        projectId,
        runId,
        chainId,
        modelConfigId: replay ? originalModel.current : modelConfigId,
        ...(replay ? { sessionId: session.current, afterId: cursor.current } : {})
      })
      if (!active.current) {
        if (result.ok) void window.audit.stopAnalysisStream(result.data.connectionId)
        return
      }
      if (!result.ok) {
        receiving.current = false
        setState('error')
        setError(
          result.error.code +
            '：' +
            result.error.message +
            ' ' +
            analysisErrorHelp(result.error.code)
        )
        update.current()
        return
      }
      connection.current = result.data.connectionId
      session.current = result.data.sessionId
      setPosition((p) => ({ ...p, sessionId: result.data.sessionId }))
      if (receiving.current) setState('streaming')
      update.current()
    } catch {
      if (active.current) {
        receiving.current = false
        setState('error')
        setError('SSE_CONNECT_FAILED：连接失败；请先刷新数据库状态，再按原游标重连。')
      }
    } finally {
      starting.current = false
    }
  }
  async function loadMore(): Promise<void> {
    const version = generation.current
    const result = await window.audit.audit('history', {
      projectId,
      runId,
      pathId: chainId,
      sessionId: session.current,
      afterId: cursor.current
    })
    if (!active.current || version !== generation.current) return
    if (!result.ok) {
      setError(result.error.code + '：' + result.error.message)
      return
    }
    const data = result.data as AnalysisHistory
    cursor.current = data.nextAfterId
    setPosition((p) => ({ ...p, cursor: data.nextAfterId }))
    setHasMore(data.hasMore)
    setFrames((p) =>
      mergeAnalysisFrames(p, data.frames, { projectId, runId, chainId }, session.current)
    )
  }
  const connected = state === 'connecting' || state === 'streaming'
  const terminal = [...frames].reverse().find((f) => terminalEvents.has(f.event))
  const selected = sessions.find((s) => s.sessionId === position.sessionId)
  const oldAttempt = !!selected && sessions[0]?.sessionId !== selected.sessionId
  function renderFrames(type: StreamFrame['data']['type']): React.JSX.Element {
    return (
      <ol>
        {frames
          .filter((f) => f.data.type === type)
          .map((f) => {
            const info = record(publicAnalysisValue(f.data.details)),
              payload = record(info.payload),
              input = record(payload.input)
            const failure = typeof payload.errorCode === 'string' ? payload.errorCode : ''
            return (
              <li key={f.data.sessionId + ':' + f.id}>
                <span className="audit-badge">
                  #{f.id} {f.event} / {f.data.status}
                </span>
                <p>
                  {publicAnalysisText(
                    f.data.message ??
                      (type === 'thinking' ? '模型未提供分析摘要' : '本事件未提供摘要')
                  )}
                </p>
                {typeof info.toolName === 'string' && (
                  <p>
                    取证工具：{info.toolName}
                    {typeof input.stepIndex === 'number' ? ` · 步骤 ${input.stepIndex + 1}` : ''}
                    {typeof info.durationMs === 'number'
                      ? ` · 耗时 ${Math.round(info.durationMs)} ms`
                      : ''}
                  </p>
                )}
                {type === 'result' && typeof payload.verdict === 'string' && (
                  <p>
                    本次尝试的风险判断：
                    {payload.verdict in verdicts
                      ? verdicts[payload.verdict as keyof typeof verdicts]
                      : payload.verdict}
                  </p>
                )}
                {failure && (
                  <p role="alert">
                    {failure}：{analysisErrorHelp(failure)}
                  </p>
                )}
                <details>
                  <summary>取证与事件详情</summary>
                  <pre>{JSON.stringify(info, null, 2)}</pre>
                </details>
              </li>
            )
          })}
      </ol>
    )
  }
  return (
    <section className="analysis-stream" aria-label="三段式分析流">
      <h3>调用链分析过程</h3>
      <p className="audit-id">
        projectId={projectId}
        <br />
        runId={runId}
        <br />
        chainId={chainId}
      </p>
      <div className="analysis-actions">
        <button
          data-testid="start-path-analysis"
          disabled={disabled || connected || historyLoading}
          onClick={() => void connect(false)}
        >
          {detail.status === 'failed' || detail.status === 'unresolved'
            ? '重新分析当前路径（新尝试）'
            : '开始分析当前路径'}
        </button>
        <button
          disabled={!position.sessionId || connected || retries >= 2}
          onClick={() => void connect(true)}
        >
          按原游标重连
        </button>
        <button
          disabled={!connected}
          onClick={() => {
            void disconnect()
            setState('disconnected')
          }}
        >
          断开事件连接
        </button>
        <button
          disabled={connected || historyLoading}
          onClick={() => {
            setError('')
            setRetries(0)
            refreshHistory((n) => n + 1)
          }}
        >
          刷新分析历史
        </button>
      </div>
      <p role="status" data-testid="analysis-connection">
        {connectionLabels[state]} · 重连 {retries}/2 · 会话 {position.sessionId || '尚未创建'} ·
        游标 {position.cursor}
      </p>
      {retries >= 2 && <p>本轮重连次数已用完。请检查本地服务，刷新分析历史核对状态后再连接。</p>}
      {error && (
        <p role="alert">
          {error}
          <br />
          projectId={projectId} / runId={runId} / chainId={chainId}
        </p>
      )}
      {historyError && (
        <p role="alert">
          历史状态未确认：{historyError}
          <br />
          projectId={projectId} / runId={runId} / chainId={chainId}
        </p>
      )}
      {expired && (
        <p role="alert">部分历史事件已过期，以下过程不完整；已提交结论仍从数据库读取。</p>
      )}
      <label>
        分析尝试（最近 20 次）
        <select
          aria-label="分析历史会话"
          value={position.sessionId}
          disabled={connected || historyLoading}
          onChange={(e) => {
            generation.current++
            session.current = e.target.value
            cursor.current = 0
            setFrames([])
            setPosition({ sessionId: e.target.value, cursor: 0 })
            setHistoryChoice(e.target.value)
            setRetries(0)
            setError('')
            setHistoryLoading(true)
          }}
        >
          <option value="" disabled>
            尚无分析会话
          </option>
          {position.sessionId && !selected && (
            <option value={position.sessionId}>当前会话 · 正在读取历史摘要</option>
          )}
          {sessions.map((s) => (
            <option key={s.sessionId} value={s.sessionId}>
              尝试 {s.attemptId} · {s.state} · {s.createdAt}
            </option>
          ))}
        </select>
      </label>
      <AnalysisTimeline frames={frames} />
      <div data-testid="analysis-stream-events" className="analysis-sections">
        <section aria-label="思考区域" data-testid="analysis-thinking">
          <h4>思考 · 当前目标与分析摘要</h4>
          <p>
            核查 {detail.ruleId}：从 {publicAnalysisText(detail.sourceRef ?? '待确认来源')} 到{' '}
            {publicAnalysisText(detail.steps.at(-1)?.edge.calledFunctionName ?? '候选 Sink')}{' '}
            的传播与防护。
          </p>
          <p className="muted">展示模型提供的分析摘要。缺少摘要时明确留空，不展示模型隐藏推理。</p>
          {frames.some((f) => f.data.type === 'thinking') ? (
            renderFrames('thinking')
          ) : (
            <p>尚未收到分析摘要。</p>
          )}
        </section>
        <section aria-label="过程区域" data-testid="analysis-process">
          <h4>过程 · 预处理、取证与状态</h4>
          <p>
            预处理已登记 {detail.steps.length} 个步骤 · 规则 {rulesVersion}
          </p>
          <p className="audit-id">源码指纹：{sourceStamp}</p>
          <p>
            数据库当前路径：{detail.status} · 已处理路径{' '}
            {statistics
              ? statistics.completed +
                statistics.failed +
                statistics.unresolved +
                statistics.invalid
              : '未读取'}{' '}
            / {statistics?.paths ?? '未读取'}
          </p>
          {renderFrames('process')}
        </section>
        <section aria-label="结果区域" data-testid="analysis-result">
          <h4>结果 · 结构化结论与数据库统计</h4>
          <p>
            {terminal
              ? terminal.event === 'completed'
                ? '当前会话分析已结束；未知结论仍需补证。'
                : '当前会话未成功完成，风险判断保持未知。'
              : '尚未收到当前会话最终结果，连接结束不能作为成功依据。'}
          </p>
          {renderFrames('result')}
          {oldAttempt && (
            <p>正在查看历史尝试；下方是当前路径最新数据库状态，不代表该历史尝试的结论。</p>
          )}
          <dl>
            <dt>最新路径状态</dt>
            <dd>{detail.status}</dd>
            <dt>最新风险判断</dt>
            <dd>{verdicts[detail.verdict]}</dd>
            <dt>最新结论摘要</dt>
            <dd>{publicAnalysisText(detail.summary || '尚无已提交结论')}</dd>
          </dl>
          {statistics && (
            <p>
              SQLite 任务统计：风险 {statistics.dangerous} · 阻断 {statistics.safe} · 未知{' '}
              {statistics.unknown} · 待办 {statistics.pending} · 分析中 {statistics.analyzing} ·
              失败 {statistics.failed}
            </p>
          )}
        </section>
      </div>
      {hasMore && (
        <button disabled={connected} onClick={() => void loadMore()}>
          继续读取后续事件
        </button>
      )}
      <p className="muted">
        页面保留最近 200 条事件；完整已保存事件留在
        SQLite。刷新历史与重连只读原会话，新尝试需明确点击重新分析；历史报告保留原快照。
      </p>
    </section>
  )
}
