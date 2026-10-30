// 公共位置统一为从 1 开始的 UTF-16 行列；end 不包含末尾字符。
export type QueryOperation =
  | 'capabilities'
  | 'status'
  | 'prepare'
  | 'read'
  | 'search'
  | 'symbols'
  | 'definition'
  | 'references'
  | 'incomingCalls'
  | 'outgoingCalls'
export type QueryStatus =
  'ok' | 'no-match' | 'partial' | 'not-ready' | 'timeout' | 'unsupported' | 'cancelled' | 'failed'
export type PositionEncoding = 'utf-8' | 'utf-16' | 'utf-32'
export interface QueryPosition {
  line: number
  column: number
}
export interface QueryLocation {
  filePath: string
  start: QueryPosition
  end: QueryPosition
}
export interface QuerySymbol {
  name: string
  qualifiedName: string
  signature: string
  kind: number
  location: QueryLocation
  resolution: 'semantic' | 'candidate'
}
export interface QueryItem {
  location: QueryLocation
  symbol: QuerySymbol | null
  text: string
  resolution: 'semantic' | 'candidate' | 'source'
  // 调用层次的 callSite 与 symbol.location 分别表示调用位置和方法声明位置。
  callSite?: QueryLocation
}
export interface QueryRequest {
  operation: QueryOperation
  language: string
  projectId: string
  runId: string
  filePath?: string
  line?: number
  column?: number
  endLine?: number
  text?: string
  direction?: never
  maxResults?: number
  fallback?: boolean
}
export interface QueryRuntimeState {
  state: 'disabled' | 'preparing' | 'initializing' | 'indexing' | 'ready' | 'failed' | 'stopped'
  index: 'unknown' | 'working' | 'quiescent'
  wholeWorkspaceIndexed: false
  starts: number
  pending: number
  errorCode: string | null
  positionEncoding: PositionEncoding
  capabilities: QueryOperation[]
}
export interface QueryResult {
  contractVersion: 1
  operation: QueryOperation
  status: QueryStatus
  language: string
  backend: string
  projectId: string
  runId: string
  snapshotId: string
  sourceStamp: string
  positionEncoding: 'utf-16'
  items: QueryItem[]
  truncated: boolean
  gaps: string[]
  runtime: QueryRuntimeState | null
  errorCode: string | null
  capabilities?: { language: string; operations: QueryOperation[]; semantic: boolean }[]
}
