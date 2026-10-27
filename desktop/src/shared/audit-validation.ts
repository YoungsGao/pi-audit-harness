import type { AuditAction } from './scan-contracts'
import { AnalyzeSseParser } from './sse-parser.ts'
export const auditActions: AuditAction[] = [
  'prepare',
  'runs',
  'list',
  'detail',
  'statistics',
  'analyze',
  'analyzePending',
  'events',
  'runState',
  'history'
]
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  object(v) && Object.keys(v).length === keys.length && keys.every((k) => k in v)
const text = (v: unknown): v is string => typeof v === 'string' && v.length <= 24000
const nullableText = (v: unknown): boolean => v === null || text(v)
const count = (v: unknown): boolean => Number.isSafeInteger(v) && Number(v) >= 0
const status = ['pending', 'analyzing', 'completed', 'failed', 'unresolved', 'invalid']
function safeJson(v: unknown, depth = 0): boolean {
  if (depth > 12) return false
  if (Array.isArray(v)) return v.length <= 100 && v.every((item) => safeJson(item, depth + 1))
  if (object(v))
    return Object.entries(v).every(
      ([key, value]) =>
        !/^(?:apiKey|secretRef|password|authorization|token)$/i.test(key) &&
        safeJson(value, depth + 1)
    )
  return v === null || ['string', 'number', 'boolean'].includes(typeof v)
}
function path(v: unknown): boolean {
  return (
    exact(v, [
      'pathId',
      'runId',
      'projectId',
      'pathHash',
      'sourceRef',
      'sinkEdgeUid',
      'ruleId',
      'status',
      'verdict',
      'dangerous',
      'truncated',
      'truncationReason',
      'summary',
      'createdAt',
      'updatedAt'
    ]) &&
    [
      'pathId',
      'runId',
      'projectId',
      'pathHash',
      'truncationReason',
      'summary',
      'createdAt',
      'updatedAt'
    ].every((k) => text(v[k])) &&
    ['sourceRef', 'sinkEdgeUid', 'ruleId'].every((k) => nullableText(v[k])) &&
    status.includes(String(v.status)) &&
    ['unknown', 'safe', 'dangerous'].includes(String(v.verdict)) &&
    (v.verdict === 'unknown'
      ? v.dangerous === null
      : v.dangerous === Number(v.verdict === 'dangerous')) &&
    typeof v.truncated === 'boolean'
  )
}
function summary(v: Record<string, unknown>): boolean {
  return (
    ['ready', 'partial', 'empty', 'failed'].includes(String(v.state)) &&
    count(v.candidateCount) &&
    count(v.unresolvedCalls) &&
    typeof v.truncated === 'boolean' &&
    Array.isArray(v.warnings) &&
    v.warnings.length <= 50 &&
    v.warnings.every(
      (w) =>
        exact(w, ['code', 'filePath', 'message']) &&
        text(w.code) &&
        nullableText(w.filePath) &&
        text(w.message)
    )
  )
}
export function isAuditData(action: AuditAction, data: unknown): boolean {
  if (!object(data) || !safeJson(data)) return false
  if (action === 'history') {
    if (!(
      exact(data, [
        'projectId',
        'runId',
        'pathId',
        'sessions',
        'selectedSessionId',
        'frames',
        'nextAfterId',
        'hasMore',
        'historyExpired'
      ]) &&
      ['projectId', 'runId', 'pathId'].every((k) => text(data[k])) &&
      nullableText(data.selectedSessionId) &&
      count(data.nextAfterId) &&
      typeof data.hasMore === 'boolean' &&
      typeof data.historyExpired === 'boolean' &&
      Array.isArray(data.sessions) &&
      data.sessions.length <= 20 &&
      data.sessions.every(
        (s) =>
          exact(s, [
            'sessionId',
            'attemptId',
            'modelConfigId',
            'state',
            'minEventId',
            'createdAt',
            'finishedAt'
          ]) &&
          ['sessionId', 'modelConfigId', 'createdAt'].every((k) => text(s[k])) &&
          nullableText(s.finishedAt) &&
          count(s.attemptId) &&
          Number(s.attemptId) > 0 &&
          count(s.minEventId) &&
          Number(s.minEventId) > 0 &&
          ['queue', 'analyze', 'completed', 'error', 'timeout', 'stop', 'cancel'].includes(
            String(s.state)
          )
      ) &&
      Array.isArray(data.frames) &&
      data.frames.length <= 50
    ))
      return false
    const selected = data.sessions.find((s) => s.sessionId === data.selectedSessionId)
    if (!selected)
      return (
        data.selectedSessionId === null && data.frames.length === 0 && data.sessions.length === 0
      )
    try {
      const first = data.frames[0]
      if (first && (!object(first) || !count(first.id) || Number(first.id) < selected.minEventId))
        return false
      const parser = new AnalyzeSseParser(
        selected.sessionId,
        first ? Number(first.id) - 1 : Number(data.nextAfterId)
      )
      for (const f of data.frames) {
        if (
          !object(f) ||
          !exact(f, ['event', 'id', 'data']) ||
          !object(f.data) ||
          f.data.projectId !== data.projectId ||
          f.data.runId !== data.runId ||
          f.data.chainId !== data.pathId ||
          f.data.attemptId !== selected.attemptId
        )
          return false
        parser.push(
          new TextEncoder().encode(
            `event: ${f.event}\nid: ${f.id}\ndata: ${JSON.stringify(f.data)}\n\n`
          )
        )
      }
      parser.finish()
      return !data.frames.length || data.frames.at(-1).id === data.nextAfterId
    } catch {
      return false
    }
  }
  if (action === 'analyzePending')
    return (
      exact(data, ['projectId', 'runId', 'status', 'maxPaths']) &&
      text(data.projectId) &&
      text(data.runId) &&
      data.status === 'running' &&
      count(data.maxPaths) &&
      Number(data.maxPaths) >= 1 &&
      Number(data.maxPaths) <= 100
    )
  if (action === 'runState')
    return (
      exact(data, [
        'projectId',
        'runId',
        'stage',
        'status',
        'sourceStamp',
        'rulesVersion',
        'modelConfigId',
        'startedAt',
        'finishedAt',
        'errorCode',
        'statistics'
      ]) &&
      ['projectId', 'runId', 'sourceStamp', 'rulesVersion'].every((k) => text(data[k])) &&
      ['scanning', 'prepared', 'analyzing', 'completed', 'failed', 'interrupted'].includes(
        String(data.stage)
      ) &&
      ['queued', 'running', 'completed', 'failed', 'cancelled'].includes(String(data.status)) &&
      ['modelConfigId', 'startedAt', 'finishedAt', 'errorCode'].every((k) =>
        nullableText(data[k])
      ) &&
      isAuditData('statistics', data.statistics)
    )
  if (action === 'events')
    return (
      exact(data, ['projectId', 'runId', 'pathId', 'events', 'nextSeq']) &&
      text(data.projectId) &&
      text(data.runId) &&
      nullableText(data.pathId) &&
      count(data.nextSeq) &&
      Array.isArray(data.events) &&
      data.events.length <= 100 &&
      data.events.every(
        (e, i, events) =>
          exact(e, [
            'eventId',
            'projectId',
            'runId',
            'chainId',
            'seq',
            'time',
            'type',
            'summary',
            'summaryMissing',
            'toolCallId',
            'toolName',
            'status',
            'durationMs',
            'payload',
            'truncated'
          ]) &&
          e.projectId === data.projectId &&
          e.runId === data.runId &&
          nullableText(e.chainId) &&
          (data.pathId === null || e.chainId === data.pathId) &&
          ['eventId', 'time', 'status'].every((k) => text(e[k])) &&
          count(e.seq) &&
          Number(e.seq) > 0 &&
          (i === 0 || Number(e.seq) > Number(events[i - 1].seq)) &&
          Number(e.seq) <= Number(data.nextSeq) &&
          ['process', 'model', 'tool', 'result'].includes(String(e.type)) &&
          nullableText(e.summary) &&
          typeof e.summaryMissing === 'boolean' &&
          e.summaryMissing === !e.summary &&
          nullableText(e.toolCallId) &&
          nullableText(e.toolName) &&
          (e.durationMs === null || count(e.durationMs)) &&
          typeof e.truncated === 'boolean'
      )
    )
  if (action === 'statistics') {
    const keys = ['paths', 'sinks', 'edges', 'dangerous', 'safe', 'unknown', ...status]
    return (
      exact(data, keys) &&
      keys.every((key) => count(data[key])) &&
      Number(data.paths) === Number(data.dangerous) + Number(data.safe) + Number(data.unknown) &&
      Number(data.paths) === status.reduce((n, key) => n + Number(data[key]), 0) &&
      Number(data.sinks) <= Number(data.paths)
    )
  }
  if (action === 'analyze')
    return (
      exact(data, ['projectId', 'runId', 'pathId', 'status']) &&
      ['projectId', 'runId', 'pathId'].every((k) => text(data[k])) &&
      data.status === 'analyzing'
    )
  if (action === 'prepare')
    return (
      exact(data, [
        'projectId',
        'runId',
        'pathIds',
        'sourceStamp',
        'rulesVersion',
        'scope',
        'state',
        'candidateCount',
        'unresolvedCalls',
        'truncated',
        'warnings'
      ]) &&
      summary(data) &&
      text(data.projectId) &&
      text(data.runId) &&
      text(data.sourceStamp) &&
      text(data.rulesVersion) &&
      data.scope === 'bounded-java-call-paths' &&
      Array.isArray(data.pathIds) &&
      data.pathIds.length <= 100 &&
      data.pathIds.every(text)
    )
  if (action === 'runs')
    return (
      exact(data, ['projectId', 'runs']) &&
      text(data.projectId) &&
      Array.isArray(data.runs) &&
      data.runs.length <= 50 &&
      data.runs.every(
        (r) =>
          exact(r, [
            'projectId',
            'runId',
            'sourceStamp',
            'rulesVersion',
            'state',
            'candidateCount',
            'unresolvedCalls',
            'truncated',
            'warnings',
            'errorCode',
            'createdAt',
            'analysisStatus',
            'modelConfigId'
          ]) &&
          summary({ ...r, state: r.state === 'scanning' ? 'ready' : r.state }) &&
          r.projectId === data.projectId &&
          ['runId', 'sourceStamp', 'rulesVersion', 'createdAt', 'analysisStatus'].every((k) =>
            text(r[k])
          ) &&
          nullableText(r.modelConfigId) &&
          nullableText(r.errorCode)
      )
    )
  if (action === 'list')
    return (
      exact(data, ['projectId', 'runId', 'sourceStamp', 'rulesVersion', 'total', 'paths']) &&
      ['projectId', 'runId', 'sourceStamp', 'rulesVersion'].every((k) => text(data[k])) &&
      count(data.total) &&
      Array.isArray(data.paths) &&
      data.paths.length <= 100 &&
      data.paths.every((p) => path(p) && p.projectId === data.projectId && p.runId === data.runId)
    )
  if (action === 'detail') {
    const { steps, ...base } = data
    return (
      path(base) &&
      Array.isArray(steps) &&
      steps.length <= 32 &&
      steps.every(
        (s, index) =>
          exact(s, [
            'stepIndex',
            'edge',
            'dangerous',
            'taintIn',
            'taintOut',
            'evidence',
            'defenseSummary',
            'propagation'
          ]) &&
          s.stepIndex === index &&
          [null, 0, 1].includes(s.dangerous as number | null) &&
          text(s.defenseSummary) &&
          object(s.propagation) &&
          ['taintIn', 'taintOut', 'evidence'].every((k) => Array.isArray(s[k])) &&
          exact(s.edge, [
            'uid',
            'filePath',
            'callerKey',
            'calleeKey',
            'functionName',
            'calledFunctionName',
            'calledFilePath',
            'callLine',
            'callColumn',
            'isSink',
            'ruleId',
            'resolutionStatus',
            'arguments'
          ]) &&
          ['uid', 'filePath', 'callerKey', 'calleeKey', 'functionName', 'calledFunctionName'].every(
            (k) => text((s.edge as Record<string, unknown>)[k])
          ) &&
          nullableText(s.edge.calledFilePath) &&
          nullableText(s.edge.ruleId) &&
          count(s.edge.callLine) &&
          count(s.edge.callColumn) &&
          typeof s.edge.isSink === 'boolean' &&
          ['candidate', 'confirmed', 'unresolved', 'invalid'].includes(
            String(s.edge.resolutionStatus)
          ) &&
          Array.isArray(s.edge.arguments)
      )
    )
  }
  return false
}
