import { fileURLToPath, pathToFileURL } from 'node:url'
import { isAbsolute, join, relative, sep } from 'node:path'
import type {
  QueryItem,
  QueryLocation,
  QueryRequest,
  QuerySymbol
} from '../../shared/query-contracts.ts'
import { ApiError } from '../../shared/api-error.ts'
import { fromLspPosition, toLspPosition } from './positions.ts'
import { maskJava } from '../rules/builtin.ts'
import type { QuerySnapshot } from './java-runtime.ts'
import type { QueryAdapterContext, QueryAdapterOutput } from './language-registry.ts'
type Position = { line: number; character: number }
type Range = { start: Position; end: Position }
type Location = { uri: string; range: Range }
type SymbolInfo = {
  name: string
  detail?: string
  kind: number
  range: Range
  selectionRange?: Range
  children?: SymbolInfo[]
  location?: Location
  containerName?: string
}
type Hierarchy = {
  name: string
  detail?: string
  kind: number
  uri: string
  range: Range
  selectionRange: Range
  data?: unknown
}

export function sourceText(snapshot: QuerySnapshot, location: QueryLocation): string {
  const source = snapshot.files.find((f) => f.filePath === location.filePath)!.source.split('\n')
  const { start, end } = location
  if (start.line === end.line)
    return source[start.line - 1].slice(start.column - 1, end.column - 1).slice(0, 2000)
  return [
    source[start.line - 1].slice(start.column - 1),
    ...source.slice(start.line, end.line - 1),
    source[end.line - 1].slice(0, end.column - 1)
  ]
    .join('\n')
    .slice(0, 2000)
}
function contains(range: QueryLocation, position: QueryLocation['start']): boolean {
  return (
    (position.line > range.start.line ||
      (position.line === range.start.line && position.column >= range.start.column)) &&
    (position.line < range.end.line ||
      (position.line === range.end.line && position.column <= range.end.column))
  )
}
export async function semanticJava(
  runtime: QueryAdapterContext,
  request: QueryRequest,
  signal: AbortSignal
): Promise<QueryAdapterOutput> {
  const snapshot = runtime.snapshot,
    gaps: string[] = ['JAVA_SOURCE_ONLY_NO_BUILD_CLASSPATH', ...runtime.sourceGaps]
  const local = (uri: string, range: Range): QueryLocation | null => {
    let filePath: string
    try {
      const url = new URL(uri)
      if (url.protocol !== 'file:') throw Error('external')
      filePath = relative(runtime.root, fileURLToPath(url)).split(sep).join('/')
    } catch {
      gaps.push('EXTERNAL_LOCATION_OMITTED')
      return null
    }
    if (
      isAbsolute(filePath) ||
      filePath === '..' ||
      filePath.startsWith('../') ||
      !snapshot.files.some((f) => f.filePath === filePath)
    ) {
      gaps.push('EXTERNAL_LOCATION_OMITTED')
      return null
    }
    const source = snapshot.files.find((f) => f.filePath === filePath)!.source
    const start = fromLspPosition(source, range.start, runtime.state.positionEncoding),
      end = fromLspPosition(source, range.end, runtime.state.positionEncoding)
    if (end.line < start.line || (end.line === start.line && end.column < start.column))
      throw new ApiError('QUERY_BACKEND_OUTPUT', '语言服务器范围倒置', 502)
    return { filePath, start, end }
  }
  const symbols = async (
    filePath: string
  ): Promise<{ symbol: QuerySymbol; extent: QueryLocation }[]> => {
    const uri = pathToFileURL(join(runtime.root, filePath)).href
    const response = await runtime.request(
      'textDocument/documentSymbol',
      { textDocument: { uri } },
      signal
    )
    if (response === null) return []
    if (!Array.isArray(response)) throw new ApiError('QUERY_BACKEND_OUTPUT', '符号结果无效', 502)
    const result: { symbol: QuerySymbol; extent: QueryLocation }[] = []
    const visit = (rows: SymbolInfo[], parents: string[], depth = 0): void => {
      if (depth > 32 || result.length > 10000)
        throw new ApiError('QUERY_BACKEND_OUTPUT', '符号结果超限', 502)
      for (const row of rows) {
        if (typeof row.name !== 'string' || row.name.length > 1000 || !Number.isInteger(row.kind))
          throw new ApiError('QUERY_BACKEND_OUTPUT', '符号字段无效', 502)
        const uriFor = row.location?.uri ?? uri
        const location = local(uriFor, row.selectionRange ?? row.location?.range ?? row.range)
        const extent = local(uriFor, row.location?.range ?? row.range)
        if (!location || !extent) continue
        const qualifiedName = [...parents, row.containerName, row.name].filter(Boolean).join('.')
        result.push({
          symbol: {
            name: row.name,
            qualifiedName,
            signature: row.name + (row.detail ?? ''),
            kind: row.kind,
            location,
            resolution: 'semantic'
          },
          extent
        })
        if (row.children) visit(row.children, [...parents, row.name], depth + 1)
      }
    }
    visit(response, [])
    // JDT DocumentSymbol 的树有类型和完整重载签名；package 声明补充限定名。
    const packageName = /\bpackage\s+([\p{L}\p{N}_$.]+)\s*;/u.exec(
      maskJava(snapshot.files.find((f) => f.filePath === filePath)!.source)
    )?.[1]
    if (packageName)
      for (const item of result)
        if (!item.symbol.qualifiedName.startsWith(packageName + '.'))
          item.symbol.qualifiedName = packageName + '.' + item.symbol.qualifiedName
    return result
  }
  const filePath = request.filePath!,
    source = snapshot.files.find((f) => f.filePath === filePath)!.source
  const uri = pathToFileURL(join(runtime.root, filePath)).href
  const document = { textDocument: { uri } }
  if (request.operation === 'symbols') {
    const result = await symbols(filePath)
    return {
      items: result.map(({ symbol }) => ({
        symbol,
        location: symbol.location,
        text: sourceText(snapshot, symbol.location),
        resolution: 'semantic'
      })),
      gaps
    }
  }
  const position = toLspPosition(
    source,
    { line: request.line!, column: request.column! },
    runtime.state.positionEncoding
  )
  if (request.operation === 'incomingCalls' || request.operation === 'outgoingCalls') {
    const prepared = await runtime.request(
      'textDocument/prepareCallHierarchy',
      { ...document, position },
      signal
    )
    if (prepared === null) return { items: [], gaps }
    if (!Array.isArray(prepared))
      throw new ApiError('QUERY_BACKEND_OUTPUT', '调用层次结果无效', 502)
    const items: QueryItem[] = []
    for (const item of (prepared as Hierarchy[]).slice(0, 4)) {
      const calls = await runtime.request(
        request.operation === 'incomingCalls'
          ? 'callHierarchy/incomingCalls'
          : 'callHierarchy/outgoingCalls',
        { item },
        signal
      )
      if (calls === null) continue
      if (!Array.isArray(calls)) throw new ApiError('QUERY_BACKEND_OUTPUT', '调用关系无效', 502)
      for (const call of calls.slice(0, (request.maxResults ?? 50) + 1)) {
        const target: Hierarchy = request.operation === 'incomingCalls' ? call.from : call.to
        const extent = local(target.uri, target.range)
        if (!extent) continue
        // JDT-LS 的 incomingCalls 可能把 selectionRange 改成调用点；声明位置从 outline 还原。
        const outline = runtime.state.capabilities.includes('symbols')
          ? await symbols(extent.filePath)
          : []
        const declaration = outline.find(
          (row) => row.symbol.kind === target.kind && contains(row.extent, extent.start)
        )?.symbol
        const name = String(target.name),
          qualifiedName = [target.detail, name].filter(Boolean).join('.')
        const symbol: QuerySymbol = declaration ?? {
          name,
          qualifiedName,
          signature: name,
          kind: target.kind,
          location: extent,
          resolution: 'semantic'
        }
        for (const range of ((call.fromRanges as Range[]) ?? []).slice(0, 101)) {
          const callSite = local(
            request.operation === 'incomingCalls' ? target.uri : item.uri,
            range
          )
          if (callSite)
            items.push({
              symbol,
              location: symbol.location,
              text: sourceText(snapshot, symbol.location),
              resolution: 'semantic',
              callSite
            })
        }
      }
      if (calls.length > (request.maxResults ?? 50)) gaps.push('QUERY_RESULT_LIMIT')
    }
    if (prepared.length > 4) gaps.push('HIERARCHY_ROOT_LIMIT')
    return { items, gaps }
  }
  const response = await runtime.request(
    request.operation === 'definition' ? 'textDocument/definition' : 'textDocument/references',
    {
      ...document,
      position,
      ...(request.operation === 'references' ? { context: { includeDeclaration: true } } : {})
    },
    signal
  )
  const locations = response === null ? [] : Array.isArray(response) ? response : [response]
  const items: QueryItem[] = []
  const outlines = new Map<string, Awaited<ReturnType<typeof symbols>>>()
  if (locations.length > (request.maxResults ?? 50)) gaps.push('QUERY_RESULT_LIMIT')
  for (const item of locations.slice(0, (request.maxResults ?? 50) + 1) as (Location & {
    targetUri?: string
    targetSelectionRange?: Range
  })[]) {
    const location = local(item.targetUri ?? item.uri, item.targetSelectionRange ?? item.range)
    if (!location) continue
    let symbol: QuerySymbol | null = null
    if (runtime.state.capabilities.includes('symbols')) {
      let outline = outlines.get(location.filePath)
      if (!outline) {
        outline = await symbols(location.filePath)
        outlines.set(location.filePath, outline)
      }
      // 定义对应完整声明；引用不把调用者方法误作被引用符号。
      const exact = outline.find((row) => contains(row.symbol.location, location.start))
      symbol = exact?.symbol ?? null
    }
    items.push({ location, symbol, text: sourceText(snapshot, location), resolution: 'semantic' })
  }
  if (request.operation === 'references' && items.some((item) => !item.symbol)) {
    const definitions = await semanticJava(runtime, { ...request, operation: 'definition' }, signal)
    const target = definitions.items.find((item) => item.symbol)?.symbol ?? null
    for (const item of items) item.symbol = target
    gaps.push(...definitions.gaps)
  }
  return { items, gaps }
}
