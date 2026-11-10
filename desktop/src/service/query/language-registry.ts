import type {
  QueryOperation,
  PositionEncoding,
  QueryRequest,
  QueryItem
} from '../../shared/query-contracts.ts'
import type { QuerySnapshot } from './query-runtime.ts'
import { basicQuery } from './basic-adapter.ts'
// 引擎只返回快照内位置、符号和缺口；业务不消费上游图数据库DTO。
export interface QueryAdapterOutput {
  items: QueryItem[]
  gaps: string[]
}
export interface LanguageAdapter {
  readonly language: string
  readonly extensions: readonly string[]
  readonly encodings: readonly PositionEncoding[]
  readonly operations: readonly QueryOperation[]
  readonly backend: string
  readonly backendLabel: string
  readonly basic?: (snapshot: QuerySnapshot, request: QueryRequest) => QueryAdapterOutput
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
export function defaultLanguages(backend: 'codegraph' | 'basic' = 'codegraph'): LanguageRegistry {
  const registry = new LanguageRegistry()
  registry.register({
    language: 'java',
    backend: 'java-' + backend,
    backendLabel: backend,
    basic: basicQuery,
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
