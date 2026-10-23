import type { AuditAction } from './scan-contracts'
export const auditActions: AuditAction[] = [
  'prepare',
  'runs',
  'list',
  'detail',
  'statistics',
  'analyze'
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
            'defenseSummary'
          ]) &&
          s.stepIndex === index &&
          [null, 0, 1].includes(s.dangerous as number | null) &&
          text(s.defenseSummary) &&
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
