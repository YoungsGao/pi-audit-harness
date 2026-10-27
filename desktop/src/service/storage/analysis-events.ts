import { randomUUID } from 'node:crypto'
import type { AnalysisEvents, EventInput } from '../../shared/agent-contracts'
import type { LocalDatabase, SqlSession } from './database.ts'
import { ApiError } from '../../shared/api-error.ts'
import { mirrorStreamEvent } from './stream-events.ts'

// Only bounded, redacted operational data. Never store prompts or hidden reasoning.
export function redact(text: string, secrets: string[] = []): string {
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]')
  return text
    .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(
      /((?:api[_-]?key|password|authorization|secret|token)\s*[=:]\s*["']?)[^\s"',;}]+/gi,
      '$1[REDACTED]'
    )
}
export function boundedLog(
  value: unknown,
  secrets: string[] = []
): { value: unknown; truncated: boolean } {
  let truncated = false
  const visit = (v: unknown, depth: number): unknown => {
    if (depth > 5) {
      truncated = true
      return '[TRUNCATED]'
    }
    if (typeof v === 'string') {
      const clean = redact(v, secrets)
      if (Buffer.byteLength(clean) > 2048) {
        truncated = true
        return Buffer.from(clean).subarray(0, 2048).toString('utf8') + '…'
      }
      return clean
    }
    if (Array.isArray(v)) {
      if (v.length > 20) truncated = true
      return v.slice(0, 20).map((x) => visit(x, depth + 1))
    }
    if (v && typeof v === 'object') {
      const pairs = Object.entries(v)
      if (pairs.length > 30) truncated = true
      return Object.fromEntries(
        pairs
          .slice(0, 30)
          .map(([k, x]) => [
            k.slice(0, 100),
            /api.?key|secret|password|authorization|token/i.test(k)
              ? '[REDACTED]'
              : visit(x, depth + 1)
          ])
      )
    }
    return v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
      ? v
      : null
  }
  let safe = visit(value, 0)
  if (Buffer.byteLength(JSON.stringify(safe)) > 8192) {
    safe = { omitted: 'payload exceeded 8KiB' }
    truncated = true
  }
  return { value: safe, truncated }
}
export function appendEvent(
  tx: SqlSession,
  projectId: string,
  runId: string,
  chainId: string | null,
  event: EventInput
): void {
  const safe = boundedLog({ summary: event.summary ?? null, payload: event.payload ?? null })
  const body = safe.value as { summary: string | null; payload: unknown }
  const seq = Number(
    tx.get('SELECT COALESCE(MAX(seq),0)+1 AS n FROM analysis_events WHERE run_id=?', runId)!.n
  )
  tx.run(
    `INSERT INTO analysis_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    randomUUID(),
    runId,
    projectId,
    chainId,
    seq,
    new Date().toISOString(),
    event.type,
    body.summary ?? null,
    Number(!body.summary),
    event.toolCallId?.slice(0, 100) ?? null,
    event.toolName?.slice(0, 100) ?? null,
    event.status.slice(0, 100),
    event.durationMs === undefined ? null : Math.max(0, Math.round(event.durationMs)),
    JSON.stringify(body.payload ?? null),
    Number(safe.truncated || event.truncated === true)
  )
  mirrorStreamEvent(
    tx,
    projectId,
    runId,
    chainId,
    event,
    body.summary ?? null,
    body.payload ?? null,
    safe.truncated || event.truncated === true
  )
}
export class AnalysisEventRepository {
  private readonly db: LocalDatabase
  constructor(db: LocalDatabase) {
    this.db = db
  }
  append(projectId: string, runId: string, chainId: string | null, event: EventInput): void {
    this.db.transaction((tx) => {
      if (event.attemptId !== undefined) {
        const current = tx.get(
          'SELECT attempt,phase FROM path_attempts WHERE path_id=? AND run_id=? AND project_id=?',
          chainId,
          runId,
          projectId
        )
        if (!current || current.attempt !== event.attemptId || current.phase !== 'analyzing')
          throw new ApiError('ANALYSIS_STALE', '旧尝试事件不能覆盖当前状态', 409)
      }
      appendEvent(tx, projectId, runId, chainId, event)
    })
  }
  list(
    projectId: string,
    runId: string,
    pathId: string | null,
    afterSeq = 0,
    limit = 50
  ): AnalysisEvents {
    if (
      !Number.isSafeInteger(afterSeq) ||
      afterSeq < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new ApiError('QUERY_INVALID_INPUT', '日志游标或数量无效', 400)
    if (!this.db.get('SELECT id FROM audit_runs WHERE id=? AND project_id=?', runId, projectId))
      throw new ApiError('CHAIN_NOT_FOUND', '任务不存在', 404)
    if (
      pathId &&
      !this.db.get(
        'SELECT path_id FROM call_paths WHERE path_id=? AND run_id=? AND project_id=?',
        pathId,
        runId,
        projectId
      )
    )
      throw new ApiError('CHAIN_NOT_FOUND', '路径不属于本任务', 404)
    const rows = this.db.all(
      `SELECT * FROM analysis_events WHERE project_id=? AND run_id=? AND seq>?
      ${pathId ? 'AND chain_id=?' : ''} ORDER BY seq LIMIT ?`,
      ...[projectId, runId, afterSeq, ...(pathId ? [pathId] : []), limit]
    )
    const events = rows.map((r) => ({
      eventId: String(r.event_id),
      projectId,
      runId,
      chainId: r.chain_id === null ? null : String(r.chain_id),
      seq: Number(r.seq),
      time: String(r.time),
      type: r.type as EventInput['type'],
      summary: r.summary === null ? null : String(r.summary),
      summaryMissing: r.summary_missing === 1,
      toolCallId: r.tool_call_id === null ? null : String(r.tool_call_id),
      toolName: r.tool_name === null ? null : String(r.tool_name),
      status: String(r.status),
      durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
      payload: JSON.parse(String(r.payload_json)),
      truncated: r.truncated === 1
    }))
    return { projectId, runId, pathId, events, nextSeq: events.at(-1)?.seq ?? afterSeq }
  }
}
