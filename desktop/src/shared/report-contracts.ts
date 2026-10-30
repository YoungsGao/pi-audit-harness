import type { ScanStatistics } from './scan-contracts'
import type { ReviewStatus } from './review-contracts'
import { reviewStates } from './review-contracts.ts'

export type ReportFormat = 'html' | 'json'
export interface ReportFilter {
  verdict: 'all' | 'dangerous' | 'safe' | 'unknown'
  pathStatus: 'all' | 'pending' | 'analyzing' | 'completed' | 'failed' | 'unresolved' | 'invalid'
  reviewStatus: 'all' | ReviewStatus
}
export const defaultReportFilter: ReportFilter = Object.freeze({
  verdict: 'all',
  pathStatus: 'all',
  reviewStatus: 'all'
})
export interface ReviewCounts {
  unreviewed: number
  confirmed: number
  false_positive: number
  needs_more_info: number
  stale: number
}

export interface ReportScope {
  projectId: string
  runId: string
}
export interface ReportStatistics extends ScanStatistics {
  riskPoints: number | null
}
export interface ReportRecord extends ReportScope {
  format: ReportFormat
  filter: ReportFilter
  snapshotKey: string | null
  stageReasons: string[]
  reviewCounts: ReviewCounts | null
  totalPaths: number | null
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
  format: ReportFormat
  reportId: string
  filePath: string
  sha256: string
}
export interface ReportPreview extends ReportScope {
  filter: ReportFilter
  generatedAt: string
  snapshotKey: string
  statistics: ReportStatistics
  allStatistics: ReportStatistics
  reviewCounts: ReviewCounts
  stageReport: boolean
  stageReasons: string[]
}
export interface ReportSaveResult extends ReportScope {
  reportId: string
  cancelled: boolean
  savedPath: string | null
}
export type ReportAction = 'generate' | 'list' | 'file' | 'preview' | 'export'
export type ReportData = ReportRecord | ReportCatalog | ReportFile | ReportPreview
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
): ReportScope & {
  reportId?: string
  format?: ReportFormat
  filter?: ReportFilter
  expectedSnapshotKey?: string
} {
  if (
    !['generate', 'list', 'file', 'preview', 'export'].includes(action) ||
    !object(value) ||
    !exact(
      value,
      action === 'file'
        ? ['projectId', 'runId', 'reportId']
        : action === 'preview'
          ? ['projectId', 'runId', 'filter']
          : action === 'export'
            ? ['projectId', 'runId', 'format', 'filter', 'expectedSnapshotKey']
            : ['projectId', 'runId']
    ) ||
    !reportId(value.projectId) ||
    !reportId(value.runId) ||
    (action === 'file' && !reportId(value.reportId)) ||
    (['preview', 'export'].includes(action) && !isReportFilter(value.filter)) ||
    (action === 'export' &&
      (!['html', 'json'].includes(String(value.format)) ||
        typeof value.expectedSnapshotKey !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.expectedSnapshotKey)))
  )
    throw new Error('REPORT_INVALID_INPUT')
  return value as unknown as ReturnType<typeof reportInput>
}
export function isReportFilter(v: unknown): v is ReportFilter {
  return (
    object(v) &&
    exact(v, ['verdict', 'pathStatus', 'reviewStatus']) &&
    ['all', 'dangerous', 'safe', 'unknown'].includes(String(v.verdict)) &&
    ['all', 'pending', 'analyzing', 'completed', 'failed', 'unresolved', 'invalid'].includes(
      String(v.pathStatus)
    ) &&
    ['all', ...reviewStates].includes(String(v.reviewStatus))
  )
}
function isReviewCounts(v: unknown): v is ReviewCounts {
  return (
    object(v) &&
    exact(v, [...reviewStates, 'stale']) &&
    Object.values(v).every((n) => Number.isSafeInteger(n) && Number(n) >= 0)
  )
}
function reasons(v: unknown): v is string[] {
  return (
    Array.isArray(v) && v.length <= 30 && v.every((t) => typeof t === 'string' && t.length <= 1000)
  )
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
      'sha256',
      'format',
      'filter',
      'snapshotKey',
      'stageReasons',
      'reviewCounts',
      'totalPaths'
    ]) &&
    ['projectId', 'runId', 'reportId'].every((key) => reportId(v[key])) &&
    ['html', 'json'].includes(String(v.format)) &&
    isReportFilter(v.filter) &&
    reasons(v.stageReasons) &&
    (v.snapshotKey === null ||
      (typeof v.snapshotKey === 'string' && /^[a-f0-9]{64}$/.test(v.snapshotKey))) &&
    (v.reviewCounts === null || isReviewCounts(v.reviewCounts)) &&
    (v.totalPaths === null || (Number.isSafeInteger(v.totalPaths) && Number(v.totalPaths) >= 0)) &&
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
  if (action === 'generate' || action === 'export') return isReportRecord(v)
  if (!object(v) || !reportId(v.projectId) || !reportId(v.runId)) return false
  if (action === 'preview')
    return (
      exact(v, [
        'projectId',
        'runId',
        'filter',
        'generatedAt',
        'snapshotKey',
        'statistics',
        'allStatistics',
        'reviewCounts',
        'stageReport',
        'stageReasons'
      ]) &&
      isReportFilter(v.filter) &&
      typeof v.generatedAt === 'string' &&
      typeof v.snapshotKey === 'string' &&
      /^[a-f0-9]{64}$/.test(v.snapshotKey) &&
      isReportStatistics(v.statistics) &&
      isReportStatistics(v.allStatistics) &&
      isReviewCounts(v.reviewCounts) &&
      typeof v.stageReport === 'boolean' &&
      reasons(v.stageReasons)
    )
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
    exact(v, ['projectId', 'runId', 'reportId', 'filePath', 'sha256', 'format']) &&
    ['html', 'json'].includes(String(v.format)) &&
    reportId(v.reportId) &&
    typeof v.filePath === 'string' &&
    v.filePath.length < 4000 &&
    typeof v.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(v.sha256)
  )
}
