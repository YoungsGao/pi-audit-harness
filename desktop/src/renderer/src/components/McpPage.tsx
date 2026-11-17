import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type {
  McpServerConfig,
  McpCatalog,
  McpRuntimeInfo,
  McpToolsInfo,
  McpAction,
  McpData
} from '../../../shared/mcp-settings'

const fresh = (): McpServerConfig => ({
  id: '',
  name: '',
  kind: 'codegraph',
  transport: 'builtin',
  enabled: false,
  command: '',
  args: [],
  url: '',
  tools: null,
  semgrepPath: '',
  revision: 1
})
const kinds = { codegraph: 'CodeGraph 补证', static: '静态扫描', custom: '自定义 MCP' }
const states = { ready: '已启用', connected: '已连接', disabled: '已停用', configured: '待连接' }
const example = JSON.stringify(
  { mcpServers: { 本地示例: { command: 'python', args: ['-m', 'your_mcp_server'] } } },
  null,
  2
)

export function McpPage(): React.JSX.Element {
  const [catalog, setCatalog] = useState<McpCatalog>({ servers: [], total: 0, pid: 0, port: 0 })
  const [runtime, setRuntime] = useState<McpRuntimeInfo | null>(null)
  const [pythonPath, setPythonPath] = useState('')
  const [draft, setDraft] = useState<McpServerConfig>(fresh)
  const [argsText, setArgsText] = useState('[]')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('正在读取本地扩展服务…')
  const [tools, setTools] = useState<McpToolsInfo | null>(null)
  const [chosenTools, setChosenTools] = useState<string[]>([])
  const [importing, setImporting] = useState(false),
    [importText, setImportText] = useState('')
  const [calling, setCalling] = useState(''),
    [callArgs, setCallArgs] = useState('{}'),
    [callResult, setCallResult] = useState('')
  function activate(row: McpServerConfig): void {
    setDraft({ ...row })
    setArgsText(JSON.stringify(row.args, null, 2))
    setTools(null)
    setCallResult('')
    setCalling('')
  }
  async function request(action: McpAction, input: unknown): Promise<McpData> {
    const reply = await window.audit.mcp(action, input)
    if (!reply.ok) throw new Error(reply.error.code + '：' + reply.error.message)
    return reply.data
  }
  async function refresh(selectId?: string): Promise<void> {
    const data = (await request('list', {})) as McpCatalog
    setCatalog(data)
    const current = data.servers.find((s) => s.id === selectId)
    if (current) activate(current)
    setRuntime((await request('runtime', {})) as McpRuntimeInfo)
  }
  async function work(task: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await task()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'MCP操作失败')
      setMessage('操作未完成，请查看错误信息。')
    } finally {
      const info = await window.audit.mcp('runtime', {}).catch(() => null)
      if (info?.ok && 'pythonPath' in info.data) setRuntime(info.data)
      setBusy(false)
    }
  }
  useEffect(() => {
    let mounted = true
    void (async () => {
      setBusy(true)
      try {
        const info = (await request('runtime', {})) as McpRuntimeInfo
        if (!mounted) return
        setRuntime(info)
        setPythonPath(info.pythonPath)
        const data = (await request('list', {})) as McpCatalog
        if (!mounted) return
        setCatalog(data)
        if (data.servers[0]) activate(data.servers[0])
        setRuntime((await request('runtime', {})) as McpRuntimeInfo)
        setMessage('已连接本地 Python MCP；可编辑配置、测试连接并选择工具。')
      } catch (e) {
        if (mounted) {
          setError(e instanceof Error ? e.message : '读取MCP服务失败')
          setMessage('未连接到 Python MCP，请检查运行环境。')
        }
      } finally {
        const info = await window.audit.mcp('runtime', {}).catch(() => null)
        if (mounted) {
          if (info?.ok && 'pythonPath' in info.data) setRuntime(info.data)
          setBusy(false)
        }
      }
    })()
    return () => {
      mounted = false
    }
  }, [])
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    await work(async () => {
      let args: unknown
      try {
        args = JSON.parse(argsText)
      } catch {
        throw new Error('启动参数必须为JSON字符串数组，例如 ["-m", "my_server"]')
      }
      if (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))
        throw new Error('启动参数必须为JSON字符串数组')
      const { id } = draft
      const fields = {
        name: draft.name,
        kind: draft.kind,
        transport: draft.transport,
        enabled: draft.enabled,
        command: draft.command,
        url: draft.url,
        tools: draft.tools,
        semgrepPath: draft.semgrepPath,
        revision: draft.revision
      }
      const data = (await request('save', { ...fields, ...(id ? { id } : {}), args })) as McpCatalog
      setCatalog(data)
      const saved = id ? data.servers.find((s) => s.id === id) : data.servers.at(-1)
      if (saved) activate(saved)
      setMessage('服务配置已保存。自定义服务点击“启动”后连接。')
    })
  }
  async function inspect(): Promise<void> {
    await work(async () => {
      const result = (await request('test', { id: draft.id })) as McpToolsInfo
      setTools(result)
      setChosenTools(
        result.tools
          .filter((t) => draft.tools === null || draft.tools.includes(t.name))
          .map((t) => t.name)
      )
      setCalling(result.tools[0]?.name ?? '')
      const latest = (await request('list', {})) as McpCatalog
      setCatalog(latest)
      const current = latest.servers.find((s) => s.id === draft.id)
      if (current) setDraft(current)
      setRuntime((await request('runtime', {})) as McpRuntimeInfo)
      setMessage(`连接测试通过：${result.protocol}，发现 ${result.tools.length} 个可配置工具。`)
    })
  }
  return (
    <div className="mcp-page" data-testid="mcp-page">
      <section className="card" aria-label="Python MCP运行环境">
        <div className="mcp-heading">
          <div>
            <h2>本地扩展服务</h2>
            <p className="muted">
              CodeGraph 补证与静态扫描由 Python 提供标准 MCP
              工具。配置保存到本机，工具调用沿用当前审计预算。
            </p>
          </div>
          <span className="status-label" data-testid="mcp-runtime-state">
            {runtime
              ? {
                  ready: 'Python 已就绪',
                  starting: 'Python 启动中',
                  stopped: 'Python 未启动',
                  failed: 'Python 启动失败'
                }[runtime.state]
              : '读取中'}
          </span>
        </div>
        <div className="mcp-runtime-form">
          <label>
            Python 解释器
            <input
              aria-label="Python解释器"
              value={pythonPath}
              placeholder="留空自动检测；或输入 python.exe 完整路径"
              onChange={(e) => setPythonPath(e.target.value)}
              disabled={busy}
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void work(async () => {
                await request('configureRuntime', { pythonPath: pythonPath.trim() })
                await refresh()
                setMessage('运行环境已保存并启动。')
              })
            }
          >
            保存运行环境
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void work(async () => {
                setRuntime((await request('restartRuntime', {})) as McpRuntimeInfo)
                await refresh()
                setMessage('Python MCP已重新启动。')
              })
            }
          >
            重启服务
          </button>
        </div>
        {runtime?.port && (
          <p className="muted" data-testid="mcp-local-address">
            本地地址 http://127.0.0.1:{runtime.port} · Python PID {runtime.pid} · /codegraph/mcp 与
            /static/mcp
          </p>
        )}
        {error && (
          <p role="alert" className="error-text" data-testid="mcp-error">
            {error}
          </p>
        )}
        <p role="status" data-testid="mcp-message">
          {message}
        </p>
        {runtime?.state !== 'ready' && (
          <details>
            <summary>Python环境准备</summary>
            <p>使用 Python 3.11 或更高版本，在 PowerShell 中执行：</p>
            <pre>{`& "${runtime?.pythonPath ?? 'python'}" -m pip install -r "${runtime?.sourceRoot ?? 'python'}/requirements-runtime.txt"`}</pre>
            <p>仓库内优先自动使用 python/.venv；安装版会随附 Python 服务源码与依赖清单。</p>
          </details>
        )}
      </section>
      <section className="card">
        <div className="mcp-toolbar">
          <h2>
            MCP 服务配置 <span className="muted">{catalog.total}</span>
          </h2>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              activate(fresh())
              setMessage('填写配置后保存。')
            }}
          >
            新增服务
          </button>
          <button type="button" disabled={busy} onClick={() => setImporting(!importing)}>
            导入 MCP
          </button>
          <button type="button" disabled={busy} onClick={() => void work(() => refresh(draft.id))}>
            刷新列表
          </button>
        </div>
        {importing && (
          <div className="mcp-import">
            <h3>导入服务配置</h3>
            <p>
              支持 mcpServers JSON 和本应用的 servers 数组；导入后处于停用状态，点击启动后连接。
            </p>
            <textarea
              aria-label="MCP导入JSON"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={example}
              rows={7}
            />
            <div className="mcp-toolbar">
              <button
                type="button"
                disabled={busy || !importText.trim()}
                onClick={() =>
                  void work(async () => {
                    let value: unknown
                    try {
                      value = JSON.parse(importText)
                    } catch {
                      throw new Error('导入文本不是有效JSON')
                    }
                    await request('import', value)
                    await refresh()
                    setImportText('')
                    setImporting(false)
                    setMessage('配置已导入，尚未启动。')
                  })
                }
              >
                导入文本
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void work(async () => {
                    const reply = await window.audit.importMcpConfig()
                    if (!reply) return
                    if (!reply.ok) throw new Error(reply.error.message)
                    setCatalog(reply.data as McpCatalog)
                    setImporting(false)
                    setMessage('JSON文件已导入，尚未启动。')
                  })
                }
              >
                选择 JSON 文件
              </button>
            </div>
          </div>
        )}
        <div className="mcp-layout">
          <div className="mcp-server-list" aria-label="MCP服务列表">
            {catalog.servers.map((server) => (
              <button
                type="button"
                key={server.id}
                className={'mcp-server ' + (draft.id === server.id ? 'is-selected' : '')}
                disabled={busy}
                onClick={() => activate(server)}
                data-testid={'mcp-server-' + server.id}
              >
                <strong>{server.name}</strong>
                <span>
                  {kinds[server.kind]} · {states[server.state ?? 'configured']}
                </span>
                <small>{server.transport === 'builtin' ? 'Python · HTTP' : server.transport}</small>
              </button>
            ))}
            {!catalog.servers.length && <p className="muted">尚无服务配置，可新增或导入。</p>}
          </div>
          <div className="mcp-editor">
            <form onSubmit={save}>
              <h3>{draft.id ? '编辑服务' : '新增服务'}</h3>
              <label>
                服务名称
                <input
                  aria-label="MCP服务名称"
                  required
                  maxLength={100}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  disabled={busy}
                />
              </label>
              <div className="mcp-fields">
                <label>
                  服务能力
                  <select
                    aria-label="MCP服务能力"
                    value={draft.kind}
                    disabled={busy}
                    onChange={(e) => {
                      const kind = e.target.value as McpServerConfig['kind']
                      setDraft({
                        ...draft,
                        kind,
                        transport: kind === 'custom' ? 'stdio' : 'builtin',
                        tools: null
                      })
                    }}
                  >
                    <option value="codegraph">CodeGraph 补证</option>
                    <option value="static">静态扫描</option>
                    <option value="custom">自定义 MCP</option>
                  </select>
                </label>
                <label>
                  连接方式
                  <select
                    aria-label="MCP连接方式"
                    value={draft.transport}
                    disabled={busy || draft.kind !== 'custom'}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        transport: e.target.value as McpServerConfig['transport']
                      })
                    }
                  >
                    {draft.kind !== 'custom' ? (
                      <option value="builtin">内置 Python HTTP</option>
                    ) : (
                      <>
                        <option value="stdio">本地程序 stdio</option>
                        <option value="http">本地 Streamable HTTP</option>
                      </>
                    )}
                  </select>
                </label>
              </div>
              {draft.kind === 'static' && (
                <label>
                  Semgrep 程序路径
                  <input
                    aria-label="Semgrep程序路径"
                    value={draft.semgrepPath}
                    onChange={(e) => setDraft({ ...draft, semgrepPath: e.target.value })}
                    placeholder="Semgrep 1.185.0 的完整程序路径"
                    disabled={busy}
                  />
                  <small className="muted">
                    留空时工具明确返回 unavailable，可继续使用其他取证工具。
                  </small>
                </label>
              )}
              {draft.transport === 'stdio' && (
                <>
                  <label>
                    启动程序
                    <input
                      aria-label="MCP启动程序"
                      value={draft.command}
                      onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                      placeholder="python 或程序完整路径"
                      disabled={busy}
                    />
                  </label>
                  <label>
                    参数 JSON 数组
                    <textarea
                      aria-label="MCP启动参数"
                      value={argsText}
                      onChange={(e) => setArgsText(e.target.value)}
                      rows={3}
                      disabled={busy}
                    />
                  </label>
                </>
              )}
              {draft.transport === 'http' && (
                <label>
                  MCP 地址
                  <input
                    aria-label="MCP地址"
                    value={draft.url}
                    onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                    placeholder="http://127.0.0.1:端口/mcp"
                    disabled={busy}
                  />
                </label>
              )}
              <div className="mcp-toolbar">
                <button type="submit" disabled={busy}>
                  {busy ? '处理中…' : '保存配置'}
                </button>
                {draft.id && (
                  <>
                    <button type="button" disabled={busy} onClick={() => void inspect()}>
                      测试连接 / 查看工具
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void work(async () => {
                          const action =
                            draft.enabled &&
                            (draft.kind !== 'custom' || draft.state === 'connected')
                              ? 'stop'
                              : 'start'
                          await request(action, { id: draft.id })
                          await refresh(draft.id)
                          setMessage(action === 'stop' ? '服务已停用。' : '服务已启动。')
                        })
                      }
                    >
                      {draft.enabled && (draft.kind !== 'custom' || draft.state === 'connected')
                        ? '停用'
                        : '启动'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void work(async () => {
                          await request('delete', { id: draft.id })
                          await refresh()
                          activate(fresh())
                          setMessage('服务配置已删除。')
                        })
                      }
                    >
                      删除配置
                    </button>
                  </>
                )}
              </div>
            </form>
            {tools && tools.id === draft.id && (
              <section className="mcp-tools" aria-label="MCP工具列表">
                <h3>发现的工具</h3>
                <p className="muted">
                  勾选后保存工具选择。CodeGraph 关联读取需要同时启用查询与读取工具。
                </p>
                {tools.tools.map((tool) => (
                  <label className="mcp-tool" key={tool.name}>
                    <input
                      type="checkbox"
                      checked={chosenTools.includes(tool.name)}
                      disabled={busy}
                      onChange={(e) =>
                        setChosenTools(
                          e.target.checked
                            ? [...chosenTools, tool.name]
                            : chosenTools.filter((n) => n !== tool.name)
                        )
                      }
                    />
                    <span>
                      <strong>{tool.name}</strong>
                      <small>{tool.description}</small>
                      <details>
                        <summary>参数结构</summary>
                        <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                      </details>
                    </span>
                  </label>
                ))}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void work(async () => {
                      await request('configureTools', { id: draft.id, tools: chosenTools })
                      await refresh(draft.id)
                      setMessage('工具选择已保存；新调查按所选工具运行。')
                    })
                  }
                >
                  保存工具选择
                </button>
                {draft.kind === 'static' && tools.scannerConfigured === false && (
                  <p className="muted">
                    MCP连接正常，尚未配置Semgrep程序。扫描工具会保留此能力缺口。
                  </p>
                )}
                {draft.kind === 'custom' && (
                  <div className="mcp-manual">
                    <h4>手动调用</h4>
                    <p className="muted">
                      自定义工具可在此测试；审计流程使用固定快照契约的 CodeGraph 和静态扫描工具。
                    </p>
                    <select
                      aria-label="手动调用工具"
                      value={calling}
                      onChange={(e) => setCalling(e.target.value)}
                    >
                      {tools.tools.map((t) => (
                        <option key={t.name}>{t.name}</option>
                      ))}
                    </select>
                    <textarea
                      aria-label="工具调用参数"
                      value={callArgs}
                      onChange={(e) => setCallArgs(e.target.value)}
                      rows={4}
                    />
                    <button
                      type="button"
                      disabled={busy || !draft.enabled || !calling}
                      onClick={() =>
                        void work(async () => {
                          let value: unknown
                          try {
                            value = JSON.parse(callArgs)
                          } catch {
                            throw new Error('工具参数不是有效JSON')
                          }
                          const data = await request('call', {
                            id: draft.id,
                            name: calling,
                            arguments: value
                          })
                          setCallResult(JSON.stringify(data, null, 2))
                        })
                      }
                    >
                      调用工具
                    </button>
                    {callResult && <pre data-testid="mcp-call-result">{callResult}</pre>}
                  </div>
                )}
              </section>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
