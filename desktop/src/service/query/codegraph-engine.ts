import type { DatabaseSync } from 'node:sqlite'
import type { QueryEngine, GraphNode, GraphBinding } from './graph-contracts.ts'
import type { QuerySnapshot, RuntimeOptions } from './query-runtime.ts'
import type {
  QueryRequest,
  QueryItem,
  QueryLocation,
  QuerySymbol
} from '../../shared/query-contracts.ts'
import type { QueryAdapterOutput } from './language-registry.ts'
import { CodeGraphPool } from './codegraph-runtime.ts'
import { GraphRepository } from '../storage/graph-repository.ts'
import { indexJavaFile } from '../scanning/java-index.ts'
import type { JavaMethod, JavaCall } from '../scanning/java-index.ts'
import { ApiError } from '../../shared/api-error.ts'

function offset(source: string, line: number, column: number): number {
  const lines = source.split('\n')
  if (
    !Number.isInteger(line) ||
    !Number.isInteger(column) ||
    line < 1 ||
    line > lines.length ||
    column < 0 ||
    column > lines[line - 1].replace(/\r$/, '').length
  )
    throw new ApiError('QUERY_BACKEND_OUTPUT', '图位置不在快照范围', 502)
  return lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column
}
function location(source: string, filePath: string, start: number, end: number): QueryLocation {
  const pos = (n: number): { line: number; column: number } => ({
    line: source.slice(0, n).split('\n').length,
    column: n - source.lastIndexOf('\n', n - 1)
  })
  return { filePath, start: pos(start), end: pos(end) }
}
interface ViewNode {
  node: GraphNode
  start: number
  end: number
  method?: JavaMethod
  item: QueryItem
}
export class CodeGraphEngine implements QueryEngine {
  readonly backend = 'codegraph'
  readonly semantic = false
  readonly pool: CodeGraphPool
  private readonly bindings: GraphRepository
  private projection?: {
    key: string
    view: { nodes: ViewNode[]; calls: JavaCall[]; gaps: string[] }
  }
  constructor(options: RuntimeOptions, root: string, bindings: GraphRepository) {
    this.pool = new CodeGraphPool(options, root)
    this.bindings = bindings
  }
  status(snapshot: QuerySnapshot): ReturnType<CodeGraphPool['status']> {
    return this.pool.status(snapshot)
  }
  private view(
    snapshot: QuerySnapshot,
    db: DatabaseSync
  ): { nodes: ViewNode[]; calls: JavaCall[]; gaps: string[] } {
    const key = this.pool.key(snapshot)
    if (this.projection?.key === key) return this.projection.view
    const methods: JavaMethod[] = [],
      calls: JavaCall[] = [],
      gaps: string[] = []
    for (const file of snapshot.files) {
      try {
        if (Buffer.byteLength(file.source) > 256 * 1024) throw Error('limit')
        const index = indexJavaFile(file.filePath, file.source)
        methods.push(...index.methods)
        calls.push(...index.calls)
        if (methods.length > 5000 || calls.length > 10000)
          throw new ApiError('QUERY_GRAPH_LIMIT', '查询索引超限', 413)
      } catch (error) {
        if (error instanceof ApiError) throw error
        gaps.push('JAVA_PARSE_INCOMPLETE')
      }
    }
    const nodes: ViewNode[] = []
    for (const node of this.pool.nodes(db)) {
      if (node.generated) {
        gaps.push('GRAPH_SYNTHESIZED_OMITTED')
        continue
      }
      const file = snapshot.files.find((f) => f.filePath === node.filePath)
      if (
        !file ||
        !['method', 'function', 'class', 'interface', 'field', 'enum'].includes(node.kind)
      )
        continue
      const start = offset(file.source, node.startLine, node.startColumn),
        end = offset(file.source, node.endLine, node.endColumn)
      if (end - start > 2000) gaps.push('SOURCE_EXCERPT_TRUNCATED')
      if (end <= start || !file.source.slice(start, end).includes(node.name))
        throw new ApiError('QUERY_BACKEND_OUTPUT', '图节点与固定原文不一致', 502)
      const method = ['method', 'function'].includes(node.kind)
        ? methods.find(
            (m) =>
              m.filePath === node.filePath &&
              m.name === node.name &&
              m.start >= start - 1 &&
              m.end <= end + 1
          )
        : undefined
      if (node.kind === 'method' && !method) {
        gaps.push('GRAPH_DECLARATION_UNMAPPED')
        continue
      }
      const signature = method
        ? `${method.name}(${method.types.join(',')})`
        : (node.signature ?? node.name)
      const symbol: QuerySymbol = {
        name: node.name,
        qualifiedName: method ? `${method.owner}.${signature}` : node.qualifiedName,
        signature,
        kind: method ? 6 : node.kind === 'field' ? 8 : 5,
        location: location(file.source, node.filePath, start, end),
        resolution: 'candidate'
      }
      nodes.push({
        node,
        method,
        start,
        end,
        item: {
          symbol,
          location: symbol.location,
          text: file.source.slice(start, Math.min(end, start + 2000)),
          resolution: 'candidate'
        }
      })
    }
    const view = { nodes, calls, gaps }
    if (nodes.reduce((n, row) => n + row.item.text.length * 2, 0) <= 4 * 1024 * 1024)
      this.projection = { key, view }
    return view
  }
  private targets(
    call: JavaCall,
    caller: ViewNode | undefined,
    nodes: ViewNode[],
    db: DatabaseSync
  ): { nodes: ViewNode[]; gaps: string[] } {
    if (!caller) return { nodes: [], gaps: ['GRAPH_CALLER_UNMAPPED'] }
    const edges = this.callEdges(call, caller, db)
    const candidates = edges.flatMap((edge) => {
      const target = nodes.find((n) => n.node.id === edge.target && n.method?.name === call.name)
      if (!target?.method) return []
      // Upstream may choose ONE overload by name. Restore the entire ambiguity
      // set instead of treating the chosen high-scoring edge as type binding.
      return nodes.filter(
        (n) =>
          n.method?.owner === target.method!.owner &&
          n.method?.name === call.name &&
          n.method?.types.length === call.arity
      )
    })
    const unique = [...new Map(candidates.map((n) => [n.node.id, n])).values()]
    return {
      nodes: unique,
      gaps:
        unique.length > 1
          ? ['GRAPH_AMBIGUOUS_TARGET']
          : unique.length
            ? []
            : ['GRAPH_CALL_TARGET_UNRESOLVED']
    }
  }
  private callEdges(
    call: JavaCall,
    caller: ViewNode,
    db: DatabaseSync
  ): ReturnType<CodeGraphPool['edges']> {
    // The release anchors qualified calls on the receiver, bare calls on the
    // method token. Both are checked against this exact CST call, never line only.
    const receiver = /^[\p{L}\p{N}_$.]+$/u.test(call.receiver) ? call.receiver : ''
    return this.pool
      .edges(db, caller.node.id)
      .filter(
        (e) =>
          e.kind === 'calls' &&
          e.line === call.line &&
          (e.column === call.column - 1 ||
            (!!receiver && e.column === call.column - receiver.length - 2))
      )
  }
  async query(
    snapshot: QuerySnapshot,
    request: QueryRequest,
    signal: AbortSignal
  ): Promise<QueryAdapterOutput> {
    return this.pool.read(snapshot, signal, (db, binding) => {
      this.checkBinding(snapshot, binding)
      if (request.operation === 'prepare') return { items: [], gaps: binding.gaps }
      const view = this.view(snapshot, db)
      const { nodes, calls } = view
      const gaps = [...view.gaps]
      const out: QueryItem[] = []
      const add = (item: QueryItem): void => {
        if (out.length < (request.maxResults ?? 50) + 1) out.push(item)
      }
      if (request.operation === 'symbols')
        for (const n of nodes.filter((n) => n.node.filePath === request.filePath)) add(n.item)
      else {
        const file = snapshot.files.find((f) => f.filePath === request.filePath)!
        const point = offset(file.source, request.line!, request.column! - 1)
        const call = calls.find(
          (c) =>
            c.filePath === request.filePath && point >= c.start && point < c.start + c.name.length
        )
        let own: ViewNode | undefined = nodes
          .filter((n) => n.node.filePath === request.filePath && n.start <= point && n.end > point)
          .sort((a, b) => a.end - a.start - (b.end - b.start))[0]
        const callerOf = (c: JavaCall): ViewNode | undefined =>
          nodes.find((n) => n.method?.key === c.caller.key)
        const sourceSite = (c: JavaCall): QueryLocation => ({
          filePath: c.filePath,
          start: { line: c.line, column: c.column },
          end: { line: c.line, column: c.column + c.name.length }
        })
        if (call && ['references', 'incomingCalls'].includes(request.operation)) {
          const target = this.targets(call, callerOf(call), nodes, db)
          gaps.push(...target.gaps)
          own = target.nodes.length === 1 ? target.nodes[0] : undefined
        }
        if (request.operation === 'definition') {
          if (call) {
            const target = this.targets(call, callerOf(call), nodes, db)
            gaps.push(...target.gaps)
            target.nodes.forEach((n) => add(n.item))
          } else if (own) {
            const left = file.source.slice(0, point).match(/[\p{L}\p{N}_$]+$/u)?.[0] ?? ''
            const right = file.source.slice(point).match(/^[\p{L}\p{N}_$]+/u)?.[0] ?? ''
            if (left + right === own.node.name && (!own.method || point < own.method.bodyStart))
              add(own.item)
            else gaps.push('GRAPH_DEFINITION_UNSUPPORTED')
          }
        } else if (request.operation === 'outgoingCalls' && own) {
          for (const c of calls.filter((c) => c.caller.key === own.method?.key)) {
            const targets = this.targets(c, own, nodes, db)
            gaps.push(...targets.gaps)
            targets.nodes.forEach((n) => add({ ...n.item, callSite: sourceSite(c) }))
          }
        } else if (own) {
          if (request.operation === 'references') gaps.push('GRAPH_REFERENCES_PARTIAL')
          for (const c of calls) {
            const caller = callerOf(c),
              targets = this.targets(c, caller, nodes, db)
            if (!targets.nodes.some((n) => n.node.id === own.node.id)) continue
            gaps.push(...targets.gaps)
            if (request.operation === 'incomingCalls' && caller)
              add({ ...caller.item, callSite: sourceSite(c) })
            else if (request.operation === 'references')
              add({
                symbol: own.item.symbol,
                location: sourceSite(c),
                text: c.name,
                resolution: 'candidate'
              })
          }
        }
      }
      return { items: out, gaps: [...new Set([...binding.gaps, ...gaps])] }
    })
  }
  private checkBinding(snapshot: QuerySnapshot, binding: GraphBinding): void {
    const fixed = this.bindings.get(snapshot.projectId, snapshot.runId)
    if (
      fixed &&
      (fixed.graphKey !== binding.graphKey ||
        fixed.graphDigest !== binding.graphDigest ||
        fixed.engine !== binding.engine)
    )
      throw new ApiError('RUN_GRAPH_CHANGED', '任务固定图身份不匹配', 409)
  }
  async resolveCalls(
    snapshot: QuerySnapshot,
    methods: JavaMethod[],
    calls: JavaCall[],
    signal: AbortSignal
  ): Promise<string[]> {
    return this.pool.read(snapshot, signal, (db, binding) => {
      this.checkBinding(snapshot, binding)
      const view = this.view(snapshot, db),
        gaps = [...binding.gaps, ...view.gaps],
        facts: NonNullable<GraphBinding['facts']> = []
      for (const call of calls) {
        const caller = view.nodes.find((n) => n.method?.key === call.caller.key)
        const result = this.targets(call, caller, view.nodes, db)
        const raw = caller ? this.callEdges(call, caller, db)[0] : undefined
        facts.push({
          filePath: call.filePath,
          line: call.line,
          column: call.column,
          targets: result.nodes.map((n) => n.method!.key),
          verification:
            result.nodes.length === 1 && call.target?.key === result.nodes[0].method?.key
              ? 'verified-structural'
              : 'candidate',
          provenance: raw?.provenance ?? 'unspecified',
          resolvedBy: raw?.resolvedBy ?? 'unresolved',
          confidence: raw?.confidence ?? 0
        })
        if (result.nodes.length > 1) {
          call.target = null
          gaps.push(...result.gaps)
          continue
        }
        const target = result.nodes[0]?.method
        if (target) {
          const actual = methods.find((m) => m.key === target.key)
          if (actual && (!call.target || call.target.key === actual.key)) call.target = actual
          else gaps.push('GRAPH_TARGET_CONFLICT')
        }
        // Never mark semantic=true: graph agreement is structural evidence.
      }
      this.bindings.save(snapshot.projectId, snapshot.runId, {
        ...binding,
        gaps: [...new Set(gaps)],
        facts
      })
      return [...new Set(gaps)]
    })
  }
  async close(): Promise<void> {
    this.projection = undefined
    await this.pool.close()
  }
}
