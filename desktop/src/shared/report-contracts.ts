import type { ScanStatistics } from './scan-contracts'

export interface ReportScope {
  projectId: string
  runId: string
}
export interface ReportStatistics extends ScanStatistics {
  riskPoints: number | null
}
export interface ReportRecord extends ReportScope {
  reportId: string
  filePath: string
  status: 'pending' | 'ready' | 'failed'
  createdAt: string
  generatedAt: string | null
  errorCode: string | null
  stageReport: boolean | null
  statistics: ReportStatistics | null
  sha256: string | null
}
export interface ReportCatalog extends ReportScope {
  reports: ReportRecord[]
}
export interface ReportFile extends ReportScope {
  reportId: string
  filePath: string
  sha256: string
}
export type ReportAction = 'generate' | 'list' | 'file'
export type ReportData = ReportRecord | ReportCatalog | ReportFile
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every((key) => key in v)
export const reportId = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v)
const statsKeys = [
  'paths',
  'sinks',
  'edges',
  'dangerous',
  'safe',
  'unknown',
  'pending',
  'analyzing',
  'completed',
  'failed',
  'unresolved',
  'invalid'
]
export function isReportStatistics(v: unknown): v is ReportStatistics {
  return (
    object(v) &&
    exact(v, [...statsKeys, 'riskPoints']) &&
    statsKeys.every((key) => Number.isSafeInteger(v[key]) && Number(v[key]) >= 0) &&
    Number(v.dangerous) + Number(v.safe) + Number(v.unknown) === Number(v.paths) &&
    ['pending', 'analyzing', 'completed', 'failed', 'unresolved', 'invalid'].reduce(
      (sum, key) => sum + Number(v[key]),
      0
    ) === Number(v.paths) &&
    (v.riskPoints === null ||
      (Number.isSafeInteger(v.riskPoints) &&
        Number(v.riskPoints) >= 0 &&
        Number(v.riskPoints) <= Number(v.dangerous)))
  )
}
export function reportInput(
  action: ReportAction,
  value: unknown
): ReportScope & { reportId?: string } {
  if (
    !['generate', 'list', 'file'].includes(action) ||
    !object(value) ||
    !exact(
      value,
      action === 'file' ? ['projectId', 'runId', 'reportId'] : ['projectId', 'runId']
    ) ||
    !reportId(value.projectId) ||
    !reportId(value.runId) ||
    (action === 'file' && !reportId(value.reportId))
  )
    throw new Error('REPORT_INVALID_INPUT')
  return value as unknown as ReportScope & { reportId?: string }
}
export function isReportRecord(v: unknown): v is ReportRecord {
  return (
    object(v) &&
    exact(v, [
      'projectId',
      'runId',
      'reportId',
      'filePath',
      'status',
      'createdAt',
      'generatedAt',
      'errorCode',
      'stageReport',
      'statistics',
      'sha256'
    ]) &&
    ['projectId', 'runId', 'reportId'].every((key) => reportId(v[key])) &&
    typeof v.filePath === 'string' &&
    v.filePath.length < 4000 &&
    ['pending', 'ready', 'failed'].includes(String(v.status)) &&
    typeof v.createdAt === 'string' &&
    ['generatedAt', 'errorCode'].every((key) => v[key] === null || typeof v[key] === 'string') &&
    (v.stageReport === null || typeof v.stageReport === 'boolean') &&
    (v.statistics === null || isReportStatistics(v.statistics)) &&
    (v.sha256 === null || (typeof v.sha256 === 'string' && /^[a-f0-9]{64}$/.test(v.sha256)))
  )
}
export function isReportData(action: ReportAction, v: unknown): v is ReportData {
  if (action === 'generate') return isReportRecord(v)
  if (!object(v) || !reportId(v.projectId) || !reportId(v.runId)) return false
  if (action === 'list')
    return (
      exact(v, ['projectId', 'runId', 'reports']) &&
      Array.isArray(v.reports) &&
      v.reports.length <= 100 &&
      v.reports.every(
        (r) => isReportRecord(r) && r.projectId === v.projectId && r.runId === v.runId
      )
    )
  return (
    action === 'file' &&
    exact(v, ['projectId', 'runId', 'reportId', 'filePath', 'sha256']) &&
    reportId(v.reportId) &&
    typeof v.filePath === 'string' &&
    v.filePath.length < 4000 &&
    typeof v.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(v.sha256)
  )
}
