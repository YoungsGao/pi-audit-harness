import { useState } from 'react'
import type { FormEvent } from 'react'
import type { MetadataOverview, ProjectInput } from '../../../shared/metadata-contracts'
const empty: ProjectInput = { projectName: '', path: '', sourceType: 'local', gitUrl: null }
export function MetadataCard(): React.JSX.Element {
  const [data, setData] = useState<MetadataOverview | null>(null),
    [draft, setDraft] = useState<ProjectInput>({ ...empty })
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('填写本地目录或已有 Git checkout 的项目元数据。')
  async function load(): Promise<void> {
    const result = await window.audit.getMetadata()
    if (result.ok) setData(result.data)
    else throw new Error(`${result.error.code}：${result.error.message}（${result.requestId}）`)
  }
  async function run(work: () => Promise<string>): Promise<void> {
    setBusy(true)
    try {
      setMessage(await work())
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '客户端通信失败')
    } finally {
      setBusy(false)
    }
  }
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    await run(async () => {
      const result = await window.audit.saveProject(draft)
      if (!result.ok)
        throw new Error(`${result.error.code}：${result.error.message}（${result.requestId}）`)
      setDraft({
        ...draft,
        projectId: result.data.projectId,
        expectedRevision: result.data.revision
      })
      return '项目已保存：' + result.data.projectId
    })
  }
  return (
    <section className="card" aria-label="项目元数据">
      <h2>项目元数据</h2>
      <p role="status">{message}</p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void run(async () => '项目元数据读取成功')}
      >
        读取项目
      </button>
      <fieldset disabled={busy}>
        <legend>项目登记</legend>
        <form onSubmit={save}>
          <p>
            项目 ID：{draft.projectId ?? '保存后生成'} / revision：
            {draft.expectedRevision ?? '新建'}
          </p>
          <label>
            项目名称
            <input
              aria-label="项目名称"
              required
              value={draft.projectName}
              onChange={(e) => setDraft({ ...draft, projectName: e.target.value })}
            />
          </label>
          <label>
            本地绝对路径
            <input
              aria-label="本地绝对路径"
              required
              value={draft.path}
              onChange={(e) => setDraft({ ...draft, path: e.target.value })}
            />
          </label>
          <label>
            来源
            <select
              aria-label="来源"
              value={draft.sourceType}
              onChange={(e) =>
                setDraft({ ...draft, sourceType: e.target.value as 'local' | 'git' })
              }
            >
              <option value="local">local</option>
              <option value="git">git</option>
            </select>
          </label>
          <label>
            Git URL
            <input
              aria-label="Git URL"
              value={draft.gitUrl ?? ''}
              onChange={(e) => setDraft({ ...draft, gitUrl: e.target.value || null })}
            />
          </label>
          <button type="submit">保存项目元数据</button>
          <button type="button" onClick={() => setDraft({ ...empty })}>
            新建项目记录
          </button>
        </form>
      </fieldset>
      <ul>
        {data?.projects.map((item) => (
          <li key={item.projectId}>
            {item.projectName} / {item.projectId} / {item.sourceType} / commit：
            {item.commit ?? '无'} / dirty：{String(item.dirty)}
            {item.needsMetadata && ' / 旧 Git 元数据待补全'}
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                setDraft({
                  projectId: item.projectId,
                  expectedRevision: item.revision,
                  projectName: item.projectName,
                  path: item.path,
                  sourceType: item.sourceType,
                  gitUrl: item.gitUrl
                })
              }
            >
              编辑项目
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
