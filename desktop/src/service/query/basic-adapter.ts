import type {
  QueryRequest,
  QueryItem,
  QuerySymbol,
  QueryLocation
} from '../../shared/query-contracts.ts'
import type { QuerySnapshot } from './java-runtime.ts'
import { indexJavaFile, resolveCallTargets } from '../scanning/java-index.ts'
import type { JavaMethod } from '../scanning/java-index.ts'

export function basicQuery(
  snapshot: QuerySnapshot,
  request: QueryRequest
): { items: QueryItem[]; gaps: string[] } {
  const items: QueryItem[] = [],
    gaps: string[] = []
  if (request.operation === 'search') {
    for (const file of snapshot.files)
      for (const [i, line] of file.source.split('\n').entries()) {
        let offset = 0,
          found: number
        while ((found = line.indexOf(request.text!, offset)) >= 0) {
          items.push({
            location: {
              filePath: file.filePath,
              start: { line: i + 1, column: found + 1 },
              end: { line: i + 1, column: found + request.text!.length + 1 }
            },
            text:
              line.length <= 2000
                ? line
                : line.slice(Math.max(0, found - 200), found + request.text!.length + 200),
            symbol: null,
            resolution: 'candidate'
          })
          if (line.length > 2000 && !gaps.includes('SOURCE_EXCERPT_TRUNCATED'))
            gaps.push('SOURCE_EXCERPT_TRUNCATED')
          if (items.length > (request.maxResults ?? 50)) return { items, gaps }
          offset = found + request.text!.length
        }
      }
    return { items, gaps }
  }
  const methods: JavaMethod[] = [],
    calls: ReturnType<typeof indexJavaFile>['calls'] = []
  for (const file of snapshot.files) {
    try {
      if (
        Buffer.byteLength(file.source) > 256 * 1024 ||
        methods.length > 5000 ||
        calls.length > 10000
      )
        throw Error('limit')
      const index = indexJavaFile(file.filePath, file.source)
      methods.push(...index.methods)
      calls.push(...index.calls)
      gaps.push(...index.warnings.map((w) => w.code))
    } catch {
      gaps.push('JAVA_PARSE_INCOMPLETE')
    }
  }
  resolveCallTargets(methods, calls)
  const methodItem = (method: JavaMethod): QueryItem => {
    const source = snapshot.files.find((f) => f.filePath === method.filePath)!.source
    const line = source.slice(0, method.start).split('\n').length
    const column = method.start - (source.lastIndexOf('\n', method.start - 1) + 1) + 1
    const endOffset = method.end + 1
    const endLine = source.slice(0, endOffset).split('\n').length
    const endColumn = endOffset - (source.lastIndexOf('\n', endOffset - 1) + 1) + 1
    const location: QueryLocation = {
      filePath: method.filePath,
      start: { line, column },
      end: { line: endLine, column: endColumn }
    }
    const signature = `${method.name}(${method.types.join(',')})`
    const symbol: QuerySymbol = {
      name: method.name,
      qualifiedName: method.owner + '.' + signature,
      signature,
      kind: 6,
      location,
      resolution: 'candidate'
    }
    return {
      symbol,
      location,
      text: source.slice(method.start, Math.min(method.end + 1, method.start + 2000)),
      resolution: 'candidate'
    }
  }
  if (request.operation === 'symbols')
    return { items: methods.filter((m) => m.filePath === request.filePath).map(methodItem), gaps }
  const source = snapshot.files.find((f) => f.filePath === request.filePath)!.source
  const line = source.split('\n')[request.line! - 1] ?? ''
  const left = line.slice(0, request.column! - 1).match(/[\p{L}\p{N}_$]+$/u)?.[0] ?? ''
  const right = line.slice(request.column! - 1).match(/^[\p{L}\p{N}_$]+/u)?.[0] ?? ''
  const name = left + right
  const targets = methods.filter((m) => m.name === name)
  if (request.operation === 'definition') return { items: targets.map(methodItem), gaps }
  if (request.operation === 'references') {
    for (const call of calls.filter((c) => c.name === name)) {
      const location = {
        filePath: call.filePath,
        start: { line: call.line, column: call.column },
        end: { line: call.line, column: call.column + call.name.length }
      }
      items.push({
        location,
        symbol: call.target ? methodItem(call.target).symbol : null,
        text: call.name,
        resolution: 'candidate'
      })
    }
    return { items, gaps }
  }
  const offset =
    source
      .split('\n')
      .slice(0, request.line! - 1)
      .reduce((n, row) => n + row.length + 1, 0) +
    request.column! -
    1
  const own = methods
    .filter((m) => m.filePath === request.filePath && m.start <= offset && m.end >= offset)
    .sort((a, b) => a.end - a.start - (b.end - b.start))[0]
  for (const call of calls) {
    if (request.operation === 'incomingCalls' && call.name !== name) continue
    if (request.operation === 'outgoingCalls' && call.caller !== own) continue
    const method = request.operation === 'incomingCalls' ? call.caller : call.target
    if (!method) {
      gaps.push('CALL_TARGET_UNRESOLVED')
      continue
    }
    items.push({
      ...methodItem(method),
      callSite: {
        filePath: call.filePath,
        start: { line: call.line, column: call.column },
        end: { line: call.line, column: call.column + call.name.length }
      }
    })
  }
  return { items, gaps }
}
