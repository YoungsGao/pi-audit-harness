import { ModelTestPanel } from './ModelTestPanel'
import { modelTestController } from '../model-test-controller'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import type { ModelInput, ModelRecord } from '../../../shared/metadata-contracts'
import type { ModelCatalog } from '../../../shared/model-settings'
import type { ApiResult } from '../../../shared/service-protocol'
import { validateModelForm } from '../../../shared/model-form'
import type { ModelFormErrors } from '../../../shared/model-form'
const empty: ModelInput = { name: '', baseUrl: '', modelId: '' }
class ModelFormFailure extends Error {}
function value<T>(result: ApiResult<T>): T {
  if (!result.ok)
    throw new ModelFormFailure(
      `${result.error.code}：${result.error.message}（请求 ${result.requestId}）`
    )
  return result.data
}
export function ModelsPage(): React.JSX.Element {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [draft, setDraft] = useState<ModelInput>({ ...empty })
  const [baseline, setBaseline] = useState(JSON.stringify(empty))
  const [key, setKey] = useState('')
  const [editingCredential, setEditingCredential] = useState(false)
  const [chosenId, setChosenId] = useState('')
  const [busy, setBusy] = useState(true)
  const [message, setMessage] = useState('正在读取模型配置…')
  const [errors, setErrors] = useState<ModelFormErrors>({})
  const [pendingEditor, setPendingEditor] = useState<{ record: ModelRecord | null } | null>(null)
  const mounted = useRef(false),
    revision = useRef(0)
  const testState = useSyncExternalStore(
    modelTestController.subscribe,
    modelTestController.getSnapshot
  )
  const locked = busy || testState.status === 'running'
  const dirty = JSON.stringify(draft) !== baseline || key !== ''
  function applyCatalog(data: ModelCatalog): void {
    setCatalog(data)
    setChosenId(data.selection.configId ?? '')
  }
  useEffect(() => {
    mounted.current = true
    const ticket = ++revision.current
    // 只做读取；保存与选择由用户事件处理，不写在 effect 中。
    void window.audit
      .getModelCatalog()
      .then((result) => {
        if (!mounted.current || ticket !== revision.current) return
        if (result.ok) {
          setCatalog(result.data)
          setChosenId(result.data.selection.configId ?? '')
          setMessage('模型配置读取成功')
        } else
          setMessage(`${result.error.code}：${result.error.message}（请求 ${result.requestId}）`)
        setBusy(false)
      })
      .catch(() => {
        if (mounted.current && ticket === revision.current) {
          setBusy(false)
          setMessage('客户端通信失败，请重试')
        }
      })
    return () => {
      mounted.current = false
    }
  }, [])
  async function run(work: (current: () => boolean) => Promise<string>): Promise<void> {
    const ticket = ++revision.current
    const current = (): boolean => mounted.current && revision.current === ticket
    setBusy(true)
    try {
      const text = await work(current)
      if (current()) setMessage(text)
    } catch (error) {
      if (current())
        setMessage(error instanceof ModelFormFailure ? error.message : '客户端通信失败，请重试')
    } finally {
      if (current()) setBusy(false)
    }
  }
  function activateEditor(record: ModelRecord | null): void {
    const next: ModelInput = record
      ? {
          configId: record.configId,
          expectedRevision: record.revision,
          name: record.name,
          baseUrl: record.baseUrl,
          modelId: record.modelId
        }
      : { ...empty }
    setDraft(next)
    setBaseline(JSON.stringify(next))
    setKey('')
    setEditingCredential(record?.credentialState === 'referenced')
    setErrors({})
    setPendingEditor(null)
  }
  function requestEditor(record: ModelRecord | null): void {
    if (dirty) {
      setPendingEditor({ record })
      return
    }
    activateEditor(record)
  }
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    const checked = validateModelForm(draft, key)
    setErrors(checked.errors)
    if (Object.keys(checked.errors).length) {
      setMessage('请先修正表单中的字段')
      return
    }
    // 后端不回显 Key。请求发出就清空；失败需重新输入，不持久化草稿 Key。
    setKey('')
    await run(async (current) => {
      const saved = value(await window.audit.saveModelConfig(checked.input))
      if (!current()) return ''
      activateEditor(saved.model)
      try {
        const data = value(await window.audit.getModelCatalog())
        if (current()) applyCatalog(data)
      } catch {
        return '模型配置已保存：' + saved.model.configId + '；刷新失败，请点击刷新模型配置重试'
      }
      return (
        '模型配置已保存：' + saved.model.configId + (saved.cleanupPending ? '；旧凭据待清理' : '')
      )
    })
  }
  async function select(): Promise<void> {
    if (!catalog) return
    await run(async (current) => {
      const data = value(
        await window.audit.selectModel({
          configId: chosenId || null,
          expectedRevision: catalog.selection.revision
        })
      )
      if (current()) applyCatalog(data)
      return data.selection.configId
        ? '当前模型配置已选择：' + data.selection.configId
        : '已清除模型选择'
    })
  }
  const options = catalog ? [...catalog.models] : []
  if (
    catalog?.selection.model &&
    !options.some((item) => item.configId === catalog.selection.configId)
  )
    options.unshift(catalog.selection.model)
  return (
    <section className="card models-page" aria-label="手动模型配置">
      <h2>手动模型配置</h2>
      <p role="status" aria-live="polite">
        {message}
      </p>
      <p>填写服务要求的 Base URL 和模型 ID。保存、刷新和选择都不会发送模型请求。</p>
      <button
        type="button"
        disabled={locked}
        onClick={() =>
          void run(async (current) => {
            const data = value(await window.audit.getModelCatalog())
            if (current()) applyCatalog(data)
            return '模型配置读取成功'
          })
        }
      >
        刷新模型配置
      </button>
      <fieldset disabled={locked || !catalog}>
        <legend>当前选择</legend>
        <label>
          使用的配置
          <select
            aria-label="当前模型配置"
            value={chosenId}
            onChange={(event) => setChosenId(event.target.value)}
          >
            <option value="">未选择配置</option>
            {options.map((item) => (
              <option key={item.configId} value={item.configId}>
                {item.name} / {item.modelId} / {item.configId}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void select()}
          disabled={chosenId === (catalog?.selection.configId ?? '')}
        >
          应用选择
        </button>
        <p data-testid="selected-summary">
          已保存的当前选择：
          {catalog?.selection.model
            ? `${catalog.selection.model.name} / ${catalog.selection.model.modelId} / ${catalog.selection.configId}`
            : '未选择配置'}
        </p>
        <p className="muted">
          保存配置不会自动切换当前选择。当前选择与下方正在编辑的配置可以不同。
        </p>
        {catalog?.selection.model && (
          <button type="button" onClick={() => requestEditor(catalog.selection.model)}>
            编辑当前选择
          </button>
        )}
      </fieldset>
      <ModelTestPanel
        model={catalog?.selection.model ?? null}
        disabled={busy}
        pendingSelection={chosenId !== (catalog?.selection.configId ?? '')}
      />
      <fieldset disabled={locked}>
        <legend>{draft.configId ? '编辑已保存配置' : '新建模型配置'}</legend>
        <button type="button" onClick={() => requestEditor(null)}>
          新建配置
        </button>
        {pendingEditor && (
          <div role="alert">
            <p>有未保存的修改，是否放弃后切换编辑对象？</p>
            <button type="button" onClick={() => activateEditor(pendingEditor.record)}>
              放弃修改并切换
            </button>
            <button type="button" onClick={() => setPendingEditor(null)}>
              继续编辑
            </button>
          </div>
        )}
        <form noValidate onSubmit={save}>
          <p>
            正在编辑 ID：{draft.configId ?? '保存后生成'} / revision：
            {draft.expectedRevision ?? '新建'}
          </p>
          <label>
            配置名称
            <input
              aria-label="配置名称"
              value={draft.name}
              maxLength={200}
              aria-invalid={!!errors.name}
              aria-describedby="model-name-error"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          {errors.name && (
            <p id="model-name-error" role="alert">
              {errors.name}
            </p>
          )}
          <label>
            Base URL
            <input
              aria-label="Base URL"
              value={draft.baseUrl}
              maxLength={2048}
              aria-invalid={!!errors.baseUrl}
              aria-describedby="model-url-error"
              placeholder="https://服务地址/v1"
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            />
          </label>
          {errors.baseUrl && (
            <p id="model-url-error" role="alert">
              {errors.baseUrl}
            </p>
          )}
          <label>
            模型 ID
            <input
              aria-label="模型 ID"
              value={draft.modelId}
              maxLength={200}
              aria-invalid={!!errors.modelId}
              aria-describedby="model-id-error"
              onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}
            />
          </label>
          {errors.modelId && (
            <p id="model-id-error" role="alert">
              {errors.modelId}
            </p>
          )}
          <label>
            API Key
            <input
              aria-label="API Key"
              type="password"
              autoComplete="off"
              value={key}
              aria-invalid={!!errors.apiKey}
              aria-describedby="model-key-help model-key-error"
              placeholder={
                editingCredential ? '已保存，留空保留已有密钥' : '可稍后填写，未设置时无法调用'
              }
              onChange={(event) => setKey(event.target.value)}
            />
          </label>
          <p id="model-key-help">
            {editingCredential ? (
              <>
                <span aria-label="已保存密钥掩码">••••••••</span> 已关联系统凭据；不读取或回填原
                Key。
              </>
            ) : (
              '尚未设置密钥。'
            )}{' '}
            修改服务地址时需重新填写对应密钥。
          </p>
          {errors.apiKey && (
            <p id="model-key-error" role="alert">
              {errors.apiKey}
            </p>
          )}
          <button type="submit">{busy ? '处理中…' : '保存模型配置'}</button>
          <p className="muted">离开此页面会丢弃未保存的草稿和密钥输入；已保存配置不受影响。</p>
        </form>
      </fieldset>
      <h3>已保存配置</h3>
      <p>
        共 {catalog?.total ?? 0} 条，显示最近 {catalog?.models.length ?? 0} 条（最多 100 条）。
      </p>
      {catalog?.models.length === 0 && <p>尚无配置，请先新建并保存。</p>}
      <ul>
        {catalog?.models.map((item) => (
          <li key={item.configId}>
            <strong>{item.name}</strong> / {item.modelId} / {item.configId} / revision{' '}
            {item.revision}
            <p>
              {item.baseUrl} /{' '}
              {item.credentialState === 'referenced' ? '已关联系统凭据' : '未设置密钥'}
            </p>
            <button type="button" disabled={locked} onClick={() => requestEditor(item)}>
              编辑配置
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
