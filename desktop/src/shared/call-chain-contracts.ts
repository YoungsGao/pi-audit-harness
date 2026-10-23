import type { RiskCandidate } from './code-query-contracts.ts'

export type TruncationReason =
  | ''
  | 'recursion'
  | 'depth-limit'
  | 'node-limit'
  | 'path-limit'
  | 'unresolved-caller'
  | 'candidate-limit'
export interface CallEdgeInput {
  filePath: string
  callerKey: string
  calleeKey: string
  functionName: string
  calledFunctionName: string
  calledFilePath: string | null
  callLine: number
  callColumn: number
  isSink: boolean
  ruleId: string | null
  resolutionStatus: 'candidate' | 'confirmed' | 'unresolved' | 'invalid'
  arguments: RiskCandidate['arguments']
}
export interface CallEdge extends CallEdgeInput {
  uid: string
}
export interface CandidatePath {
  edgeUids: string[]
  truncated: boolean
  truncationReason: TruncationReason
}
export interface CandidateGraph {
  projectId: string
  runId: string
  sourceStamp: string
  rulesVersion: string
  edges: CallEdgeInput[]
  paths: (CandidatePath & {
    sinkEdgeUid: string
    sourceRef: string | null
    ruleId: string | null
  })[]
}
export interface GraphSaved {
  projectId: string
  runId: string
  pathIds: string[]
}
