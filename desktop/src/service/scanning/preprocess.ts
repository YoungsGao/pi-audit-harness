import { setImmediate } from 'node:timers/promises'
import { ApiError } from '../../shared/api-error.ts'
import type { CallEdge, CallEdgeInput, CandidateGraph } from '../../shared/call-chain-contracts'
import type { ScanOutput, ScanWarning } from '../../shared/scan-contracts'
import { builtinRules, findRiskCandidates } from '../rules/builtin.ts'
import { callEdgeUid } from '../storage/call-chain-repository.ts'
import { expandCandidatePaths } from '../chains/paths.ts'
import { indexJavaFile, resolveCallTargets } from './java-index.ts'
import type { JavaCall, JavaMethod } from './java-index.ts'

export async function preprocessJava(
  projectId: string,
  runId: string,
  sourceStamp: string,
  files: { filePath: string; source: string }[],
  signal: AbortSignal,
  limits: { maxResults?: number; maxDepth?: number; maxNodes?: number; maxPaths?: number } = {}
): Promise<ScanOutput> {
  const maxResults = limits.maxResults ?? 100,
    methods: JavaMethod[] = [],
    calls: JavaCall[] = []
  const warnings: ScanWarning[] = []
  const warn = (code: string, filePath: string | null, message: string): void => {
    if (warnings.length < 50) warnings.push({ code, filePath, message })
  }
  const risks: {
    candidate: ReturnType<typeof findRiskCandidates>[number]
    source: string
    failed: boolean
  }[] = []
  let candidateOverflow = false
  for (const file of files) {
    if (signal.aborted) throw new ApiError('QUERY_CANCELLED', '预处理已取消', 499)
    await setImmediate()
    let failed = false
    try {
      if (
        Buffer.byteLength(file.source, 'utf8') > 256 * 1024 ||
        methods.length > 5000 ||
        calls.length > 10000
      )
        throw new Error('JAVA_INDEX_LIMIT')
      const index = indexJavaFile(file.filePath, file.source)
      methods.push(...index.methods)
      calls.push(...index.calls)
      for (const warning of index.warnings) warn(warning.code, warning.filePath, warning.message)
    } catch {
      failed = true
      warn(
        'JAVA_PARSE_INCOMPLETE',
        file.filePath,
        'Java 语法解析失败或超过解析范围，保留文本 Sink 候选，不补造调用者。'
      )
    }
    const candidates = findRiskCandidates(file.filePath, file.source, maxResults + 1 - risks.length)
    for (const candidate of candidates) {
      if (risks.length >= maxResults) {
        candidateOverflow = true
        break
      }
      risks.push({ candidate, source: file.source, failed })
    }
  }
  resolveCallTargets(methods, calls)
  const edgeMap = new Map<string, CallEdge>(),
    sinkUids: string[] = [],
    entryByKey = new Map(methods.map((m) => [m.key, m.entry]))
  let unresolvedCalls = 0
  for (const call of calls) {
    const edge: CallEdgeInput = {
      filePath: call.filePath,
      callerKey: call.caller.key,
      calleeKey: call.target?.key ?? `unresolved:${call.receiver}.${call.name}/${call.arity}`,
      functionName: `${call.caller.owner}.${call.caller.name}(${call.caller.types.join(',')})`,
      calledFunctionName: call.target
        ? `${call.target.owner}.${call.target.name}(${call.target.types.join(',')})`
        : `${call.receiver ? call.receiver + '.' : ''}${call.name}(?)`,
      calledFilePath: call.target?.filePath ?? null,
      callLine: call.line,
      callColumn: call.column,
      resolutionStatus: call.target ? 'candidate' : 'unresolved',
      isSink: false,
      ruleId: null,
      arguments: []
    }
    const uid = callEdgeUid(runId, edge)
    edgeMap.set(uid, { ...edge, uid })
    if (!call.target) unresolvedCalls++
  }
  for (const { candidate, source } of risks) {
    const starts = [0]
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1)
    const start = starts[candidate.startLine - 1] + candidate.startColumn - 1
    const methodName = candidate.api.endsWith('.<init>')
      ? candidate.api.split('.')[0]
      : candidate.api.split('.').at(-1)!
    const matching = calls.filter(
      (call) =>
        call.filePath === candidate.filePath &&
        call.name === methodName &&
        call.start >= start &&
        call.open < start + candidate.text.indexOf('(') + 1
    )
    const call = matching[0]
    const edge: CallEdgeInput = {
      filePath: candidate.filePath,
      callerKey: call?.caller.key ?? candidate.filePath + '#<unresolved-owner>',
      calleeKey: call?.target?.key ?? 'text-candidate:' + candidate.api,
      functionName: call
        ? `${call.caller.owner}.${call.caller.name}(${call.caller.types.join(',')})`
        : '<unresolved-owner>',
      calledFunctionName: call?.target
        ? `${call.target.owner}.${call.target.name}(${call.target.types.join(',')})`
        : candidate.api,
      calledFilePath: call?.target?.filePath ?? null,
      callLine: call?.line ?? candidate.startLine,
      callColumn: call?.column ?? candidate.startColumn,
      isSink: true,
      ruleId: candidate.ruleId,
      resolutionStatus: 'candidate',
      arguments: candidate.arguments
    }
    const uid = callEdgeUid(runId, edge)
    if (edgeMap.has(uid) && edgeMap.get(uid)!.resolutionStatus === 'unresolved') unresolvedCalls--
    edgeMap.set(uid, { ...edge, uid })
    sinkUids.push(uid)
  }
  if (candidateOverflow)
    warn('CANDIDATE_LIMIT', null, '候选 Sink 数量超过上限，未覆盖的部分需新任务继续。')
  if (unresolvedCalls)
    warn(
      'CALL_TARGET_UNRESOLVED',
      null,
      `${unresolvedCalls} 个调用目标无法唯一定位；重载、外部依赖及动态分派不作确定推断。`
    )
  // 只持久化 Sink 的有界上游，避免把全仓库图塞进数据库。
  const incoming = new Map<string, CallEdge[]>()
  for (const edge of edgeMap.values())
    incoming.set(edge.calleeKey, [...(incoming.get(edge.calleeKey) ?? []), edge])
  const needed = new Map<string, CallEdge>(),
    queue = [...new Set(sinkUids)],
    scheduled = new Set(queue)
  let edgeLimit = false
  while (queue.length) {
    const uid = queue.shift()!
    if (needed.has(uid)) continue
    if (needed.size >= 1000) {
      edgeLimit = true
      break
    }
    const edge = edgeMap.get(uid)!
    needed.set(uid, edge)
    for (const parent of incoming.get(edge.callerKey) ?? [])
      if (!scheduled.has(parent.uid)) {
        scheduled.add(parent.uid)
        queue.push(parent.uid)
      }
  }
  if (edgeLimit) warn('EDGE_LIMIT', null, '上游图达到 1000 条边上限，路径已标记截断。')
  const paths: CandidateGraph['paths'] = []
  const maxPaths = limits.maxPaths ?? 100
  for (const sinkUid of [...new Set(sinkUids)]) {
    if (!needed.has(sinkUid)) continue
    if (paths.length >= maxPaths) {
      warn('PATH_LIMIT', null, '路径数量达到上限，未展开的分支需继续调查。')
      paths[paths.length - 1].truncated = true
      paths[paths.length - 1].truncationReason = 'path-limit'
      break
    }
    const sink = needed.get(sinkUid)!
    for (const path of expandCandidatePaths([...needed.values()], sinkUid, {
      maxDepth: limits.maxDepth,
      maxNodes: limits.maxNodes,
      maxPaths: maxPaths - paths.length
    })) {
      const first = needed.get(path.edgeUids[0])!
      const entry = entryByKey.get(first.callerKey) ?? false
      const reason = candidateOverflow
        ? 'candidate-limit'
        : edgeLimit
          ? 'node-limit'
          : path.truncationReason || (!entry ? 'unresolved-caller' : '')
      paths.push({
        ...path,
        sourceRef: (entry ? 'http-entry-candidate:' : 'method-boundary:') + first.callerKey,
        sinkEdgeUid: sinkUid,
        ruleId: sink.ruleId,
        truncated: !!reason,
        truncationReason: reason
      })
    }
  }
  if (paths.some((p) => p.truncated))
    warn('PATH_INCOMPLETE', null, '存在边界、递归或预算截断；未完成路径不表示安全。')
  const used = new Set(paths.flatMap((p) => p.edgeUids))
  const truncated = candidateOverflow || edgeLimit || paths.some((p) => p.truncated)
  return {
    graph: {
      projectId,
      runId,
      sourceStamp,
      rulesVersion: builtinRules.version,
      edges: [...needed.values()]
        .filter((e) => used.has(e.uid))
        .map(({ uid, ...edge }) => {
          void uid
          return edge
        }),
      paths
    },
    summary: {
      state: warnings.length ? 'partial' : risks.length ? 'ready' : 'empty',
      candidateCount: risks.length,
      unresolvedCalls,
      truncated,
      warnings
    }
  }
}
