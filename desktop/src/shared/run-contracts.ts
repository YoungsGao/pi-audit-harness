export const controlStates = [
  'idle',
  'running',
  'stop_requested',
  'waiting_external',
  'stopped',
  'interrupted',
  'completed'
] as const
export type ControlState = (typeof controlStates)[number]
export type RecoveryMode = 'none' | 'native' | 'rebuild' | 'restart' | 'blocked'
export interface RecoveryReceipt {
  mode: RecoveryMode
  checkpointId: string | null
  reusedSteps: number[]
  reason: string
  createdAt: string
}
export interface RunRecoveryView {
  projectId: string
  runId: string
  revision: number
  state: ControlState
  activePathId: string | null
  candidatePathId: string | null
  modelConfigId: string | null
  committedPaths: number
  pendingPaths: number
  interruptedPaths: number
  mode: RecoveryMode
  checkpointId: string | null
  readSteps: number[]
  remainingSteps: number[]
  requestsUsed: number
  toolsUsed: number
  roundsUsed: number
  uncertainRequests: number
  canResume: boolean
  recoveryKey: string
  reasons: string[]
  lastRecovery: RecoveryReceipt | null
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every((k) => k in v)
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v)
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const nullableId = (v: unknown): boolean => v === null || id(v)
const steps = (v: unknown): v is number[] =>
  Array.isArray(v) &&
  v.length <= 16 &&
  v.every((n) => Number.isInteger(n) && n >= 0 && n < 16) &&
  new Set(v).size === v.length
const modes = ['none', 'native', 'rebuild', 'restart', 'blocked']
export function runControlInput(
  action: 'stop' | 'recovery' | 'resume',
  v: unknown
): { projectId: string; runId: string; expectedRecoveryKey?: string; maxPaths?: number } {
  if (
    !object(v) ||
    !exact(v, [
      'projectId',
      'runId',
      ...(action === 'resume' ? ['expectedRecoveryKey', 'maxPaths'] : [])
    ]) ||
    !id(v.projectId) ||
    !id(v.runId) ||
    (action === 'resume' &&
      (!hash(v.expectedRecoveryKey) ||
        !Number.isInteger(v.maxPaths) ||
        Number(v.maxPaths) < 1 ||
        Number(v.maxPaths) > 100))
  )
    throw Error('RUN_INVALID_INPUT')
  return v as unknown as ReturnType<typeof runControlInput>
}
export function isRecoveryReceipt(v: unknown): v is RecoveryReceipt {
  return (
    object(v) &&
    exact(v, ['mode', 'checkpointId', 'reusedSteps', 'reason', 'createdAt']) &&
    modes.includes(String(v.mode)) &&
    nullableId(v.checkpointId) &&
    steps(v.reusedSteps) &&
    typeof v.reason === 'string' &&
    v.reason.length <= 2000 &&
    typeof v.createdAt === 'string'
  )
}
export function isRunRecoveryView(v: unknown): v is RunRecoveryView {
  return (
    object(v) &&
    exact(v, [
      'projectId',
      'runId',
      'revision',
      'state',
      'activePathId',
      'candidatePathId',
      'modelConfigId',
      'committedPaths',
      'pendingPaths',
      'interruptedPaths',
      'mode',
      'checkpointId',
      'readSteps',
      'remainingSteps',
      'requestsUsed',
      'toolsUsed',
      'roundsUsed',
      'uncertainRequests',
      'canResume',
      'recoveryKey',
      'reasons',
      'lastRecovery'
    ]) &&
    id(v.projectId) &&
    id(v.runId) &&
    controlStates.includes(v.state as ControlState) &&
    ['activePathId', 'candidatePathId', 'modelConfigId', 'checkpointId'].every((k) =>
      nullableId(v[k])
    ) &&
    [
      'revision',
      'committedPaths',
      'pendingPaths',
      'interruptedPaths',
      'requestsUsed',
      'toolsUsed',
      'roundsUsed',
      'uncertainRequests'
    ].every((k) => Number.isSafeInteger(v[k]) && Number(v[k]) >= 0) &&
    modes.includes(String(v.mode)) &&
    steps(v.readSteps) &&
    steps(v.remainingSteps) &&
    typeof v.canResume === 'boolean' &&
    hash(v.recoveryKey) &&
    Array.isArray(v.reasons) &&
    v.reasons.length <= 20 &&
    v.reasons.every((s) => typeof s === 'string' && s.length <= 2000) &&
    (v.lastRecovery === null || isRecoveryReceipt(v.lastRecovery))
  )
}
