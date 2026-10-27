import { useId } from 'react'
import type { ReactNode } from 'react'
import type { PathDetail } from '../../../shared/scan-contracts'
import { propagationChecks } from '../../../shared/taint-contracts'
import {
  asRecord,
  detailTabs,
  pathOutcome,
  publicAnalysisText,
  publicAnalysisValue,
  savedEvidence
} from '../../../shared/path-detail-view'
import type { DetailTab } from '../../../shared/path-detail-view'

const checkNames = {
  source: '来源',
  argumentMapping: '实参与形参映射',
  assignment: '赋值传播',
  returnValue: '返回值传播',
  field: '字段传播',
  defense: '有效防护'
}
const checkStates: Record<string, string> = {
  supported: '有证据支持',
  blocked: '有阻断证据',
  unknown: '未知，需补证',
  not_applicable: '不适用'
}
const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? publicAnalysisText(value) : fallback

function Check({ label, value }: { label: string; value: unknown }): React.JSX.Element {
  const check = asRecord(value)
  return (
    <div className="detail-check">
      <strong>
        {label} · {checkStates[String(check.status)] ?? '未记录'}
      </strong>
      <p>{text(check.reason, '没有已保存的判断依据。')}</p>
      {Array.isArray(check.quotes) &&
        check.quotes
          .filter((q) => typeof q === 'string')
          .map((quote, i) => <pre key={i}>{publicAnalysisText(quote as string)}</pre>)}
    </div>
  )
}

