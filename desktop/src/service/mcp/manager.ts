import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'
import { dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import type { McpAction, McpData, McpRuntimeInfo } from '../../shared/mcp-settings.ts'
import { ApiError } from '../../shared/api-error.ts'
import { mcpDefinitions } from './contracts.ts'
import { staticRules } from './static-scanner.ts'
import { redactText } from '../../shared/redaction.ts'

export function pythonResources(): { root: string; python: string } {
  const packaged = join(process.resourcesPath ?? '', 'audit-python')
  if (existsSync(join(packaged, 'src', 'pi_audit', 'audit_mcp', 'server.py')))
    return { root: packaged, python: 'python' }
  let folder = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 9; i++, folder = dirname(folder)) {
    const root = join(folder, 'python')
    if (existsSync(join(root, 'src', 'pi_audit', 'audit_mcp', 'server.py'))) {
      const python = join(
        root,
        '.venv',
        process.platform === 'win32' ? 'Scripts' : 'bin',
        process.platform === 'win32' ? 'python.exe' : 'python'
      )
      return { root, python: existsSync(python) ? python : 'python' }
    }
  }
  throw new ApiError('MCP_PYTHON_SOURCE_MISSING', 'Python MCP服务文件缺失，请检查安装资源', 503)
}
export class PythonMcpManager {
  private child?: ChildProcessWithoutNullStreams
  private starting?: Promise<void>
  private connection?: { port: number; token: string }
  private state: McpRuntimeInfo['state'] = 'stopped'
  private message = 'Python MCP服务尚未启动'
  private readonly contexts = new Set<string>()
  readonly root: string
  constructor(root: string) {
    this.root = root
  }
  runtime(): McpRuntimeInfo {
    const resources = pythonResources(),
      file = join(this.root, 'mcp', 'runtime.json')
    const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
    return {
      state: this.state,
      pythonPath: config.pythonPath || resources.python,
      sourceRoot: resources.root,
      pid: this.child?.pid ?? null,
      port: this.connection?.port ?? null,
      message: this.message
    }
  }
  async start(): Promise<void> {
    if (this.connection) return
    if (this.starting) return this.starting
    this.starting = this.launch().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }
  private async launch(): Promise<void> {
    const runtime = this.runtime(),
      token = randomBytes(32).toString('hex')
    this.state = 'starting'
    const env: NodeJS.ProcessEnv = {
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONPATH: join(runtime.sourceRoot, 'src')
    }
    for (const key of [
      'PATH',
      'PATHEXT',
      'SystemRoot',
      'WINDIR',
      'TEMP',
      'TMP',
      'HOME',
      'USERPROFILE',
      'PI_AUDIT_SEMGREP_PATH'
    ])
      if (process.env[key]) env[key] = process.env[key]
    const child = spawn(
      runtime.pythonPath,
      ['-u', '-m', 'pi_audit.audit_mcp.server', '--data-root', this.root],
      { cwd: runtime.sourceRoot, env, windowsHide: true, stdio: 'pipe' }
    )
    this.child = child
    let startupStderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.state === 'starting')
        startupStderr = (startupStderr + chunk.toString('utf8')).slice(-8192)
    })
    child.stdin.on('error', () => {})
    child.on('exit', () => {
      if (this.child === child) {
        this.connection = undefined
        this.child = undefined
        this.contexts.clear()
        if (this.state !== 'stopped') {
          this.state = 'failed'
          this.message = 'Python MCP服务已退出，可重新启动'
        }
      }
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const lines = createInterface({ input: child.stdout })
        const timer = setTimeout(
          () =>
            finish(
              new ApiError('MCP_START_TIMEOUT', 'Python MCP启动超时，请检查解释器和依赖', 503)
            ),
          20000
        )
        const finish = (error?: Error): void => {
          clearTimeout(timer)
          lines.close()
          error ? reject(error) : resolve()
        }
        child.once('error', () =>
          finish(
            new ApiError('MCP_PYTHON_MISSING', '无法启动Python，请在扩展服务页配置解释器', 503)
          )
        )
        child.once('exit', () =>
          finish(
            new ApiError(
              'MCP_START_FAILED',
              'Python MCP启动失败；' +
                (startupStderr
                  .split(/\r?\n/)
                  .filter((line) =>
                    /^(ModuleNotFoundError|ImportError|PermissionError|OSError|RuntimeError):/.test(
                      line
                    )
                  )
                  .map((line) => redactText(line).slice(0, 240))
                  .at(-1) ?? '请在所选Python环境安装 python/requirements-runtime.txt 中的依赖'),
              503
            )
          )
        )
        lines.on('line', (line) => {
          try {
            const notice = JSON.parse(line)
            if (
              notice.type === 'ready' &&
              Number.isInteger(notice.port) &&
              notice.port > 0 &&
              notice.port <= 65535
            ) {
              this.connection = { port: notice.port, token }
              finish()
            }
          } catch {
            /* only the readiness JSON is a control message */
          }
        })
        child.stdin.write(
          JSON.stringify({ token, definitions: mcpDefinitions, rules: staticRules }) + '\n'
        )
      })
      this.state = 'ready'
      this.message = 'Python MCP服务已就绪，两个本地MCP端点共用一个进程'
    } catch (error) {
      child.kill()
      if (!child.pid && this.child === child) this.child = undefined
      this.state = 'failed'
      this.message = error instanceof ApiError ? error.message : 'Python MCP启动失败'
      throw error
    }
  }
  async request(
    path: string,
    method: string = 'POST',
    body?: unknown,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (method === 'DELETE' && path.startsWith('/contexts/') && !this.connection) {
      this.contexts.delete(path)
      return { id: path.slice('/contexts/'.length) }
    }
    await this.start()
    const c = this.connection!
    const response = await fetch(`http://127.0.0.1:${c.port}${path}`, {
      method,
      headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([AbortSignal.timeout(90000), ...(signal ? [signal] : [])]),
      redirect: 'error'
    })
    const raw = await response.text()
    if (raw.length > 4 * 1024 * 1024) throw new ApiError('MCP_OUTPUT_LIMIT', 'MCP响应过大', 502)
    const data = JSON.parse(raw)
    if (!response.ok)
      throw new ApiError(
        data.error?.code ?? 'MCP_SERVICE_FAILED',
        redactText(data.error?.message ?? 'MCP服务操作失败'),
        response.status
      )
    if (path.startsWith('/contexts/')) {
      if (method === 'DELETE') this.contexts.delete(path)
      else this.contexts.add(path)
    }
    return data
  }
  async action(action: McpAction, value: unknown, signal?: AbortSignal): Promise<McpData> {
    if (action === 'runtime') return this.runtime()
    if (['configureRuntime', 'restartRuntime'].includes(action) && this.contexts.size)
      throw new ApiError('MCP_IN_USE', 'MCP服务正在调查中使用，请先停止调查再修改运行环境', 409)
    if (action === 'configureRuntime') {
      const input = value as { pythonPath?: unknown }
      if (
        !input ||
        typeof input.pythonPath !== 'string' ||
        (input.pythonPath &&
          !isAbsolute(input.pythonPath) &&
          !['python', 'python3', 'python.exe'].includes(input.pythonPath)) ||
        /[\r\n\0]/.test(input.pythonPath)
      )
        throw new ApiError(
          'MCP_CONFIG_INVALID',
          '解释器应为空（自动检测）、python 命令或完整的Python程序路径',
          400
        )
      await this.close()
      const folder = join(this.root, 'mcp')
      mkdirSync(folder, { recursive: true })
      const file = join(folder, 'runtime.json')
      writeFileSync(file + '.tmp', JSON.stringify({ pythonPath: input.pythonPath }))
      renameSync(file + '.tmp', file)
      return this.runtime()
    }
    if (action === 'restartRuntime') {
      await this.close()
      await this.start()
      return this.runtime()
    }
    return (await this.request('/api/' + action, 'POST', value, signal)) as unknown as McpData
  }
  async endpoint(
    kind: 'codegraph' | 'static',
    serverId: string,
    contextId: string
  ): Promise<{ url: URL; headers: Record<string, string> }> {
    await this.start()
    const c = this.connection!
    return {
      url: new URL(`http://127.0.0.1:${c.port}/${kind}/mcp`),
      headers: {
        Authorization: 'Bearer ' + c.token,
        'X-Audit-Server': serverId,
        'X-Audit-Context': contextId
      }
    }
  }
  async close(): Promise<void> {
    if (this.starting) await this.starting.catch(() => {})
    const child = this.child
    this.state = 'stopped'
    this.message = 'Python MCP服务已停止'
    this.connection = undefined
    if (!child) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 6000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.stdin.end('shutdown\n')
    })
    if (this.child === child) this.child = undefined
  }
}
