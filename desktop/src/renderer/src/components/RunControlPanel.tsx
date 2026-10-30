import { useEffect, useRef, useState } from 'react'
import type { RunRecoveryView, ControlState, RecoveryMode } from '../../../shared/run-contracts'
import { publicAnalysisText } from '../../../shared/path-detail-view'
const states: Record<ControlState, string> = {
  idle: '待执行',
  running: '正在分析',
  stop_requested: '停止请求已受理',
  waiting_external: '正在等待在途操作退出',
  stopped: '已停止',
  interrupted: '执行已中断',
  completed: '已完成'
}
const modes: Record<RecoveryMode, string> = {
  none: '没有中断路径',
  native: '从已验证的会话检查点继续',
  rebuild: '使用已核验的证据重建上下文',
  restart: '从当前未提交路径开始',
  blocked: '原条件暂不满足，已阻止续跑'
}
export function RunControlPanel({
  projectId,
  runId,
  onChanged
}: {
  projectId: string
  runId: string
  onChanged: () => void
}): React.JSX.Element {
  const [view, setView] = useState<RunRecoveryView | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [revision, refresh] = useState(0)
  const mounted = useRef(false),
    locked = useRef(false)
  useEffect(() => {
    mounted.current = true
    let active = true,
      reading = false
    const read = async (): Promise<void> => {
      if (reading || locked.current) return
      reading = true
      try {
        const result = await window.audit.audit('recovery', { projectId, runId })
        if (!active) return
        if (!result.ok) throw Error(result.error.code + '：' + result.error.message)
        setView(result.data as RunRecoveryView)
        setError('')
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : '恢复清单读取失败')
      } finally {
        reading = false
      }
    }
    void read()
    const timer = setInterval(() => void read(), 2000)
    return () => {
      active = false
      mounted.current = false
      clearInterval(timer)
    }
  }, [projectId, runId, revision])
  async function act(action: 'stop' | 'resume'): Promise<void> {
    if (locked.current || !view) return
    locked.current = true
    setBusy(true)
    setError('')
    try {
      const result = await window.audit.audit(action, {
        projectId,
        runId,
        ...(action === 'resume' ? { expectedRecoveryKey: view.recoveryKey, maxPaths: 10 } : {})
      })
      if (!mounted.current) return
      if (!result.ok) throw Error(result.error.code + '：' + result.error.message)
      const data = result.data as RunRecoveryView
      setView(data)
      setMessage(
        action === 'stop'
          ? data.state === 'stopped'
            ? '任务已停止，已提交结果已保留'
            : '停止请求已受理，已阻止新工作；请以任务控制状态确认退出结果，远端用量以供应商记录为准'
          : '已按核对后的清单继续，累计预算保留；最多处理10条路径'
      )
      onChanged()
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : '任务控制未确认成功')
    } finally {
      locked.current = false
      if (mounted.current) {
        setBusy(false)
        refresh((n) => n + 1)
      }
    }
  }
  return (
    <section
      className="run-control-panel"
      aria-label="任务停止与可验证恢复"
      data-testid="run-control-panel"
    >
      <div className="review-heading">
        <div>
          <h3>任务控制与恢复</h3>
          <p className="muted">
            保留已提交结果，按原快照与审查材料继续；重新打开页面不会自动调用模型。
          </p>
        </div>
        <strong data-testid="run-control-state">
          {view ? states[view.state] : '正在读取任务状态…'}
        </strong>
      </div>
      {view && (
        <>
          <p>
            已提交 {view.committedPaths} 条 · 中断或未完成 {view.interruptedPaths} 条 · 尚未开始{' '}
            {view.pendingPaths} 条
          </p>
          <div className="review-actions">
            <button
              type="button"
              data-testid="stop-run"
              disabled={busy || !['running'].includes(view.state)}
              onClick={() => void act('stop')}
            >
              停止当前任务
            </button>
            <button
              type="button"
              className="button-primary"
              data-testid="resume-run"
              disabled={busy || !view.canResume}
              onClick={() => void act('resume')}
            >
              按恢复清单继续
            </button>
            <button type="button" disabled={busy} onClick={() => refresh((n) => n + 1)}>
              刷新恢复清单
            </button>
          </div>
          {view.candidatePathId && (
            <details open className="recovery-manifest" data-testid="recovery-manifest">
              <summary>恢复清单：{modes[view.mode]}</summary>
              <p>
                已核验读取步骤：{view.readSteps.map((i) => i + 1).join('、') || '尚无'}；仍待核查：
                {view.remainingSteps.map((i) => i + 1).join('、') || '无新增步骤；仍需核对结论'}
              </p>
              <p>
                本路径累计：模型请求 {view.requestsUsed} 次 · 工具 {view.toolsUsed} 次 · 应用轮次{' '}
                {view.roundsUsed} 次；其中 {view.uncertainRequests} 次模型请求的完成用量未确认。
              </p>
              <ul>
                {view.reasons.map((reason, i) => (
                  <li key={i}>{publicAnalysisText(reason)}</li>
                ))}
              </ul>
              <p className="muted">
                已读取表示材料已取到，不代表风险成立。恢复不会重置预算，已提交路径不会重复调查。
              </p>
            </details>
          )}
          {view.lastRecovery && (
            <p data-testid="last-recovery">
              最近恢复：{modes[view.lastRecovery.mode]}；复用步骤{' '}
              {view.lastRecovery.reusedSteps.map((i) => i + 1).join('、') || '无'}。
              {publicAnalysisText(view.lastRecovery.reason)}
            </p>
          )}
        </>
      )}
      {message && (
        <p role="status" data-testid="run-control-message">
          {message}
        </p>
      )}
      {error && <p role="alert">{publicAnalysisText(error)}。当前控制状态未确认，请刷新后核对。</p>}
      {view?.state === 'waiting_external' && (
        <p role="status">
          尚未确认停止完成。不会领取新路径；无法证明供应商已经取消计算或停止计费。
        </p>
      )}
    </section>
  )
}
