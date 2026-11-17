import { randomUUID } from 'node:crypto'
import type { LocalDatabase, SqlSession, Row } from './database.ts'
import type {
  AnalyzeRequest,
  StreamFrame,
  StreamEventName,
  AnalysisHistory,
  AnalysisSessionSummary
} from '../../shared/sse-contracts'
import type { EventInput } from '../../shared/agent-contracts'
import { ApiError } from '../../shared/api-error.ts'

interface StreamProjection {
  sessionId: string
  id: number
  event: StreamEventName
  data: StreamFrame['data']
}
function project(
  tx: SqlSession,
  session: Row,
  event: StreamEventName,
  status: StreamFrame['data']['status'],
  type: StreamFrame['data']['type'],
  summary: string | null,
  details: unknown
): StreamProjection {
  const id = Number(
    tx.get(
      'SELECT COALESCE(MAX(session_seq),0)+1 AS n FROM audit_events WHERE session_id=?',
      session.session_id
    )!.n
  )
  tx.run(
    'UPDATE analysis_sessions SET state=?,finished_at=? WHERE session_id=?',
    status,
    ['queue', 'analyze'].includes(status) ? null : new Date().toISOString(),
    session.session_id
  )
  return {
    sessionId: String(session.session_id),
    id,
    event,
    data: {
      projectId: String(session.project_id),
      runId: String(session.run_id),
      chainId: String(session.chain_id),
      sessionId: String(session.session_id),
      attemptId: Number(session.attempt_id),
      type,
      status,
      message: summary,
      summaryMissing: !summary,
      details
    }
  }
}
export function createStreamSession(
  tx: SqlSession,
  projectId: string,
  runId: string,
  chainId: string,
  attempt: number,
  modelId: string
): string {
  const id = randomUUID(),
    time = new Date().toISOString()
  tx.run(
    "INSERT INTO analysis_sessions(session_id,project_id,run_id,chain_id,attempt_id,model_config_id,state,created_at) VALUES(?,?,?,?,?,?,'queue',?)",
    id,
    projectId,
    runId,
    chainId,
    attempt,
    modelId,
    time
  )
  const frame = project(
    tx,
    tx.get('SELECT * FROM analysis_sessions WHERE session_id=?', id)!,
    'queued',
    'queue',
    'process',
    '调用链进入队列',
    null
  )
  tx.run(
    `INSERT INTO audit_events(event_id,run_id,project_id,chain_id,time,type,summary,summary_missing,status,truncated,body_json,session_id,session_seq,stream_event)
    VALUES(?,?,?,?,?,'process',?,0,'queued',0,?,?,?,?)`,
    randomUUID(),
    runId,
    projectId,
    chainId,
    time,
    frame.data.message,
    JSON.stringify(frame.data),
    id,
    frame.id,
    frame.event
  )
  return id
}
// Project the same saved event into SSE, without a second event row or payload.
export function projectStreamEvent(
  tx: SqlSession,
  projectId: string,
  runId: string,
  chainId: string | null,
  event: EventInput,
  summary: string | null,
  payload: unknown,
  truncated: boolean
): StreamProjection | null {
  if (!chainId) return null
  const session = tx.get(
    "SELECT * FROM analysis_sessions WHERE project_id=? AND run_id=? AND chain_id=? AND state IN ('queue','analyze') ORDER BY attempt_id DESC LIMIT 1",
    projectId,
    runId,
    chainId
  )
  if (!session || (event.attemptId !== undefined && event.attemptId !== session.attempt_id))
    return null
  const details = {
    payload,
    toolCallId: event.toolCallId ?? null,
    toolName: event.toolName ?? null,
    durationMs: event.durationMs ?? null,
    truncated
  }
  if (event.status === 'analyzing' && session.state === 'queue')
    return project(tx, session, 'analyzing', 'analyze', 'process', summary, details)
  if (session.state !== 'analyze') return null
  if (event.type === 'process' && event.status === 'investigation_state')
    return project(tx, session, 'investigation_info', 'analyze', 'process', summary, details)
  if (event.type === 'process' && event.status === 'request_retry')
    return project(tx, session, 'request_info', 'analyze', 'process', summary, details)
  if (event.type === 'process' && event.status.startsWith('validation_'))
    return project(tx, session, 'validation_info', 'analyze', 'process', summary, details)
  if (event.type === 'tool')
    return project(tx, session, 'tool_call_info', 'analyze', 'process', summary, details)
  if (event.type === 'model')
    return project(tx, session, 'thoughts_execute', 'analyze', 'thinking', summary, details)
  if (event.type !== 'result') return null
  const code = String((payload as Record<string, unknown> | null)?.errorCode ?? '')
  const failed = event.status === 'failed' || event.status === 'interrupted'
  const timed = failed && /TIMEOUT|TIMED_OUT/.test(code)
  const stopped =
    code === 'RUN_USER_STOP' ||
    event.status === 'stopped' ||
    /AGENT_(?:NO_PROGRESS|ROUND_LIMIT|TOOL_LIMIT|REQUEST_LIMIT|EVIDENCE_LIMIT)/.test(code)
  return project(
    tx,
    session,
    timed ? 'timed_out' : stopped ? 'stopped' : failed ? 'failed' : 'completed',
    timed ? 'timeout' : stopped ? 'stop' : failed ? 'error' : 'completed',
    'result',
    summary,
    details
  )
}
export class StreamRepository {
  private readonly db: LocalDatabase
  constructor(db: LocalDatabase) {
    this.db = db
  }
  current(projectId: string, runId: string, chainId: string): Row | undefined {
    return this.db.get(
      'SELECT * FROM analysis_sessions WHERE project_id=? AND run_id=? AND chain_id=? ORDER BY attempt_id DESC LIMIT 1',
      projectId,
      runId,
      chainId
    )
  }
  session(input: AnalyzeRequest): Row {
    const row = this.db.get(
      'SELECT * FROM analysis_sessions WHERE session_id=?',
      input.sessionId ?? ''
    )
    if (
      !row ||
      row.project_id !== input.projectId ||
      row.run_id !== input.runId ||
      row.chain_id !== input.chainId ||
      row.model_config_id !== input.modelConfigId
    )
      throw new ApiError('SSE_SESSION_MISMATCH', '会话不存在或不属于当前项目、路径和模型', 409)
    const after = input.afterId ?? 0
    const last = Number(
      this.db.get(
        'SELECT COALESCE(MAX(session_seq),0) AS n FROM audit_events WHERE session_id=?',
        row.session_id
      )!.n
    )
    if (after < Number(row.min_event_id) - 1)
      throw new ApiError('SSE_HISTORY_EXPIRED', '历史事件已过期，请重新读取任务状态', 410)
    if (after > last) throw new ApiError('SSE_CURSOR_AHEAD', '事件游标超出当前会话', 409)
    return row
  }
  list(input: AnalyzeRequest): { frames: StreamFrame[]; terminal: boolean; lastEventId: number } {
    const session = this.session(input)
    const frames = this.db
      .all(
        'SELECT * FROM audit_events WHERE session_id=? AND session_seq>? ORDER BY session_seq LIMIT 50',
        session.session_id,
        input.afterId ?? 0
      )
      .map((r) => ({
        event: r.stream_event as StreamEventName,
        id: Number(r.session_seq),
        data: JSON.parse(String(r.body_json)) as StreamFrame['data']
      }))
    const lastEventId = Number(
      this.db.get(
        'SELECT COALESCE(MAX(session_seq),0) AS n FROM audit_events WHERE session_id=?',
        session.session_id
      )!.n
    )
    return { frames, terminal: !['queue', 'analyze'].includes(String(session.state)), lastEventId }
  }
  // Read-only history: opening a completed path must never claim another attempt.
  history(
    projectId: string,
    runId: string,
    pathId: string,
    sessionId?: string,
    afterId = 0
  ): AnalysisHistory {
    if (!Number.isSafeInteger(afterId) || afterId < 0)
      throw new ApiError('SSE_INVALID_CURSOR', '历史游标无效', 400)
    if (
      !this.db.get(
        'SELECT path_id FROM call_paths WHERE project_id=? AND run_id=? AND path_id=?',
        projectId,
        runId,
        pathId
      )
    )
      throw new ApiError('CHAIN_NOT_FOUND', '调用路径不存在', 404)
    const sessions: AnalysisSessionSummary[] = this.db
      .all(
        'SELECT * FROM analysis_sessions WHERE project_id=? AND run_id=? AND chain_id=? ORDER BY attempt_id DESC LIMIT 20',
        projectId,
        runId,
        pathId
      )
      .map((r) => ({
        sessionId: String(r.session_id),
        attemptId: Number(r.attempt_id),
        modelConfigId: String(r.model_config_id),
        state: r.state as AnalysisSessionSummary['state'],
        minEventId: Number(r.min_event_id),
        createdAt: String(r.created_at),
        finishedAt: r.finished_at === null ? null : String(r.finished_at)
      }))
    const selected = sessionId ? sessions.find((s) => s.sessionId === sessionId) : sessions[0]
    if (sessionId && !selected)
      throw new ApiError(
        'SSE_SESSION_MISMATCH',
        '历史会话不属于当前路径或已超出最近 20 次范围',
        409
      )
    if (!selected && afterId !== 0)
      throw new ApiError('SSE_CURSOR_AHEAD', '尚无会话，不能指定历史游标', 409)
    const cursor = Math.max(afterId, (selected?.minEventId ?? 1) - 1)
    const page = selected
      ? this.list({
          projectId,
          runId,
          chainId: pathId,
          modelConfigId: selected.modelConfigId,
          sessionId: selected.sessionId,
          afterId: cursor
        })
      : { frames: [], lastEventId: 0 }
    const nextAfterId = page.frames.at(-1)?.id ?? cursor
    return {
      projectId,
      runId,
      pathId,
      sessions,
      selectedSessionId: selected?.sessionId ?? null,
      frames: page.frames,
      nextAfterId,
      hasMore: nextAfterId < page.lastEventId,
      historyExpired: cursor > afterId
    }
  }
  expire(sessionId: string, throughId: number): void {
    if (!Number.isInteger(throughId) || throughId < 1)
      throw new ApiError('SSE_INVALID_CURSOR', '过期游标无效', 400)
    this.db.transaction((tx) => {
      const row = tx.get('SELECT * FROM analysis_sessions WHERE session_id=?', sessionId)
      if (!row || ['queue', 'analyze'].includes(String(row.state)))
        throw new ApiError('SSE_ACTIVE_SESSION', '只能清理已结束会话', 409)
      const last = Number(
        tx.get(
          'SELECT COALESCE(MAX(session_seq),0) AS n FROM audit_events WHERE session_id=?',
          sessionId
        )!.n
      )
      if (throughId >= last) throw new ApiError('SSE_INVALID_CURSOR', '保留终态事件供状态确认', 400)
      // Expire the SSE projection; keep the shared audit record for reports/diagnostics.
      tx.run(
        'UPDATE analysis_sessions SET min_event_id=max(min_event_id,?) WHERE session_id=?',
        throughId + 1,
        sessionId
      )
    })
  }
}
