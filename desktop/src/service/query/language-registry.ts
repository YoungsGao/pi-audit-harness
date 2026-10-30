import type {
  QueryOperation,
  PositionEncoding,
  QueryRequest,
  QueryItem
} from '../../shared/query-contracts.ts'
import type { QuerySnapshot } from './java-runtime.ts'
import type { QueryRuntimeState } from '../../shared/query-contracts.ts'
import { semanticJava } from './semantic-java.ts'
import { basicQuery } from './basic-adapter.ts'
// 提供商适配输出只能是统一的快照内位置、符号和缺口；业务不消费原始 LSP DTO。
export interface QueryAdapterOutput {
  items: QueryItem[]
  gaps: string[]
}
export interface QueryAdapterContext {
  readonly root: string
  readonly sourceGaps: string[]
  readonly snapshot: QuerySnapshot
  readonly state: QueryRuntimeState
  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown>
}
export interface ManagedQueryRuntime {
  status(): QueryRuntimeState
  use<T>(fn: (runtime: QueryAdapterContext) => Promise<T>, signal?: AbortSignal): Promise<T>
}
export interface QueryRuntimeProvider {
  get(snapshot: QuerySnapshot): ManagedQueryRuntime
  close(): Promise<void>
}
export interface LanguageAdapter {
  readonly language: string
  readonly extensions: readonly string[]
  readonly encodings: readonly PositionEncoding[]
  readonly operations: readonly QueryOperation[]
  readonly backend: string
  readonly backendLabel: string
  readonly basic?: (snapshot: QuerySnapshot, request: QueryRequest) => QueryAdapterOutput
  readonly query: (
    runtime: QueryAdapterContext,
    request: QueryRequest,
    signal: AbortSignal
  ) => Promise<QueryAdapterOutput>
}
export class LanguageRegistry {
  private readonly adapters = new Map<string, LanguageAdapter>()
  register(adapter: LanguageAdapter): void {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(adapter.language) || this.adapters.has(adapter.language))
      throw new Error('重复或无效语言注册')
    this.adapters.set(
      adapter.language,
      Object.freeze({
        ...adapter,
        extensions: [...adapter.extensions],
        encodings: [...adapter.encodings],
        operations: [...adapter.operations]
      })
    )
  }
  get(language: string): LanguageAdapter | undefined {
    return this.adapters.get(language)
  }
  list(): LanguageAdapter[] {
    return [...this.adapters.values()]
  }
}
export function defaultLanguages(): LanguageRegistry {
  const registry = new LanguageRegistry()
  registry.register({
    language: 'java',
    backend: 'java-jdtls',
    backendLabel: 'jdtls',
    basic: basicQuery,
    query: semanticJava,
    extensions: ['.java'],
    encodings: ['utf-16', 'utf-8', 'utf-32'],
    operations: [
      'capabilities',
      'status',
      'prepare',
      'read',
      'search',
      'symbols',
      'definition',
      'references',
      'incomingCalls',
      'outgoingCalls'
    ]
  })
  return registry
}
