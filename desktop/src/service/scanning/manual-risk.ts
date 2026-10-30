import { ApiError } from '../../shared/api-error.ts'
import { queryInput, queryInteger, queryText } from '../query/service.ts'
import type { SnapshotRepository } from '../storage/snapshot-repository'
import type { CallChainRepository } from '../storage/call-chain-repository'
import { indexJavaFile } from './java-index.ts'
import { preprocessJava } from './preprocess.ts'
import { builtinRules, findRiskCandidates } from '../rules/builtin.ts'

export async function addManualRisk(
  repo: CallChainRepository,
  snapshots: SnapshotRepository,
  value: unknown,
  signal: AbortSignal
): Promise<unknown> {
  const row = queryInput(value, [
    'projectId',
    'runId',
    'filePath',
    'line',
    'column',
    'functionKey',
    'ruleId',
    'note'
  ])
  if (row.line === undefined)
    throw new ApiError('MANUAL_LOCATION_INVALID', '请指定快照文件中的行号', 400)
  const projectId = queryText(row.projectId, 80),
    runId = queryText(row.runId, 80),
    filePath = queryText(row.filePath, 1000),
    line = queryInteger(row.line, 1, 1000000),
    column = queryInteger(row.column, 1, 1000000),
    ruleId = queryText(row.ruleId, 100),
    note = queryText(row.note, 2000),
    snapshot = snapshots.info(projectId, runId)
  if (!builtinRules.rules.some((rule) => rule.id === ruleId))
    throw new ApiError('MANUAL_RULE_INVALID', '请选择内置规则 ID', 400)
  const source = snapshots.read(projectId, runId, filePath),
    lines = source.split('\n')
  if (line > lines.length || column > lines[line - 1].length + 1 || !lines[line - 1].trim())
    throw new ApiError('MANUAL_LOCATION_INVALID', '行列超出快照文件范围，或指定行为空', 400)
  const offset = lines.slice(0, line - 1).reduce((n, s) => n + s.length + 1, 0) + column - 1
  let index: ReturnType<typeof indexJavaFile> | undefined
  try {
    if (Buffer.byteLength(source) <= 256 * 1024) index = indexJavaFile(filePath, source)
  } catch {
    /* 语法不完整仍可登记位置。 */
  }
  const method = index?.methods.find((m) => offset >= m.start && offset <= m.end)
  if (row.functionKey !== undefined && queryText(row.functionKey, 1000) !== method?.key)
    throw new ApiError(
      'MANUAL_FUNCTION_INVALID',
      '函数标识与指定快照位置不匹配；可留空按行列调查',
      400
    )
  const calls =
    index?.calls.filter((c) =>
      row.column === undefined ? c.line === line : c.start <= offset && c.end >= offset
    ) ?? []
  if (row.column === undefined && calls.length > 1)
    throw new ApiError(
      'MANUAL_LOCATION_AMBIGUOUS',
      '该行有多个调用，请填写具体列号确定调查位置',
      400
    )
  const call = calls.sort((a, b) => a.end - a.start - (b.end - b.start))[0]
  const startLine = call?.line ?? line,
    startColumn = call?.column ?? column
  const automatic = findRiskCandidates(filePath, source, 100).find(
    (c) => c.startLine === startLine && c.startColumn === startColumn && c.ruleId === ruleId
  )
  const candidate = automatic ?? {
    filePath,
    startLine,
    startColumn,
    endLine: call ? source.slice(0, call.end + 1).split('\n').length : line,
    endColumn: startColumn + 1,
    text: call ? source.slice(call.start, call.end + 1) : lines[line - 1],
    ruleId,
    api: call ? [call.receiver, call.name].filter(Boolean).join('.') : 'manual-location',
    resolutionStatus: 'candidate' as const,
    arguments: []
  }
  const files = snapshot.files.map((file) => ({
    filePath: file.filePath,
    source: snapshots.read(projectId, runId, file.filePath)
  }))
  const output = await preprocessJava(
    projectId,
    runId,
    snapshot.sourceStamp,
    files,
    signal,
    {},
    candidate
  )
  for (const path of output.graph.paths)
    path.sourceRef = path.sourceRef + `;manual=${filePath}:${line}:${column}`
  if (signal.aborted) throw new ApiError('QUERY_CANCELLED', '手工风险点登记已取消', 499)
  const saved = repo.saveGraph(output.graph, undefined, {
    snapshotId: snapshot.snapshotId,
    filePath,
    line,
    column,
    functionKey: method?.key ?? null,
    ruleId,
    note
  })
  return { ...saved, snapshotId: snapshot.snapshotId }
}
