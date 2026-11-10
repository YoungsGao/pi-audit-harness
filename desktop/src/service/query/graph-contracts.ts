import type { QuerySnapshot } from './query-runtime.ts'
import type { QueryRuntimeState, QueryRequest } from '../../shared/query-contracts.ts'
import type { QueryAdapterOutput } from './language-registry.ts'

export type QueryBackend = 'codegraph' | 'basic'
export interface QueryEngine {
  readonly backend: string
  readonly semantic: boolean
  status(snapshot: QuerySnapshot): QueryRuntimeState
  query(
    snapshot: QuerySnapshot,
    request: QueryRequest,
    signal: AbortSignal
  ): Promise<QueryAdapterOutput>
  close(): Promise<void>
}
export interface GraphNode {
  id: string
  kind: string
  name: string
  qualifiedName: string
  filePath: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  signature: string | null
  generated: boolean
}
export interface GraphEdge {
  source: string
  target: string
  kind: string
  line: number | null
  column: number | null
  provenance: string
  resolvedBy: string
  confidence: number
}
export interface GraphBinding {
  version: 1
  backend: QueryBackend
  engine: string
  adapter: string
  graphKey: string
  graphDigest: string
  gaps: string[]
  facts?: {
    filePath: string
    line: number
    column: number
    targets: string[]
    verification: 'candidate' | 'verified-structural'
    provenance: string
    resolvedBy: string
    confidence: number
  }[]
}
export const GRAPH_ENGINE = 'codegraph/1.6.2;git/6560052a6f856855d3f71eee838fd66ccfa4285d'
export const GRAPH_ADAPTER = 'snapshot-graph/1'
