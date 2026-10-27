import type { StreamFrame } from '../../../shared/sse-contracts'
import { asRecord, publicAnalysisText, publicAnalysisValue } from '../../../shared/path-detail-view'
import { analysisErrorHelp } from '../../../shared/analysis-view'

export function AnalysisTimeline({ frames }: { frames: StreamFrame[] }): React.JSX.Element {
  return (
    <section className="analysis-timeline" aria-label="按序号排列的分析记录">
      <h4>调试时间线 · 按会话内事件序号排列</h4>
      <p className="muted">
        仅展示实际保存的公开摘要与调试事件。事件未记录独立时间戳时使用序号，不补造时间或隐藏推理。
      </p>
      {!frames.length && (
        <p>当前会话没有可展示的分析记录；可能尚未分析、记录缺失或尚未读取成功。</p>
      )}
      {frames.length > 0 && frames[0].id > 1 && (
        <p>当前视图从事件 #{frames[0].id} 开始，未展示更早记录。</p>
      )}
      <ol data-testid="analysis-timeline">
        {frames.map((frame) => {
          const info = asRecord(publicAnalysisValue(frame.data.details))
          const payload = asRecord(info.payload)
          const isTool = typeof info.toolName === 'string'
          const code = typeof payload.errorCode === 'string' ? payload.errorCode : ''
          const phase = isTool
            ? code
              ? '失败'
              : typeof info.durationMs === 'number'
                ? '完成'
                : payload.input !== undefined
                  ? '开始'
                  : '阶段未记录'
            : ''
          return (
            <li key={frame.data.sessionId + ':' + frame.id} data-event-id={frame.id}>
              <strong>
                #{frame.id} · {frame.event}
                {phase && ' · 工具' + phase}
              </strong>
              <p>
                {publicAnalysisText(
                  frame.data.message ??
                    (frame.data.type === 'thinking'
                      ? '模型未提供可公开分析摘要。'
                      : '本事件未提供摘要。')
                )}
              </p>
              {isTool && (
                <p>
                  工具：{String(info.toolName)} · toolCallId={String(info.toolCallId ?? '未记录')}
                  {typeof info.durationMs === 'number' &&
                    ` · 耗时 ${Math.round(info.durationMs)} ms`}
                </p>
              )}
              {frame.data.type === 'result' && (
                <p>
                  最终判断依据：{publicAnalysisText(frame.data.message ?? '本会话未保存判断说明。')}
                </p>
              )}
              {code && (
                <p role="alert">
                  {code}：{analysisErrorHelp(code)}
                </p>
              )}
              {info.truncated === true && <p>此事件保存时已截断，输入输出可能不完整。</p>}
              <details>
                <summary>工具输入输出 / 已保存事件详情（脱敏）</summary>
                {isTool && (
                  <>
                    <h5>工具输入</h5>
                    <pre>
                      {payload.input === undefined
                        ? '本条记录未保存输入，可按 toolCallId 对照开始事件。'
                        : JSON.stringify(payload.input, null, 2)}
                    </pre>
                    <h5>工具输出</h5>
                    <pre>
                      {payload.output === undefined
                        ? '本条记录未保存输出；开始或失败事件不代表已有输出。'
                        : JSON.stringify(payload.output, null, 2)}
                    </pre>
                  </>
                )}
                <pre>{JSON.stringify(info, null, 2)}</pre>
              </details>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
