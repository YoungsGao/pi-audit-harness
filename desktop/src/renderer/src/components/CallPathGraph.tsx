import { useEffect, useId, useState } from 'react'
import type { PathDetail, PathSummary } from '../../../shared/scan-contracts'
import type { PathSource } from '../../../shared/review-contracts'
import { pathGraphNodes, relatedPaths, relationLabel } from '../../../shared/call-path-view'
import { asRecord, publicAnalysisText } from '../../../shared/path-detail-view'

export function CallPathGraph({
  detail,
  paths,
  onSelectPath,
  onEvidence
}: {
  detail: PathDetail
  paths: PathSummary[]
  onSelectPath: (pathId: string) => void
  onEvidence: () => void
}): React.JSX.Element {
  const id = useId(),
    steps = [...detail.steps].sort((a, b) => a.stepIndex - b.stepIndex),
    nodes = pathGraphNodes(detail)
  const [selection, setSelection] = useState({
    stepIndex: steps[0]?.stepIndex ?? 0,
    target: 'caller' as 'caller' | 'callee',
    view: 'source' as 'source' | 'mapping' | 'defense',
    key: nodes[0]?.id ?? ''
  })
  const [read, setRead] = useState<{ key: string; source: PathSource | null; error: string }>({
    key: '',
    source: null,
    error: ''
  })
  const step = steps.find((item) => item.stepIndex === selection.stepIndex)
  const { projectId, runId, pathId } = detail
  const requestKey = JSON.stringify([
    projectId,
    runId,
    pathId,
    selection.stepIndex,
    selection.target
  ])
  const source = read.key === requestKey ? read.source : null,
    error = read.key === requestKey ? read.error : '',
    loading = read.key !== requestKey
  useEffect(() => {
    let alive = true
    void window.audit
      .reviews('source', {
        projectId,
        runId,
        pathId,
        stepIndex: selection.stepIndex,
        target: selection.target
      })
      .then((result) => {
        if (!alive) return
        if (!result.ok) throw new Error(result.error.code + '：' + result.error.message)
        setRead({ key: requestKey, source: result.data as PathSource, error: '' })
      })
      .catch((e: unknown) => {
        if (alive)
          setRead({
            key: requestKey,
            source: null,
            error: e instanceof Error ? e.message : '快照源码暂不可读'
          })
      })
    return () => {
      alive = false
    }
  }, [projectId, runId, pathId, selection.stepIndex, selection.target, requestKey])
  const alternatives = relatedPaths(detail, paths)
  return (
    <div className="call-path-view" data-testid="interactive-path">
      <p className="muted">
        点选函数查看固定快照源码，点选关系核对参数。实线表示已定位的静态关系，虚线表示仍待确认；关系定位不等于漏洞成立。
      </p>
      <div className="path-graph-layout">
        <div
          className="path-graph"
          role="group"
          aria-label="可交互调用路径图"
          onKeyDown={(event) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
            if (index < 0) return
            event.preventDefault()
            buttons[
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
            ]?.focus()
          }}
        >
          <ol className="graph-sequence">
            {nodes.map((node, index) => (
              <li key={node.id}>
                <button
                  type="button"
                  className="graph-node"
                  data-kind={node.kind}
                  data-testid="path-node"
                  aria-pressed={selection.key === node.id}
                  aria-controls={id}
                  onClick={() =>
                    setSelection({
                      stepIndex: node.stepIndex,
                      target: node.target,
                      view: 'source',
                      key: node.id
                    })
                  }
                >
                  <span className="graph-node-kind">
                    {node.kind === 'source'
                      ? 'Source · 入口候选'
                      : node.kind === 'sink'
                        ? 'Sink · 危险调用'
                        : node.kind === 'boundary'
                          ? '来源边界 · 待核查'
                          : '函数'}
                  </span>
                  <strong>{publicAnalysisText(node.label)}</strong>
                  <small>
                    {node.kind === 'sink'
                      ? '查看危险调用发生处'
                      : '第 ' + (node.stepIndex + 1) + ' 步调用方'}
                  </small>
                </button>
                {node.defense && (
                  <button
                    type="button"
                    className="graph-defense"
                    data-testid="path-defense"
                    aria-controls={id}
                    onClick={() =>
                      setSelection({
                        stepIndex: node.stepIndex,
                        target: 'caller',
                        view: 'defense',
                        key: 'defense-' + node.id
                      })
                    }
                  >
                    已保存局部阻断证据
                  </button>
                )}
                {index < steps.length && (
                  <button
                    type="button"
                    className="graph-relation"
                    data-resolution={steps[index].edge.resolutionStatus}
                    data-testid="path-relation"
                    aria-pressed={selection.key === 'edge-' + index}
                    aria-controls={id}
                    onClick={() =>
                      setSelection({
                        stepIndex: steps[index].stepIndex,
                        target: 'caller',
                        view: 'mapping',
                        key: 'edge-' + index
                      })
                    }
                  >
                    <span>{relationLabel(steps[index].edge.resolutionStatus)}</span>
                    <small>第 {steps[index].stepIndex + 1} 步 · 参数与映射</small>
                  </button>
                )}
              </li>
            ))}
          </ol>
          {!nodes.length && <p>此路径没有已保存步骤。</p>}
        </div>
        <section
          id={id}
          className="path-inspector"
          aria-label="路径源码与参数检查"
          data-testid="path-inspector"
        >
          <div className="path-inspector-heading">
            <h4>
              第 {selection.stepIndex + 1} 步 ·{' '}
              {selection.view === 'mapping'
                ? '参数映射'
                : selection.view === 'defense'
                  ? '防护证据'
                  : '快照源码'}
            </h4>
          </div>
          <div className="path-source-tabs" role="group" aria-label="选择源码位置">
            <button
              type="button"
              aria-pressed={selection.target === 'caller'}
              onClick={() => setSelection({ ...selection, target: 'caller' })}
            >
              调用方源码
            </button>
            <button
              type="button"
              disabled={!step?.edge.calledFilePath}
              aria-pressed={selection.target === 'callee'}
              onClick={() => setSelection({ ...selection, target: 'callee' })}
            >
              被调用方源码
            </button>
          </div>
          {!step?.edge.calledFilePath && (
            <p className="muted">被调用目标尚未定位到快照内函数；当前显示调用发生处。</p>
          )}
          {loading && <p role="status">正在读取任务固定快照…</p>}
          {error && <p role="alert">{publicAnalysisText(error)}</p>}
          {source && (
            <>
              <p className="source-location">
                {publicAnalysisText(source.filePath)}:{source.startLine}–{source.endLine}
              </p>
              <pre className="numbered-source" data-testid="graph-source">
                {source.text.split('\n').map((line, index) => (
                  <span
                    className="source-line"
                    data-call-line={
                      source.startLine + index === step?.edge.callLine &&
                      source.filePath === step.edge.filePath
                    }
                    key={index}
                  >
                    <span aria-hidden="true" className="source-line-number">
                      {source.startLine + index}
                    </span>
                    <code>{line || ' '}</code>
                  </span>
                ))}
              </pre>
              {!source.complete && (
                <p className="muted">当前是有界片段，不能当成完整函数或完整传播证明。</p>
              )}
              <details>
                <summary>源码版本</summary>
                <p className="audit-id">
                  快照 {source.snapshotId}
                  <br />
                  {source.sourceStamp}
                </p>
              </details>
            </>
          )}
          {step && (
            <div className="path-argument-map">
              <h4>危险参数候选与已保存映射</h4>
              {step.edge.arguments.length ? (
                <ul>
                  {step.edge.arguments.map((arg) => (
                    <li key={arg.index}>
                      参数 {arg.index + 1}
                      <pre>{publicAnalysisText(arg.text)}</pre>
                      <small>
                        {arg.filePath}:{arg.startLine}–{arg.endLine}
                      </small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>此关系没有保存危险参数候选。</p>
              )}
              <p>
                {publicAnalysisText(
                  String(
                    asRecord(step.propagation.argumentMapping).reason ??
                      '尚无实参与形参映射证据；函数连线不代表污染已传播。'
                  )
                )}
              </p>
              <details open={selection.view === 'mapping'}>
                <summary>已保存的实参与形参核查</summary>
                {(['taintIn', 'taintOut'] as const).map((kind) => (
                  <div key={kind}>
                    <strong>{kind === 'taintIn' ? '污染输入' : '污染输出'}</strong>
                    {step[kind].length ? (
                      <ul>
                        {step[kind].map((value, index) => {
                          const row = asRecord(value)
                          return (
                            <li key={index}>
                              {publicAnalysisText(String(row.name ?? '变量未记录'))}：
                              {publicAnalysisText(String(row.origin ?? '来源未记录'))}
                            </li>
                          )
                        })}
                      </ul>
                    ) : (
                      <p>没有已保存的变量映射记录。</p>
                    )}
                  </div>
                ))}
                {Array.isArray(asRecord(step.propagation.argumentMapping).quotes) &&
                  (asRecord(step.propagation.argumentMapping).quotes as unknown[])
                    .filter((quote): quote is string => typeof quote === 'string')
                    .map((quote, index) => <pre key={index}>{publicAnalysisText(quote)}</pre>)}
              </details>
              {selection.view === 'defense' && (
                <>
                  <h4>已保存防护记录</h4>
                  <p>
                    {publicAnalysisText(
                      String(
                        asRecord(step.propagation.defense).reason ??
                          step.defenseSummary ??
                          '没有已保存防护结论'
                      )
                    )}
                  </p>
                </>
              )}
              <button type="button" onClick={onEvidence}>
                查看已保存传播证据
              </button>
            </div>
          )}
        </section>
      </div>
      {alternatives.length > 0 && (
        <div className="path-alternatives">
          <h4>同一风险点的其他路径</h4>
          <p className="muted">仅显示当前已加载列表中的分支；切换后查看该路径自己的步骤与证据。</p>
          {alternatives.map((path) => (
            <button
              type="button"
              data-testid="path-branch"
              key={path.pathId}
              onClick={() => onSelectPath(path.pathId)}
            >
              {path.pathId.slice(-8)} · {publicAnalysisText(path.sourceRef ?? '来源待核查')}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
