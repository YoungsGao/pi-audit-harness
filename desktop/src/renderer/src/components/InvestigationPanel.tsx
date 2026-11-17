import type { StreamFrame } from '../../../shared/sse-contracts'
import type { PathDetail } from '../../../shared/scan-contracts'
import { isInvestigation } from '../../../shared/investigation'
import { asRecord, publicAnalysisText } from '../../../shared/path-detail-view'

export function InvestigationPanel({
  frames,
  detail,
  expired
}: {
  frames: StreamFrame[]
  detail: PathDetail
  expired: boolean
}): React.JSX.Element {
  const frame = frames.filter((f) => f.event === 'investigation_info').at(-1)
  const value = asRecord(frame?.data.details).payload
  const snapshot = isInvestigation(value) ? value : null
  const terminal = frames.findLast((f) =>
    ['completed', 'failed', 'stopped', 'timed_out', 'cancelled'].includes(f.event)
  )
  const phase =
    terminal && terminal.event !== 'completed'
      ? '已停止或失败，保留缺口'
      : snapshot
        ? {
            collecting: '收集材料',
            verifying: '核查传播与防护',
            repairing: '结论纠错',
            verified: '提交协议校验通过'
          }[snapshot.phase]
        : '等待实际调查记录'
  return (
    <section
      className="investigation-panel"
      aria-label="证据缺口驱动的调查面板"
      data-testid="investigation-panel"
    >
      <h4>证据调查 · {phase}</h4>
      <p>目标：核查 {detail.ruleId} 的输入来源、参数传播与有效防护。</p>
      <p className="muted">
        材料已读、关联候选和扫描发现分别记录；都不自动等于漏洞成立。以下建议由主机状态生成，不是模型隐藏推理。
      </p>
      {!snapshot ? (
        <p>当前尝试没有新版调查快照，请查看已保存工具时间线；不从缺失历史推测“已完成”。</p>
      ) : (
        <>
          <p role="status">
            {terminal && terminal.event !== 'completed'
              ? '本次调查已结束。请核对错误、已读材料与缺口后，再明确重试或恢复。'
              : snapshot.activeTool
                ? `正在执行：${snapshot.activeTool}`
                : snapshot.nextAction}
          </p>
          <div className="investigation-metrics">
            <span>
              已读 {snapshot.steps.filter((s) => s.read !== 'pending').length}/
              {snapshot.steps.length} 步
            </span>
            <span>工具 {snapshot.calls} 次</span>
            <span>请求 {snapshot.requests} 次</span>
            <span>纠错 {snapshot.repairs} 次</span>
            <span>证据 {snapshot.evidenceBytes} 字节</span>
            <span>
              已报告用量 {snapshot.meter.responses ? snapshot.meter.total : '未知'} Tokens
            </span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>步骤 / 源码</th>
                  <th>原文材料</th>
                  <th>关联补证</th>
                  <th>静态扫描</th>
                  <th>证据卡</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.steps.map((step) => (
                  <tr key={step.stepIndex}>
                    <td>
                      #{step.stepIndex} ·{' '}
                      {publicAnalysisText(detail.steps[step.stepIndex]?.edge.filePath ?? '')}
                    </td>
                    <td>
                      {
                        { pending: '未读', complete: '已读完整范围', partial: '读取不完整' }[
                          step.read
                        ]
                      }
                    </td>
                    <td>
                      {step.graph === 'pending' ? '未查询' : step.graph} · 已读 {step.relatedRead} /
                      候选 {step.related}
                    </td>
                    <td>
                      {step.scan === 'pending' ? '未执行' : step.scan} · 发现 {step.findings}
                    </td>
                    <td>{step.cards}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul>
            {snapshot.gaps.map((gap, i) => (
              <li key={i}>
                {gap.stepIndex === null ? '路径' : `步骤 ${gap.stepIndex}`}：
                {publicAnalysisText(gap.message)}
              </li>
            ))}
          </ul>
          {!snapshot.gaps.length && (
            <p>当前没有登记的材料缺口；实际漏洞判断以已提交结论及原文、传播校验为准。</p>
          )}
          <details>
            <summary>定位当前会话的真实工具回执</summary>
            <ul>
              {frames
                .filter((f) => f.event === 'tool_call_info')
                .map((f) => (
                  <li key={f.id}>
                    <a href={`#analysis-event-${f.id}`}>
                      #{f.id} · {String(asRecord(f.data.details).toolName ?? '工具')} ·{' '}
                      {f.data.message ?? '实际保存事件'}
                    </a>
                  </li>
                ))}
            </ul>
          </details>
          <p className="muted">
            状态来自已保存事件 #{frame!.id}；用量仅统计供应商实际报告的响应，缺失不按零费用计。
            {expired ? '部分早期事件已过期。' : ''}
          </p>
        </>
      )}
    </section>
  )
}
