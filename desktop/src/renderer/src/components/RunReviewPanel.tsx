import { useEffect, useState } from 'react'
import type { RunReviewConfig } from '../../../shared/template-contracts'
import { reviewFields } from '../../../shared/template-contracts'
import { publicAnalysisText } from '../../../shared/path-detail-view'
export function RunReviewPanel({
  projectId,
  runId
}: {
  projectId: string
  runId: string
}): React.JSX.Element {
  const [config, setConfig] = useState<RunReviewConfig | null>(null),
    [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void window.audit
      .templates('run', { projectId, runId })
      .then((result) => {
        if (!active) return
        if (!result.ok) throw new Error(result.error.code + '：' + result.error.message)
        setConfig(result.data as RunReviewConfig)
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : '任务审查材料读取失败')
      })
    return () => {
      active = false
    }
  }, [projectId, runId])
  return (
    <section className="input-help" aria-label="任务固定审查材料" data-testid="run-review-config">
      <h3>本任务固定审查材料</h3>
      {error && <p role="alert">{error}</p>}
      {config && (
        <>
          <p>摘要：{config.contextHash}</p>
          {config.state === 'legacy-missing' ? (
            <p>历史任务未保存审查材料；不自动套用当前模板或项目要求。</p>
          ) : (
            <>
              <ul>
                {config.templates.map((t) => (
                  <li key={t.templateId}>
                    {t.name} · v{t.revision} ·{' '}
                    {t.origin === 'builtin' ? '内置参考' : '自定义/未验证'}
                  </li>
                ))}
              </ul>
              {!config.templates.length && <p>未选额外知识模板；保留内置规则。</p>}
              <p>项目要求版本：{config.projectReview.revision}；修改当前配置不会改变此任务。</p>
              <details>
                <summary>查看已保存的文档与要求</summary>
                {config.templates.map((t) => (
                  <article key={t.templateId}>
                    <h4>{t.name}</h4>
                    <pre>{publicAnalysisText(t.markdown)}</pre>
                  </article>
                ))}
                <pre>
                  {publicAnalysisText(
                    JSON.stringify(
                      Object.fromEntries(reviewFields.map((k) => [k, config.projectReview[k]])),
                      null,
                      2
                    )
                  )}
                </pre>
              </details>
            </>
          )}
          <p className="muted">补充提示词不表示已增加全部漏洞发现能力；结论仍需源码证据支持。</p>
        </>
      )}
    </section>
  )
}
