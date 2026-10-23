export interface DatabaseInfo {
  state: 'ready'
  schemaVersion: number
  journalMode: 'wal'
}
export interface StorageOverview {
  database: DatabaseInfo
  counts: { projects: number; runs: number; results: number; reports: number }
  // 每类最多 20 条；counts 为总数，列表不承担完整分页/搜索需求。
  projects: { id: string; name: string; sourceType: 'local' | 'git' }[]
  runs: { id: string; projectId: string; status: string }[]
  results: {
    id: string
    runId: string
    verdict: 'unknown' | 'safe' | 'dangerous'
    summary: string
  }[]
  reports: { id: string; runId: string; status: string; summary: string }[]
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
export function isDatabaseInfo(value: unknown): value is DatabaseInfo {
  return (
    record(value) &&
    value.state === 'ready' &&
    value.journalMode === 'wal' &&
    Number.isSafeInteger(value.schemaVersion) &&
    Number(value.schemaVersion) > 0
  )
}
export function isStorageOverview(value: unknown): value is StorageOverview {
  if (!record(value) || !isDatabaseInfo(value.database) || !record(value.counts)) return false
  const groups = ['projects', 'runs', 'results', 'reports'] as const
  if (
    !groups.every(
      (key) =>
        Number.isSafeInteger((value.counts as Record<string, unknown>)[key]) &&
        Number((value.counts as Record<string, unknown>)[key]) >= 0 &&
        Array.isArray(value[key]) &&
        value[key].length <= 20
    )
  )
    return false
  const rows = (key: (typeof groups)[number], fields: string[]): boolean =>
    (value[key] as unknown[]).every(
      (row) => record(row) && fields.every((field) => typeof row[field] === 'string')
    )
  return (
    rows('projects', ['id', 'name', 'sourceType']) &&
    (value.projects as { sourceType: string }[]).every((row) =>
      ['local', 'git'].includes(row.sourceType)
    ) &&
    rows('runs', ['id', 'projectId', 'status']) &&
    rows('results', ['id', 'runId', 'verdict', 'summary']) &&
    (value.results as { verdict: string }[]).every((row) =>
      ['unknown', 'safe', 'dangerous'].includes(row.verdict)
    ) &&
    rows('reports', ['id', 'runId', 'status', 'summary'])
  )
}
