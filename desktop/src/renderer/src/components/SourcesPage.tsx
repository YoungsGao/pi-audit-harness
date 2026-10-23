import { useState } from 'react'
import type {
  SourceCatalog,
  SourceTools,
  SourceOpened,
  DuplicateChoice
} from '../../../shared/source-contracts'
import type { ApiResult } from '../../../shared/service-protocol'
function unwrap<T>(result: ApiResult<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}：${result.error.message}（请求 ${result.requestId}）`)
  return result.data
}
export function SourcesPage(): React.JSX.Element {
  const [tools, setTools] = useState<SourceTools | null>(null),
    [catalog, setCatalog] = useState<SourceCatalog | null>(null)
  const [name, setName] = useState(''),
    [path, setPath] = useState(''),
    [url, setUrl] = useState(''),
    [choice, setChoice] = useState<DuplicateChoice>('reject')
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(
      '请检测工具、点击刷新读取已有项目，或导入 Java 源码；不会执行项目代码或调用模型。'
    ),
    [opened, setOpened] = useState<SourceOpened | null>(null)
  async function run(work: () => Promise<string>): Promise<void> {
    if (busy) return
    setBusy(true)
    setMessage('源码操作进行中…')
    try {
      setMessage(await work())
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '本地服务通信失败')
    } finally {
      setBusy(false)
    }
  }
  async function refresh(): Promise<void> {
    setCatalog(unwrap(await window.audit.listSources()))
  }
  return (
    <section className="card" aria-label="源码导入">
      <h2>源码导入与项目登记</h2>
      <p role="status" data-testid="source-status">
        {message}
      </p>
      <button
        disabled={busy}
        onClick={() =>
          void run(async () => {
            setTools(unwrap(await window.audit.getSourceTools()))
            return '工具检测完成'
          })
        }
      >
        重新检测 Git 与 rg
      </button>
      {tools && (
        <div>
          <p>
            Git：{tools.git.state} {tools.git.version}
          </p>
          <p>
            rg：{tools.rg.state} {tools.rg.version}
          </p>
          {tools.git.state !== 'available' && (
            <p>
              未检测到可用 Git。请自行访问 https://git-scm.com/download/win
              安装后重启应用再检测；仍可导入本地目录。
            </p>
          )}
          {tools.rg.state !== 'available' && (
            <p>rg 尚不可用，本次源码登记不依赖 rg；后续基础查询能力另行接入。</p>
          )}
        </div>
      )}
      <fieldset disabled={busy}>
        <legend>导入参数</legend>
        <label>
          源码项目名称
          <input aria-label="源码项目名称" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          重复来源处理
          <select
            aria-label="重复来源处理"
            value={choice}
            onChange={(e) => setChoice(e.target.value as DuplicateChoice)}
          >
            <option value="reject">先提示冲突</option>
            <option value="open">打开已有记录（不重新下载）</option>
            <option value="new">创建独立记录/下载独立副本</option>
          </select>
        </label>
        <label>
          本地源码目录
          <input aria-label="本地源码目录" value={path} onChange={(e) => setPath(e.target.value)} />
        </label>
        <button
          onClick={() =>
            void run(async () => {
              const selected = await window.audit.chooseSourceDirectory()
              if (selected) setPath(selected)
              return selected ? '已选择目录，点击导入后才登记' : '已取消目录选择'
            })
          }
        >
          选择源码文件夹
        </button>
        <button
          onClick={() =>
            void run(async () => {
              const saved = unwrap(
                await window.audit.importLocalSource({ projectName: name, path, duplicate: choice })
              )
              await refresh()
              return '源码登记成功：' + saved.projectId
            })
          }
        >
          导入本地源码
        </button>
        <label>
          公开 GitHub URL
          <input
            aria-label="公开 GitHub URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <button
          disabled={tools?.git.state !== 'available'}
          onClick={() =>
            void run(async () => {
              const saved = unwrap(
                await window.audit.importGithubSource({
                  projectName: name,
                  gitUrl: url,
                  duplicate: choice
                })
              )
              await refresh()
              return '仓库下载并登记成功：' + saved.projectId
            })
          }
        >
          下载公开 GitHub 仓库
        </button>
      </fieldset>
      <p>
        首批校验 Java
        源文件。版本指纹只覆盖本次读取范围，不是不可变源码快照。未运行构建、子模块、Git LFS
        下载或风险扫描。
      </p>
      <button
        disabled={busy}
        onClick={() =>
          void run(async () => {
            await refresh()
            return '源码项目列表已刷新'
          })
        }
      >
        刷新源码项目列表
      </button>
      <p>已登记源码项目：{catalog?.total ?? '未读取'}；列表最多显示最近 100 条。</p>
      <ul>
        {catalog?.projects.map((p) => (
          <li key={p.projectId}>
            <strong>{p.projectName}</strong> / {p.sourceType} / {p.projectId}
            <p>{p.path}</p>
            <p>
              commit：{p.commit ?? '不适用'} / dirty：
              {p.dirty === null ? '不适用' : String(p.dirty)} / Java 文件：{p.fileCount}
            </p>
            <p>登记指纹：{p.sourceStamp}</p>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = unwrap(await window.audit.openSourceProject(p.projectId))
                  setOpened(result)
                  return result.changed
                    ? '已打开；源码相对登记时有变化，后续分析需重新确认版本'
                    : '已打开；当前 Java 指纹与登记时一致'
                })
              }
            >
              打开源码项目 {p.projectId}
            </button>
          </li>
        ))}
      </ul>
      {opened && (
        <aside aria-label="已打开源码项目">
          <p>当前打开：{opened.project.projectName}</p>
          <p>当前指纹：{opened.currentStamp}</p>
          <p>变更：{String(opened.changed)}</p>
        </aside>
      )}
    </section>
  )
}
