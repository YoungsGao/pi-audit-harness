import { useEffect, useRef, useState } from 'react'
import type { PathDetail } from '../../../shared/scan-contracts'
import type { HumanReview, ReviewStatus } from '../../../shared/review-contracts'
import { reviewLabels, reviewStates } from '../../../shared/review-contracts'
import { publicAnalysisText } from '../../../shared/path-detail-view'
export function HumanReviewPanel({ detail }: { detail: PathDetail }): React.JSX.Element {
  const { projectId, runId, pathId } = detail
  const [record, setRecord] = useState<HumanReview | null>(null),
    [status, setStatus] = useState<ReviewStatus>('unreviewed'),
    [note, setNote] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('正在读取人工复核…')
  const alive = useRef(false),
    locked = useRef(false)
  useEffect(() => {
    let active = true
    alive.current = true
    void window.audit
      .reviews('get', { projectId, runId, pathId })
      .then((result) => {
        if (!active) return
        if (!result.ok) throw new Error(result.error.code + '：' + result.error.message)
        const data = result.data as HumanReview
        setRecord(data)
        setStatus(data.status)
        setNote(data.note)
        setMessage(data.revision ? '已保存的独立人工记录' : '尚无人工记录；机器结论保持原样')
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : '复核读取失败')
      })
    return () => {
      active = false
      alive.current = false
    }
  }, [projectId, runId, pathId])
  const machineMoved =
    record &&
    (record.current.updatedAt !== detail.updatedAt ||
      record.current.status !== detail.status ||
      record.current.verdict !== detail.verdict)
  async function act(save: boolean): Promise<void> {
    if (locked.current || !record) return
    locked.current = true
    setBusy(true)
    setError('')
    try {
      const result = await window.audit.reviews(
        save ? 'save' : 'get',
        save
          ? {
              projectId,
              runId,
              pathId,
              expectedRevision: record.revision,
              baselineVersion: record.current.version,
              status,
              note
            }
          : { projectId, runId, pathId }
      )
      if (!alive.current) return
      if (!result.ok) throw new Error(result.error.code + '：' + result.error.message)
      const data = result.data as HumanReview
      setRecord(data)
      if (save) {
        setNote(data.note)
        setStatus(data.status)
      }
      setMessage(
        save
          ? '人工复核已保存，版本 ' + data.revision
          : '已刷新机器基线与复核版本；保留当前草稿，请核对后保存'
      )
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : '复核保存未确认')
    } finally {
      locked.current = false
      if (alive.current) setBusy(false)
    }
  }
  return (
    <section className="human-review" aria-label="独立人工复核" data-testid="human-review">
      <div className="review-heading">
        <div>
          <h3>人工复核</h3>
          <p className="muted">独立记录判断与审计备注，保留机器结论和原始证据。</p>
        </div>
        {record && (
          <span className="review-state">
            {reviewLabels[record.status]} · v{record.revision}
          </span>
        )}
      </div>
      {record?.stale && <p role="status">已保存记录对应较早的机器结果，需要重新复核。</p>}
      {machineMoved && <p role="status">机器结果已更新，请刷新复核基线后重新核对。</p>}
      <fieldset disabled={busy || !record}>
        <label>
          复核状态
          <select
            aria-label="人工复核状态"
            value={status}
            onChange={(event) => setStatus(event.target.value as ReviewStatus)}
          >
            {reviewStates.map((value) => (
              <option value={value} key={value}>
                {reviewLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          审计备注
          <textarea
            aria-label="人工复核备注"
            value={note}
            maxLength={6000}
            rows={4}
            placeholder="记录确认依据、误报原因或需要补充的证据"
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <div className="review-actions">
          <button
            type="button"
            className="button-primary"
            data-testid="save-human-review"
            disabled={!!machineMoved}
            onClick={() => void act(true)}
          >
            {busy ? '正在处理…' : '保存人工复核'}
          </button>
          <button type="button" onClick={() => void act(false)}>
            刷新复核基线
          </button>
        </div>
      </fieldset>
      <p role="status" data-testid="human-review-message">
        {message}
      </p>
      {error && <p role="alert">{publicAnalysisText(error)}</p>}
      <p className="muted">
        切换路径会丢弃未保存草稿。请勿填写密钥；常见凭据会被隐藏。人工确认或误报不改变机器风险统计。
      </p>
    </section>
  )
}
