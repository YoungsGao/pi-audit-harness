import type { StreamFrame } from './sse-contracts'

export function mergeAnalysisFrames(
  previous: StreamFrame[],
  incoming: StreamFrame[],
  scope: { projectId: string; runId: string; chainId: string },
  sessionId: string
): StreamFrame[] {
  const unique = new Map<number, StreamFrame>()
  for (const frame of [...previous, ...incoming]) {
    const d = frame.data
    if (
      d.projectId === scope.projectId &&
      d.runId === scope.runId &&
      d.chainId === scope.chainId &&
      d.sessionId === sessionId
    )
      unique.set(frame.id, frame)
  }
  return [...unique.values()].sort((a, b) => a.id - b.id).slice(-200)
}
export function analysisErrorHelp(code: string): string {
  if (code === 'AGENT_DECISION_INVALID')
    return '模型回复未符合约定的 JSON 决策格式或字段要求；取证成功不代表结论有效。重连只重放旧记录，需排查输出格式后明确重试。'
  if (/ANALYSIS_(?:EVIDENCE|TAINT|RESULT)_INVALID/.test(code))
    return '模型结论、证据引用或传播核查未通过校验，风险保持未知；查看已保存工具输入输出，不能将读取源码成功当作审计完成。'
  if (/PERSISTENCE|^DB_/.test(code))
    return '写库未确认。检查磁盘空间、目录权限和数据库锁，再重启服务恢复；不要把运行中记录当作成功。'
  if (/SOURCE_CHANGED|SOURCE_STAMP|RULES_CHANGED/.test(code))
    return '源码或规则版本已变化。重新登记源码并新建预处理任务，保留原任务与报告。'
  if (/HISTORY_EXPIRED/.test(code))
    return '历史事件已过期。刷新历史读取仍保留的事件，并核对数据库结果。'
  if (/MODEL|PI_|AGENT_TIMEOUT/.test(code))
    return '检查所选模型的地址、凭据和连通性。失败路径保持未知；确认后可明确重试当前路径。'
  if (/SSE_/.test(code))
    return '事件连接异常不代表分析失败或成功。可按原会话游标重连；重连不重新调用模型。'
  if (/GIT|DOWNLOAD/.test(code))
    return '下载未完成。检查 Git、网络和仓库地址后重新导入，失败副本不会登记为可用项目。'
  return '刷新数据库状态查看原因；失败任务不会自动作为成功处理。'
}
