import type { QueryBackend } from './graph-contracts.ts'
export interface RuntimeOptions {
  backend?: QueryBackend
  dataRoot?: string
  graphMemoryMb?: number
  graphTimeoutMs?: number
}
export interface QuerySnapshot {
  projectId: string
  runId: string
  snapshotId: string
  sourceStamp: string
  files: { filePath: string; source: string }[]
}
