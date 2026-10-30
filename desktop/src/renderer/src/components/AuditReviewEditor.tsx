import { useCallback, useEffect, useRef, useState } from 'react'
import {
  emptyProjectReview,
  reviewFields,
  utf8Bytes,
  REVIEW_CONTEXT_BYTES
} from '../../../shared/template-contracts'
import type {
  TemplateRecord,
  TemplateCatalog,
  TemplateReference,
  ProjectReview
} from '../../../shared/template-contracts'
export interface ReviewSelection {
  templateRefs: TemplateReference[]
  projectReviewRevision: number
}
const labels = {
  businessWrappers: '业务封装',
  inputSources: '输入来源',
  defenseConventions: '防护约定',
  focus: '重点审查要求'
}
export function AuditReviewEditor({
  projectId,
  disabled,
  onChange
}: {
  projectId: string
  disabled: boolean
  onChange: (value: ReviewSelection | null) => void
}): React.JSX.Element {
  const [templates, setTemplates] = useState<TemplateRecord[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [draft, setDraft] = useState<ProjectReview>(emptyProjectReview(projectId)),
    [baseline, setBaseline] = useState<ProjectReview>(emptyProjectReview(projectId)),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [revision, reload] = useState(0)
  const mounted = useRef(false),
    saveLock = useRef(false),
    selectedRef = useRef<string[]>([])
  const dirty = reviewFields.some((key) => draft[key] !== baseline[key])
  const publish = useCallback(
    (ids: string[], review: ProjectReview, list: TemplateRecord[]): void => {
      if (
        ids.length > 4 ||
        utf8Bytes(
          JSON.stringify({
            templates: list.filter((t) => ids.includes(t.templateId)),
            projectReview: review
          })
        ) > REVIEW_CONTEXT_BYTES
      ) {
        setError('最多选择 4 个模板；全部审查材料最多 12KiB。')
        onChange(null)
        return
      }
      onChange({
        templateRefs: list
          .filter((t) => ids.includes(t.templateId))
          .map((t) => ({ templateId: t.templateId, revision: t.revision })),
        projectReviewRevision: review.revision
      })
    },
    [onChange]
  )
  useEffect(() => {
    mounted.current = true
    let active = true
    void Promise.all([
      window.audit.templates('list', {}),
      window.audit.templates('project', { projectId })
    ])
      .then(([catalog, review]) => {
        if (!active) return
        if (!catalog.ok) throw new Error(catalog.error.code + '：' + catalog.error.message)
        if (!review.ok) throw new Error(review.error.code + '：' + review.error.message)
        const list = (catalog.data as TemplateCatalog).templates,
          current = review.data as ProjectReview
        setTemplates(list)
        setDraft(current)
        setBaseline(current)
        setError('')
        // 刷新是用户明确读取新版本的动作；初次没有选择额外知识模板。
        const next = selectedRef.current.filter((id) => list.some((t) => t.templateId === id))
        selectedRef.current = next
        setSelected(next)
        publish(next, current, list)
      })
      .catch((e: unknown) => {
        if (active) {
          setError(e instanceof Error ? e.message : '审查配置读取失败')
          onChange(null)
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      mounted.current = false
    }
  }, [projectId, revision, onChange, publish])
  async function save(): Promise<void> {
    if (saveLock.current) return
    saveLock.current = true
    setSaving(true)
    setError('')
    try {
      const {
        projectId: id,
        revision: rev,
        businessWrappers,
        inputSources,
        defenseConventions,
        focus
      } = draft
      const result = await window.audit.templates('saveProject', {
        projectId: id,
        expectedRevision: rev,
        businessWrappers,
        inputSources,
        defenseConventions,
        focus
      })
      if (!mounted.current) return
      if (!result.ok)
        throw new Error(`${result.error.code}：${result.error.message}（请求 ${result.requestId}）`)
      const current = result.data as ProjectReview
      setDraft(current)
      setBaseline(current)
      publish(selected, current, templates)
      setMessage('项目补充要求已保存；仅影响之后创建的任务。')
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof Error ? e.message : '补充要求保存失败')
        onChange(null)
      }
    } finally {
      saveLock.current = false
      if (mounted.current) setSaving(false)
    }
  }
  const contextBytes = utf8Bytes(
    JSON.stringify({
      templates: templates.filter((t) => selected.includes(t.templateId)),
      projectReview: draft
    })
  )
  return (
    <section className="input-help" aria-label="新任务审计配置" data-testid="review-config-editor">
      <h3>新任务审计配置</h3>
      <p>
        内置 Java 候选规则始终启用。额外模板只提供审计知识，不自动扩展危险 API
        检测器；自定义内容未经验证。
      </p>
      {loading && <p role="status">正在读取模板与项目补充要求…</p>}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <fieldset disabled={disabled || loading || saving}>
        <legend>选择审计知识模板（最多 4 个）</legend>
        <div className="template-choices">
          {templates.map((item) => (
            <label key={item.templateId}>
              <input
                type="checkbox"
                aria-label={`选择模板 ${item.name}`}
                checked={selected.includes(item.templateId)}
                onChange={(e) => {
                  const ids = e.target.checked
                    ? [...selected, item.templateId]
                    : selected.filter((id) => id !== item.templateId)
                  selectedRef.current = ids
                  setSelected(ids)
                  setError('')
                  const bytes = utf8Bytes(
                    JSON.stringify({
                      templates: templates.filter((t) => ids.includes(t.templateId)),
                      projectReview: draft
                    })
                  )
                  if (ids.length > 4 || bytes > REVIEW_CONTEXT_BYTES) {
                    setError('最多选择 4 个模板；全部审查材料最多 12KiB。')
                    onChange(null)
                  } else if (!dirty) publish(ids, baseline, templates)
                }}
              />
              <span>
                {item.name} · v{item.revision} ·{' '}
                {item.origin === 'builtin' ? '内置参考' : '自定义/未验证'}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <details>
        <summary>项目级补充审查要求（保存后用于新任务）</summary>
        <fieldset disabled={disabled || loading || saving}>
          <legend>业务上下文</legend>
          {reviewFields.map((key) => (
            <label key={key}>
              {labels[key]}
              <textarea
                aria-label={labels[key]}
                rows={3}
                maxLength={2000}
                value={draft[key]}
                onChange={(e) => {
                  setDraft({ ...draft, [key]: e.target.value })
                  onChange(null)
                }}
              />
            </label>
          ))}
          <button
            type="button"
            className="button-primary"
            data-testid="save-project-review"
            onClick={() => void save()}
            disabled={!dirty}
          >
            保存项目补充要求
          </button>
          <button
            type="button"
            disabled={!dirty}
            onClick={() => {
              setDraft(baseline)
              publish(selected, baseline, templates)
              setError('')
            }}
          >
            放弃未保存要求
          </button>
        </fieldset>
      </details>
      <p>
        审查材料约 {contextBytes} / {REVIEW_CONTEXT_BYTES} 字节；项目要求版本 {baseline.revision}。
        {dirty
          ? '有未保存要求，请先保存或放弃后创建任务。'
          : '创建任务会固定当前模板版本和已保存要求。'}
      </p>
      <button
        type="button"
        disabled={disabled || loading || saving || dirty}
        onClick={() => {
          setLoading(true)
          onChange(null)
          reload((n) => n + 1)
        }}
      >
        刷新模板与项目配置
      </button>
    </section>
  )
}
