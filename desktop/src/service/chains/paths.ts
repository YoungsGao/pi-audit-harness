import { ApiError } from '../../shared/api-error.ts'
import type {
  CallEdge,
  CandidatePath,
  TruncationReason
} from '../../shared/call-chain-contracts.ts'

export function expandCandidatePaths(
  edges: CallEdge[],
  sinkUid: string,
  limits: { maxDepth?: number; maxNodes?: number; maxPaths?: number } = {}
): CandidatePath[] {
  const maxDepth = limits.maxDepth ?? 16,
    maxNodes = limits.maxNodes ?? 512,
    maxPaths = limits.maxPaths ?? 100
  if (
    ![maxDepth, maxNodes, maxPaths].every(Number.isInteger) ||
    maxDepth < 1 ||
    maxDepth > 32 ||
    maxNodes < 1 ||
    maxNodes > 2000 ||
    maxPaths < 1 ||
    maxPaths > 100 ||
    edges.length > 1000
  )
    throw new ApiError('CHAIN_INVALID_INPUT', '调用链展开预算超出支持范围', 400)
  const sink = edges.find((e) => e.uid === sinkUid)
  if (!sink) throw new ApiError('CHAIN_INVALID_INPUT', 'Sink 调用边不存在', 400)
  const incoming = new Map<string, CallEdge[]>()
  for (const edge of edges)
    incoming.set(edge.calleeKey, [...(incoming.get(edge.calleeKey) ?? []), edge])
  for (const parents of incoming.values())
    parents.sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
  const paths: CandidatePath[] = []
  let visits = 0,
    stopped: TruncationReason = ''
  const emit = (path: CallEdge[], reason: TruncationReason): void => {
    paths.push({ edgeUids: path.map((e) => e.uid), truncated: !!reason, truncationReason: reason })
  }
  const walk = (path: CallEdge[]): void => {
    if (stopped) return
    if (paths.length >= maxPaths) {
      stopped = 'path-limit'
      return
    }
    if (visits++ >= maxNodes) {
      stopped = 'node-limit'
      return
    }
    const parents = incoming.get(path[0].callerKey) ?? []
    if (!parents.length) {
      emit(path, '')
      return
    }
    if (path.length >= maxDepth) {
      emit(path, 'depth-limit')
      return
    }
    for (const parent of parents) {
      if (paths.length >= maxPaths) {
        stopped = 'path-limit'
        break
      }
      if (path.some((edge) => edge.uid === parent.uid)) emit([parent, ...path], 'recursion')
      else walk([parent, ...path])
      if (stopped) break
    }
  }
  walk([sink])
  // 全局预算耗尽也有显式标记，不能让调用方误以为已枚举全部分支。
  if (stopped) {
    if (!paths.length) emit([sink], stopped)
    else {
      paths[paths.length - 1].truncated = true
      paths[paths.length - 1].truncationReason = stopped
    }
  }
  return paths
}
