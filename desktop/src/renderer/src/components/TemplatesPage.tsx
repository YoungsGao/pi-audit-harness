import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  templateCategories,
  TEMPLATE_BODY_BYTES,
  utf8Bytes
} from '../../../shared/template-contracts'
import type {
  TemplateCatalog,
  TemplateDraft,
  TemplateInput,
  TemplateRecord
} from '../../../shared/template-contracts'
import { MarkdownPreview } from './MarkdownPreview'
const empty: TemplateInput = {
  name: '',
  language: 'java',
  category: 'custom',
  description: '',
  markdown: '',
  origin: 'manual',
  sourceName: null
}
const categories = {
  'sql-injection': 'SQL 注入',
  'command-injection': '命令注入',
  'path-traversal': '路径遍历',
  custom: '自定义审查'
}
export function TemplatesPage(): React.JSX.Element {
  const [catalog, setCatalog] = useState<TemplateCatalog>({ templates: [], total: 0 }),
    [draft, setDraft] = useState<TemplateInput>({ ...empty }),
    [baseline, setBaseline] = useState(JSON.stringify(empty)),
    [pending, setPending] = useState<TemplateInput | null>(null),
    [busy, setBusy] = useState(true),
    [message, setMessage] = useState('正在读取模板…'),
    [error, setError] = useState(''),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [notices, setNotices] = useState<string[]>([])
  const mounted = useRef(false),
    locked = useRef(false)
  const dirty = JSON.stringify(draft) !== baseline,
    readOnly = draft.origin === 'builtin'
  useEffect(() => {
    mounted.current = true
    void window.audit
      .templates('list', {})
      .then((result) => {
        if (!mounted.current) return
        if (!result.ok) throw new Error(result.error.code + '：' + result.error.message)
        setCatalog(result.data as TemplateCatalog)
        setMessage('模板已读取；自定义文档仅作为未经验证的审计参考。')
      })
      .catch((e: unknown) => {
        if (mounted.current) setError(e instanceof Error ? e.message : '模板读取失败')
      })
      .finally(() => {
        if (mounted.current) setBusy(false)
      })
    return () => {
      mounted.current = false
    }
  }, [])
  function activate(next: TemplateInput): void {
    setDraft(next)
    setBaseline(JSON.stringify(next))
    setPending(null)
    setErrors({})
    setNotices([])
  }
  function request(next: TemplateInput): void {
    if (dirty) setPending(next)
    else activate(next)
  }
  function editor(record: TemplateRecord): TemplateInput {
    const {
      templateId,
      revision,
      name,
      language,
      category,
      description,
      markdown,
      origin,
      sourceName
    } = record
    return {
      templateId,
      expectedRevision: revision,
      name,
      language,
      category,
      description,
      markdown,
      origin,
      sourceName
    }
  }
  async function work(task: () => Promise<void>): Promise<void> {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError('')
    try {
      await task()
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : '模板操作失败')
    } finally {
      locked.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    const checked: Record<string, string> = {}
    if (!draft.name.trim()) checked.name = '请填写模板名称'
    if (!draft.description.trim()) checked.description = '请填写模板简介'
    if (!draft.markdown.trim()) checked.markdown = '请填写 Markdown 审计说明'
    if (utf8Bytes(draft.markdown) > TEMPLATE_BODY_BYTES)
      checked.markdown = '正文最多 16KiB，请缩减内容'
    if (draft.language !== 'java') checked.language = '当前审计引擎支持 Java，请核对导入语言'
    setErrors(checked)
    if (Object.keys(checked).length) return
    await work(async () => {
      const result = await window.audit.templates('save', draft)
      if (!mounted.current) return
      if (!result.ok)
        throw new Error(`${result.error.code}：${result.error.message}（请求 ${result.requestId}）`)
      const saved = result.data as TemplateRecord
      activate(editor(saved))
      setMessage(`模板已保存：${saved.name} · 版本 ${saved.revision}；在创建审计任务时选择后生效。`)
      const list = await window.audit.templates('list', {})
      if (mounted.current && list.ok) setCatalog(list.data as TemplateCatalog)
    })
  }
  async function importDocument(kind: 'file' | 'directory'): Promise<void> {
    await work(async () => {
      const result = await window.audit.importTemplateDocument(kind)
      if (!mounted.current) return
      if (!result) {
        setMessage('已取消文档选择，当前草稿保留。')
        return
      }
      if (!result.ok)
        throw new Error(`${result.error.code}：${result.error.message}（请求 ${result.requestId}）`)
      request(result.data.draft as TemplateDraft)
      setNotices(result.data.notices)
      setMessage('已读取文档预览，核对并编辑后点击保存；尚未创建模板。')
    })
  }
  return (
    <div className="templates-page">
      <section className="card">
        <h2>审计知识模板</h2>
        <p>
          模板提供审查参考；自定义内容未经验证，不代表新增完整漏洞发现能力。内置 Java
          候选规则始终保留。
        </p>
        <div className="template-toolbar">
          <button
            type="button"
            className="button-primary"
            disabled={busy}
            onClick={() => request({ ...empty })}
          >
            新建模板
          </button>
          <button type="button" disabled={busy} onClick={() => void importDocument('file')}>
            导入 Markdown / SKILL.md
          </button>
          <button type="button" disabled={busy} onClick={() => void importDocument('directory')}>
            导入 Skill 目录
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void work(async () => {
                const result = await window.audit.templates('list', {})
                if (!result.ok) throw new Error(result.error.code + '：' + result.error.message)
                if (mounted.current) setCatalog(result.data as TemplateCatalog)
              })
            }
          >
            刷新模板列表
          </button>
        </div>
        <p role="status" data-testid="template-status">
          {message}
        </p>
        {error && <p role="alert">{error}</p>}
        {notices.length > 0 && (
          <ul>
            {notices.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        {pending && (
          <div role="alert">
            <p>当前有未保存草稿，是否放弃后切换？</p>
            <button type="button" onClick={() => activate(pending)}>
              放弃草稿并切换
            </button>
            <button type="button" onClick={() => setPending(null)}>
              继续编辑当前草稿
            </button>
          </div>
        )}
      </section>
      <div className="template-editor-layout">
        <section className="card">
          <h2>{draft.templateId ? '查看 / 编辑模板' : '新建知识模板'}</h2>
          <p>
            {readOnly ? '内置参考文档，只读。' : '自定义模板 · 未验证'}
            {draft.expectedRevision ? ` · 当前版本 ${draft.expectedRevision}` : ''}
          </p>
          {draft.sourceName && <p>导入来源：{draft.sourceName}（仅文档）</p>}
          {readOnly && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                request({
                  ...draft,
                  templateId: undefined,
                  expectedRevision: undefined,
                  origin: 'manual',
                  sourceName: null
                })
              }
            >
              基于此文档新建
            </button>
          )}
          <form noValidate onSubmit={(event) => void save(event)}>
            <fieldset disabled={busy || readOnly}>
              <legend>模板信息与 Markdown 审计说明</legend>
              <label>
                名称
                <input
                  aria-label="模板名称"
                  maxLength={120}
                  value={draft.name}
                  aria-invalid={!!errors.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              {errors.name && <p role="alert">{errors.name}</p>}
              <label>
                语言
                <select
                  aria-label="模板语言"
                  value={draft.language}
                  onChange={(e) => setDraft({ ...draft, language: e.target.value })}
                >
                  {draft.language !== 'java' && (
                    <option value={draft.language}>{draft.language}（导入值，需修改）</option>
                  )}
                  <option value="java">Java（当前支持）</option>
                </select>
              </label>
              {errors.language && <p role="alert">{errors.language}</p>}
              <label>
                漏洞分类
                <select
                  aria-label="模板分类"
                  value={draft.category}
                  onChange={(e) =>
                    setDraft({ ...draft, category: e.target.value as TemplateDraft['category'] })
                  }
                >
                  {templateCategories.map((c) => (
                    <option key={c} value={c}>
                      {categories[c]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                简介
                <textarea
                  aria-label="模板简介"
                  maxLength={1000}
                  rows={3}
                  value={draft.description}
                  aria-invalid={!!errors.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </label>
              {errors.description && <p role="alert">{errors.description}</p>}
              <label>
                Markdown 正文
                <textarea
                  aria-label="模板正文"
                  rows={18}
                  value={draft.markdown}
                  maxLength={16384}
                  aria-invalid={!!errors.markdown}
                  onChange={(e) => setDraft({ ...draft, markdown: e.target.value })}
                />
              </label>
              {errors.markdown && <p role="alert">{errors.markdown}</p>}
              <p className="muted">
                正文 {utf8Bytes(draft.markdown)} / 16384
                字节。写明适用范围、输入来源、传播检查、防护约定和限制；无需 JSON。
              </p>
              <button type="submit" className="button-primary" data-testid="save-template">
                {busy ? '处理中…' : '保存模板'}
              </button>
            </fieldset>
          </form>
        </section>
        <section className="card" aria-label="模板正文预览">
          <h2>正文预览</h2>
          <p className="muted">
            支持标题、段落、列表、引用和代码块；原始 HTML 与链接作为文本展示，不加载外部内容。
          </p>
          <MarkdownPreview markdown={draft.markdown} />
        </section>
      </div>
      <section className="card">
        <h2>已保存模板（{catalog.total}）</h2>
        <ul className="template-catalog">
          {catalog.templates.map((item) => (
            <li key={item.templateId}>
              <strong>{item.name}</strong>
              <span className="audit-badge">
                {item.origin === 'builtin' ? '内置参考' : '自定义 · 未验证'}
              </span>
              <p>
                {item.language} · {categories[item.category]} · 版本 {item.revision}
              </p>
              <p>{item.description}</p>
              <button
                type="button"
                disabled={busy}
                aria-label={`${item.origin === 'builtin' ? '查看' : '编辑'}模板 ${item.name}`}
                onClick={() => request(editor(item))}
              >
                {item.origin === 'builtin' ? '查看内置模板' : '编辑模板'}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
