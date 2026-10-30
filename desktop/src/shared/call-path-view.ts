import type { PathDetail, PathSummary } from './scan-contracts'
export interface PathGraphNode {
  id: string
  label: string
  kind: 'source' | 'function' | 'sink' | 'boundary'
  stepIndex: number
  target: 'caller' | 'callee'
  defense: boolean
}
export function pathGraphNodes(detail: PathDetail): PathGraphNode[] {
  const steps = [...detail.steps].sort((a, b) => a.stepIndex - b.stepIndex)
  if (!steps.length) return []
  const nodes: PathGraphNode[] = steps.map((step, index) => ({
    id: 'node-' + index,
    label: step.edge.functionName,
    kind:
      index === 0
        ? detail.sourceRef?.startsWith('http-entry-candidate:')
          ? 'source'
          : 'boundary'
        : 'function',
    stepIndex: step.stepIndex,
    target: 'caller',
    defense: (step.propagation.defense as { status?: string } | null)?.status === 'blocked'
  }))
  const last = steps.at(-1)!
  nodes.push({
    id: 'node-' + steps.length,
    label: last.edge.calledFunctionName,
    kind: last.edge.isSink ? 'sink' : 'function',
    stepIndex: last.stepIndex,
    target: last.edge.isSink ? 'caller' : 'callee',
    defense: false
  })
  return nodes
}
export function relatedPaths(detail: PathDetail, paths: PathSummary[]): PathSummary[] {
  return paths.filter(
    (path) =>
      path.projectId === detail.projectId &&
      path.runId === detail.runId &&
      path.sinkEdgeUid === detail.sinkEdgeUid &&
      path.ruleId === detail.ruleId &&
      path.pathId !== detail.pathId
  )
}
export function relationLabel(resolution: string): string {
  return resolution === 'confirmed'
    ? '已定位的静态关系'
    : resolution === 'invalid'
      ? '无效关系'
      : resolution === 'unresolved'
        ? '目标未解析'
        : '待确认关系'
}