function TaintValues({ title, values }: { title: string; values: unknown[] }): React.JSX.Element {
  return (
    <div>
      <h4>{title}</h4>
      {!values.length ? (
        <p>没有已保存的{title}记录；不能据此判断安全。</p>
      ) : (
        <ul>
          {values.map((value, i) => {
            const item = asRecord(value)
            return (
              <li key={i}>
                <strong>{text(item.name, '变量名未记录')}</strong> ·{' '}
                {text(item.origin, '来源未记录')}
                {Number.isInteger(item.fromStep) && Number(item.fromStep) >= 0 && (
                  <span> · 来自第 {Number(item.fromStep) + 1} 步</span>
                )}
                {Array.isArray(item.quotes) &&
                  item.quotes.map((q, j) => <pre key={j}>{text(q, '引用未记录')}</pre>)}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function CallChainDetail({
  detail,
  tab,
  onTabChange,
  children
}: {
  detail: PathDetail
  tab: DetailTab
  onTabChange: (tab: DetailTab) => void
  children: ReactNode
}): React.JSX.Element {
  const id = useId()
  const steps = [...detail.steps].sort((a, b) => a.stepIndex - b.stepIndex)
  const hasOldEvidence =
    ['failed', 'analyzing'].includes(detail.status) &&
    steps.some((s) => s.evidence.length || Object.keys(s.propagation).length)
  return (
    <>
      <p className="audit-id" data-testid="detail-path-id">
        {detail.pathId}
      </p>
      <p
        className={'detail-outcome ' + (detail.status === 'completed' ? detail.verdict : 'unknown')}
        data-testid="detail-outcome"
      >
        {pathOutcome(detail)}
      </p>
      <p className="audit-id">
        projectId={detail.projectId}
        <br />
        runId={detail.runId}
        <br />
        chainId={detail.pathId}
      </p>
      <p className="muted">
        来源：{publicAnalysisText(detail.sourceRef ?? '尚未确认')}
        {detail.truncated ? ' · 部分覆盖：' + detail.truncationReason : ''}
      </p>
      {detail.summary && <pre className="audit-summary">{publicAnalysisText(detail.summary)}</pre>}
      {hasOldEvidence && (
        <p role="status">
          当前分析未成功完成。以下步骤证据为此前已保存快照，不能作为本次尝试已完成的依据。
        </p>
      )}
      <div role="tablist" aria-label="调用链详情标签" className="detail-tabs">
        {detailTabs.map((item, index) => (
          <button
            key={item.id}
            role="tab"
            id={`${id}-tab-${item.id}`}
            aria-controls={`${id}-panel-${item.id}`}
            aria-selected={tab === item.id}
            tabIndex={tab === item.id ? 0 : -1}
            data-testid={`detail-tab-${item.id}`}
            onClick={() => onTabChange(item.id)}
            onKeyDown={(event) => {
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % detailTabs.length
                  : event.key === 'ArrowLeft'
                    ? (index + detailTabs.length - 1) % detailTabs.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? detailTabs.length - 1
                        : -1
              if (next < 0) return
              event.preventDefault()
              onTabChange(detailTabs[next].id)
              document.getElementById(`${id}-tab-${detailTabs[next].id}`)?.focus()
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {detailTabs.map((item) => (
        <section
          key={item.id}
          role="tabpanel"
          className="detail-panel"
          id={`${id}-panel-${item.id}`}
          aria-labelledby={`${id}-tab-${item.id}`}
          hidden={tab !== item.id}
          data-testid={`detail-panel-${item.id}`}
        >
          {item.id === 'path' && (
            <>
              <h3>调用路径</h3>
              <p className="muted">
                按真实步骤编号展示候选调用；函数、文件与行号来自已保存的调用链。
                进入“分析过程”可查看调试记录或明确发起分析。
              </p>
              <ol className="audit-steps">
                {steps.map((s) => (
                  <li key={s.stepIndex}>
                    <strong>
                      第 {s.stepIndex + 1} 步 · {publicAnalysisText(s.edge.functionName)}
                    </strong>
                    <span> → {publicAnalysisText(s.edge.calledFunctionName)}</span>
                    <p>
                      {publicAnalysisText(s.edge.filePath)}:{s.edge.callLine}:{s.edge.callColumn} ·{' '}
                      {s.edge.resolutionStatus} · {s.edge.isSink ? '候选 Sink' : '候选调用'}
                    </p>
                    {s.edge.calledFilePath && (
                      <p>被调用函数文件：{publicAnalysisText(s.edge.calledFilePath)}</p>
                    )}
                    {!!s.edge.arguments.length && (
                      <pre>
                        {s.edge.arguments
                          .map((a) => publicAnalysisText(`参数 ${a.index}: ${a.text}`))
                          .join('\n')}
                      </pre>
                    )}
                  </li>
                ))}
              </ol>
              {!steps.length && <p>没有已保存的路径步骤。</p>}
            </>
          )}
          {item.id === 'evidence' && (
            <>
              <h3>传播证据</h3>
              <p className="muted">
                只展示 SQLite
                中保存的原文引用和取证范围；范围首行不一定是引用首行。不会用当前磁盘内容替换历史证据。
              </p>
              {steps.map((s) => {
                const evidence = savedEvidence(s.evidence)
                return (
                  <article className="detail-step" key={s.stepIndex}>
                    <h4>
                      第 {s.stepIndex + 1} 步 · {publicAnalysisText(s.edge.functionName)}
                    </h4>
                    <p>
                      {publicAnalysisText(s.edge.filePath)}:{s.edge.callLine} →{' '}
                      {publicAnalysisText(s.edge.calledFunctionName)}
                    </p>
                    <TaintValues title="污染输入" values={s.taintIn} />
                    <TaintValues title="污染输出" values={s.taintOut} />
                    <h4>已保存源码证据</h4>
                    {!evidence.length && (
                      <p>没有可展示的已保存源码引用；未分析或失败不代表安全。</p>
                    )}
                    {evidence.length !== s.evidence.length && (
                      <p>部分证据缺少有效文件、行号或原文，未将其补造成有效证据。</p>
                    )}
                    {evidence.map((e, i) => (
                      <figure className="detail-evidence" key={i}>
                        <figcaption>
                          取证范围 {publicAnalysisText(e.filePath)}:{e.startLine}–{e.endLine}
                        </figcaption>
                        <pre>{publicAnalysisText(e.quote)}</pre>
                      </figure>
                    ))}
                    <h4>六项传播核查</h4>
                    {propagationChecks.map((name) => (
                      <Check key={name} label={checkNames[name]} value={s.propagation[name]} />
                    ))}
                    <details>
                      <summary>已保存步骤数据（脱敏）</summary>
                      <pre>
                        {JSON.stringify(
                          publicAnalysisValue({
                            taintIn: s.taintIn,
                            taintOut: s.taintOut,
                            checks: s.propagation,
                            evidence: s.evidence
                          }),
                          null,
                          2
                        )}
                      </pre>
                    </details>
                  </article>
                )
              })}
            </>
          )}
          {item.id === 'defense' && (
            <>
              <h3>防护分析</h3>
              <p className="muted">
                缺少防护记录不等于没有防护；局部步骤的阻断证据也不等于整个项目安全。
              </p>
              {steps.map((s) => (
                <article className="detail-step" key={s.stepIndex}>
                  <h4>
                    第 {s.stepIndex + 1} 步 · {publicAnalysisText(s.edge.functionName)}
                  </h4>
                  <p>
                    {publicAnalysisText(s.edge.filePath)}:{s.edge.callLine}
                  </p>
                  <Check label="有效防护" value={s.propagation.defense} />
                  <p>
                    已保存防护说明：
                    {publicAnalysisText(s.defenseSummary) || '尚无防护说明，不能判断已阻断。'}
                  </p>
                  <p>
                    步骤判断：
                    {s.dangerous === 0
                      ? '有局部阻断记录'
                      : s.dangerous === 1
                        ? '有局部风险记录'
                        : '未知，需补证'}
                  </p>
                </article>
              ))}
            </>
          )}
          {/* Keep the stream mounted while changing tabs, so switching views never starts another analysis. */}
          {item.id === 'process' && children}
        </section>
      ))}
    </>
  )
}
