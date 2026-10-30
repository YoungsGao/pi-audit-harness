export const reviewStates = [
  'unreviewed',
  'confirmed',
  'false_positive',
  'needs_more_info'
] as const
export type ReviewStatus = (typeof reviewStates)[number]
export const reviewLabels: Record<ReviewStatus, string> = {
  unreviewed: '未复核',
  confirmed: '人工确认',
  false_positive: '人工判为误报',
  needs_more_info: '待补充'
}
export interface PathScope {
  projectId: string
  runId: string
  pathId: string
}
export interface MachineReviewBasis {
  version: string
  status: string
  verdict: string
  updatedAt: string
  attempt: number
}
export interface HumanReview extends PathScope {
  revision: number
  status: ReviewStatus
  note: string
  savedAt: string | null
  baseline: MachineReviewBasis | null
  current: MachineReviewBasis
  stale: boolean
}
export interface ReviewSave extends PathScope {
  expectedRevision: number
  baselineVersion: string
  status: ReviewStatus
  note: string
}
export interface PathSource extends PathScope {
  stepIndex: number
  target: 'caller' | 'callee'
  snapshotId: string
  sourceStamp: string
  filePath: string
  startLine: number
  endLine: number
  text: string
  complete: boolean
}
export type ReviewAction = 'get' | 'save' | 'source'
export type ReviewData = HumanReview | PathSource
const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every((k) => k in v)
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v)
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const count = (v: unknown): boolean => Number.isSafeInteger(v) && Number(v) >= 0
export function reviewInput(
  action: ReviewAction,
  value: unknown
): PathScope & Partial<ReviewSave & { stepIndex: number; target: 'caller' | 'callee' }> {
  const base = ['projectId', 'runId', 'pathId']
  const keys = [
    ...base,
    ...(action === 'save'
      ? ['expectedRevision', 'baselineVersion', 'status', 'note']
      : action === 'source'
        ? ['stepIndex', 'target']
        : [])
  ]
  if (
    !['get', 'save', 'source'].includes(action) ||
    !obj(value) ||
    !exact(value, keys) ||
    !base.every((k) => id(value[k]))
  )
    throw Error('REVIEW_INVALID_INPUT')
  if (
    action === 'save' &&
    (!count(value.expectedRevision) ||
      !hash(value.baselineVersion) ||
      !reviewStates.includes(value.status as ReviewStatus) ||
      typeof value.note !== 'string' ||
      value.note.length > 6000 ||
      [...value.note].some((c) => c.charCodeAt(0) < 32 && !['\n', '\r', '\t'].includes(c)))
  )
    throw Error('REVIEW_INVALID_INPUT')
  if (
    action === 'source' &&
    (!count(value.stepIndex) ||
      Number(value.stepIndex) > 63 ||
      !['caller', 'callee'].includes(String(value.target)))
  )
    throw Error('REVIEW_INVALID_INPUT')
  return value as unknown as ReturnType<typeof reviewInput>
}
function basis(v: unknown): v is MachineReviewBasis {
  return (
    obj(v) &&
    exact(v, ['version', 'status', 'verdict', 'updatedAt', 'attempt']) &&
    hash(v.version) &&
    ['pending', 'analyzing', 'completed', 'failed', 'unresolved', 'invalid'].includes(
      String(v.status)
    ) &&
    ['unknown', 'safe', 'dangerous'].includes(String(v.verdict)) &&
    typeof v.updatedAt === 'string' &&
    count(v.attempt)
  )
}
export function isReviewData(action: ReviewAction, v: unknown): v is ReviewData {
  if (!obj(v) || !['projectId', 'runId', 'pathId'].every((k) => id(v[k]))) return false
  if (action === 'source')
    return (
      exact(v, [
        'projectId',
        'runId',
        'pathId',
        'stepIndex',
        'target',
        'snapshotId',
        'sourceStamp',
        'filePath',
        'startLine',
        'endLine',
        'text',
        'complete'
      ]) &&
      count(v.stepIndex) &&
      Number(v.stepIndex) <= 63 &&
      ['caller', 'callee'].includes(String(v.target)) &&
      id(v.snapshotId) &&
      typeof v.sourceStamp === 'string' &&
      typeof v.filePath === 'string' &&
      v.filePath.length <= 1000 &&
      count(v.startLine) &&
      Number(v.startLine) >= 1 &&
      count(v.endLine) &&
      Number(v.endLine) >= Number(v.startLine) &&
      Number(v.endLine) - Number(v.startLine) < 80 &&
      typeof v.text === 'string' &&
      v.text.length <= 12000 &&
      typeof v.complete === 'boolean'
    )
  return (
    ['get', 'save'].includes(action) &&
    exact(v, [
      'projectId',
      'runId',
      'pathId',
      'revision',
      'status',
      'note',
      'savedAt',
      'baseline',
      'current',
      'stale'
    ]) &&
    count(v.revision) &&
    reviewStates.includes(v.status as ReviewStatus) &&
    typeof v.note === 'string' &&
    v.note.length <= 6000 &&
    (v.savedAt === null || typeof v.savedAt === 'string') &&
    (v.baseline === null || basis(v.baseline)) &&
    basis(v.current) &&
    typeof v.stale === 'boolean' &&
    v.stale === (v.baseline !== null && v.baseline.version !== v.current.version)
  )
}
