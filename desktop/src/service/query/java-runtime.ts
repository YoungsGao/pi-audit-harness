import { mkdir, mkdtemp, writeFile, readdir, cp, lstat, rm } from 'node:fs/promises'
import { join, isAbsolute, posix, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ApiError } from '../../shared/api-error.ts'
import type {
  QueryOperation,
  QueryRuntimeState,
  PositionEncoding
} from '../../shared/query-contracts.ts'
import { command } from '../sources/process.ts'
import { LspRpc } from './lsp-rpc.ts'
import { maskJava } from '../rules/builtin.ts'

export interface RuntimeOptions {
  dataRoot?: string
  javaHome?: string
  jdtlsHome?: string
  startupTimeoutMs?: number
  requestTimeoutMs?: number
  idleMs?: number
}
export interface QuerySnapshot {
  projectId: string
  runId: string
  snapshotId: string
  sourceStamp: string
  files: { filePath: string; source: string }[]
}
export const safeJavaSettings = {
  java: {
    autobuild: { enabled: false },
    import: {
      maven: { enabled: false },
      gradle: {
        enabled: false,
        wrapper: { enabled: false },
        annotationProcessing: { enabled: false }
      }
    },
    configuration: { updateBuildConfiguration: 'disabled' },
    maven: { downloadSources: false, updateSnapshots: false },
    eclipse: { downloadSources: false },
    jdt: { ls: { lombokSupport: { enabled: false } } },
    project: { referencedLibraries: [] },
    references: { includeDecompiledSources: false },
    format: { enabled: false },
    saveActions: { organizeImports: false },
    executeCommand: { enabled: false }
  }
}
const initialState = (): QueryRuntimeState => ({
  state: 'disabled',
  index: 'unknown',
  wholeWorkspaceIndexed: false,
  starts: 0,
  pending: 0,
  errorCode: null,
  positionEncoding: 'utf-16',
  capabilities: []
})
export class JavaRuntime {
  readonly state = initialState()
  rpc?: LspRpc
  root = ''
  private directory = ''
  readonly sourceGaps: string[] = ['JAVA_SOURCE_ONLY_NO_BUILD_CLASSPATH']
  private stopped = false
  private starting?: Promise<void>
  private lastUse = Date.now()
  private busy = 0
  private readonly activeProgress = new Set<string>()
  readonly snapshot: QuerySnapshot
  private readonly options: RuntimeOptions
  constructor(snapshot: QuerySnapshot, options: RuntimeOptions) {
    this.snapshot = snapshot
    this.options = options
  }
  get idle(): boolean {
    return !this.busy && Date.now() - this.lastUse > (this.options.idleMs ?? 120000)
  }
  status(): QueryRuntimeState {
    return {
      ...this.state,
      pending: this.rpc?.pendingCount ?? 0,
      capabilities: [...this.state.capabilities]
    }
  }
  async use<T>(fn: (runtime: JavaRuntime) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.busy++
    this.lastUse = Date.now()
    try {
      this.starting ??= this.start()
      await waitFor(this.starting, signal)
      if (this.stopped) throw new ApiError('QUERY_RUNTIME_EXITED', '语言服务器已退出', 503)
      return await fn(this)
    } finally {
      this.busy--
      this.lastUse = Date.now()
    }
  }
  private async start(): Promise<void> {
    const {
      dataRoot,
      javaHome = process.env.PI_AUDIT_JAVA_HOME ?? process.env.JAVA_HOME,
      jdtlsHome = process.env.PI_AUDIT_JDTLS_HOME
    } = this.options
    if (
      !dataRoot ||
      !javaHome ||
      !jdtlsHome ||
      ![dataRoot, javaHome, jdtlsHome].every(isAbsolute)
    ) {
      this.state.errorCode = 'QUERY_RUNTIME_MISSING'
      throw new ApiError('QUERY_RUNTIME_MISSING', '请配置本机 Java 21+ 与 JDT-LS 的绝对目录', 503)
    }
    this.state.state = 'preparing'
    const deadline = AbortSignal.timeout(this.options.startupTimeoutMs ?? 60000)
    try {
      const executable = join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
      if (!(await lstat(executable)).isFile()) throw Error('java')
      const version = await command(executable, ['--version'], {
        signal: deadline,
        timeoutMs: 5000
      })
      if (Number(/(?:openjdk|java) (\d+)/.exec(version)?.[1] ?? 0) < 21) throw Error('java21')
      const jar = (await readdir(join(jdtlsHome, 'plugins'))).filter((n) =>
        /^org\.eclipse\.equinox\.launcher_[\w.-]+\.jar$/.test(n)
      )
      if (jar.length !== 1) throw Error('launcher')
      const cache = join(dataRoot, 'query-runtime')
      await mkdir(cache, { recursive: true })
      this.directory = await mkdtemp(join(cache, 'java-'))
      this.root = join(this.directory, 'source')
      await mkdir(this.root)
      for (const file of this.snapshot.files) {
        if (deadline.aborted || this.stopped)
          throw new ApiError('QUERY_TIMEOUT', '准备语言服务器超时或已关闭', 504)
        // 所有相对路径来自校验过的 SQLite manifest；缓存目录为本进程独占新目录。
        if (
          !/\.java$/i.test(file.filePath) ||
          isAbsolute(file.filePath) ||
          file.filePath.includes('\\') ||
          file.filePath.split('/').some((p) => !p || p === '.' || p === '..')
        )
          throw Error('snapshot path')
        const target = join(this.root, file.filePath)
        await mkdir(join(target, '..'), { recursive: true })
        await writeFile(target, file.source, { flag: 'wx' })
      }
      // 只导入本应用生成的普通 Java 工程，不复制用户的 pom、Gradle、.project 或脚本。
      await writeFile(
        join(this.root, '.project'),
        '<?xml version="1.0"?><projectDescription><name>audit_snapshot</name><buildSpec></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>'
      )
      const roots = new Set<string>()
      for (const file of this.snapshot.files) {
        const directory = posix.dirname(file.filePath) === '.' ? '' : posix.dirname(file.filePath)
        const packagePath = /\bpackage\s+([\p{L}\p{N}_$.]+)\s*;/u
          .exec(maskJava(file.source))?.[1]
          .replaceAll('.', '/')
        if (!packagePath) roots.add(directory)
        else if (directory === packagePath || directory.endsWith('/' + packagePath))
          roots.add(directory.slice(0, -packagePath.length).replace(/\/$/, ''))
        else {
          roots.add('')
          this.sourceGaps.push('JAVA_PACKAGE_PATH_MISMATCH')
        }
      }
      const xml = (value: string): string =>
        value
          .replaceAll('&', '&amp;')
          .replaceAll('"', '&quot;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
      const entries = [...roots]
        .map((root) => {
          const exclusions = [...roots]
            .filter((other) => other !== root && (!root || other.startsWith(root + '/')))
            .map((other) => other.slice(root ? root.length + 1 : 0) + '/**')
          return `<classpathentry kind="src" path="${xml(root)}"${exclusions.length ? ` excluding="${xml(exclusions.join('|'))}"` : ''}/>`
        })
        .join('')
      await writeFile(
        join(this.root, '.classpath'),
        `<?xml version="1.0"?><classpath>${entries}<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="output" path=".query-bin"/></classpath>`
      )
      await mkdir(join(this.root, '.settings'))
      await writeFile(
        join(this.root, '.settings', 'org.eclipse.jdt.core.prefs'),
        'eclipse.preferences.version=1\norg.eclipse.jdt.core.compiler.processAnnotations=disabled\norg.eclipse.jdt.core.compiler.source=21\norg.eclipse.jdt.core.compiler.compliance=21\norg.eclipse.jdt.core.compiler.codegen.targetPlatform=21\n'
      )
      const config = join(this.directory, 'config')
      await cp(
        join(
          jdtlsHome,
          process.platform === 'win32'
            ? 'config_win'
            : process.platform === 'darwin'
              ? 'config_mac'
              : 'config_linux'
        ),
        config,
        { recursive: true }
      )
      if (this.stopped || deadline.aborted)
        throw new ApiError('QUERY_CANCELLED', '语言服务器启动已取消', 499)
      this.state.state = 'initializing'
      this.state.starts++
      const env: NodeJS.ProcessEnv = { ...process.env, JAVA_HOME: javaHome }
      // JVM 注入选项不继承；目标业务进程、构建工具和注解处理器不在本客户端接口中。
      delete env.JAVA_TOOL_OPTIONS
      delete env.JDK_JAVA_OPTIONS
      delete env._JAVA_OPTIONS
      const rpc = new LspRpc(
        executable,
        [
          '-Declipse.application=org.eclipse.jdt.ls.core.id1',
          '-Dosgi.bundles.defaultStartLevel=4',
          '-Declipse.product=org.eclipse.jdt.ls.core.product',
          '-Dlog.level=ERROR',
          '-Xmx512m',
          '--add-modules=ALL-SYSTEM',
          '--add-opens',
          'java.base/java.util=ALL-UNNAMED',
          '--add-opens',
          'java.base/java.lang=ALL-UNNAMED',
          '-jar',
          join(jdtlsHome, 'plugins', jar[0]),
          '-configuration',
          config,
          '-data',
          join(this.directory, 'workspace')
        ],
        this.directory,
        env
      )
      this.rpc = rpc
      rpc.onExit = () => {
        if (!this.stopped) {
          this.state.state = 'failed'
          this.state.errorCode = 'QUERY_RUNTIME_EXITED'
        }
      }
      rpc.onServerRequest = (method, params) => {
        if (method === 'workspace/configuration') {
          const items = (params as { items?: { section?: string }[] })?.items ?? []
          return items.map(
            (item) =>
              item.section
                ?.split('.')
                .reduce<unknown>(
                  (v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : null),
                  safeJavaSettings
                ) ?? safeJavaSettings
          )
        }
        if (method === 'workspace/applyEdit')
          return { applied: false, failureReason: 'Read-only audit queries' }
        if (
          [
            'client/registerCapability',
            'client/unregisterCapability',
            'window/workDoneProgress/create'
          ].includes(method)
        )
          return null
        return undefined
      }
      rpc.onNotification = (method, params) => {
        if (method !== '$/progress') return // 诊断通知不能证明全工作区索引完成。
        const progress = params as { token?: unknown; value?: { kind?: string } }
        const token = String(progress.token)
        if (progress.value?.kind === 'begin') this.activeProgress.add(token)
        if (progress.value?.kind === 'end') this.activeProgress.delete(token)
        this.state.index = this.activeProgress.size ? 'working' : 'quiescent'
        if (this.activeProgress.size) this.state.state = 'indexing'
      }
      const result = (await rpc.request(
        'initialize',
        {
          processId: process.pid,
          rootUri: pathToFileURL(this.root).href,
          workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: 'audit_snapshot' }],
          capabilities: {
            general: { positionEncodings: ['utf-16', 'utf-8', 'utf-32'] },
            workspace: { configuration: true, workspaceFolders: true },
            window: { workDoneProgress: true },
            textDocument: {
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              definition: { linkSupport: true },
              callHierarchy: { dynamicRegistration: false }
            }
          },
          initializationOptions: {
            settings: safeJavaSettings,
            bundles: [],
            workspaceFolders: [pathToFileURL(this.root).href],
            extendedClientCapabilities: { progressReportProvider: false }
          }
        },
        this.options.startupTimeoutMs ?? 60000,
        deadline
      )) as { capabilities?: Record<string, unknown> }
      const caps = result?.capabilities ?? {},
        encoding = caps.positionEncoding ?? 'utf-16'
      if (!['utf-8', 'utf-16', 'utf-32'].includes(String(encoding))) throw Error('encoding')
      this.state.positionEncoding = encoding as PositionEncoding
      const operations: QueryOperation[] = []
      for (const [cap, op] of [
        ['documentSymbolProvider', 'symbols'],
        ['definitionProvider', 'definition'],
        ['referencesProvider', 'references']
      ] as const)
        if (caps[cap]) operations.push(op)
      if (caps.callHierarchyProvider) operations.push('incomingCalls', 'outgoingCalls')
      this.state.capabilities = operations
      rpc.notify('initialized', {})
      rpc.notify('workspace/didChangeConfiguration', { settings: safeJavaSettings })
      this.state.state = 'indexing'
    } catch (error) {
      const code = deadline.aborted
        ? 'QUERY_TIMEOUT'
        : error instanceof ApiError
          ? error.code
          : 'QUERY_RUNTIME_MISSING'
      await this.rpc?.close()
      this.state.state = this.stopped ? 'stopped' : 'failed'
      this.state.errorCode = code
      throw new ApiError(code, 'Java 语义运行时未就绪；基础查询仍可用', 503)
    }
  }
  async request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    const value = await this.rpc!.request(
      method,
      params,
      this.options.requestTimeoutMs ?? 10000,
      signal
    )
    this.state.state = this.activeProgress.size ? 'indexing' : 'ready'
    return value
  }
  async close(): Promise<void> {
    this.stopped = true
    await this.rpc?.close()
    await this.starting?.catch(() => {})
    this.state.state = 'stopped'
    // 只删除由 mkdtemp 返回的本实例目录，从不接收用户提供的删除目标。
    if (this.directory) {
      const rel = relative(join(this.options.dataRoot!, 'query-runtime'), this.directory)
      if (!isAbsolute(rel) && rel.startsWith('java-') && !rel.includes(sep) && rel !== '..')
        await rm(this.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }
}
export async function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) throw new ApiError('QUERY_CANCELLED', '代码查询已取消', 499)
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new ApiError('QUERY_CANCELLED', '代码查询已取消', 499))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
export class JavaRuntimePool {
  private readonly sessions = new Map<string, JavaRuntime>()
  private readonly timer: ReturnType<typeof setInterval>
  private closing = false
  private reaping = false
  private readonly options: RuntimeOptions
  constructor(options: RuntimeOptions) {
    this.options = options
    this.timer = setInterval(
      () => {
        void this.reap()
      },
      Math.min(options.idleMs ?? 30000, 30000)
    )
    this.timer.unref()
  }
  private async reap(): Promise<void> {
    if (this.reaping || this.closing) return
    this.reaping = true
    try {
      for (const [key, value] of this.sessions)
        if (value.idle) {
          // 退出完成前仍占容量，避免新请求暂时突破进程数量上限。
          await value.close().catch(() => {})
          if (this.sessions.get(key) === value) this.sessions.delete(key)
        }
    } finally {
      this.reaping = false
    }
  }
  get(snapshot: QuerySnapshot): JavaRuntime {
    if (this.closing) throw new ApiError('QUERY_CANCELLED', '查询服务已关闭', 499)
    const key = JSON.stringify([snapshot.projectId, 'java', snapshot.sourceStamp])
    let runtime = this.sessions.get(key)
    if (!runtime) {
      if (this.sessions.size >= 2)
        throw new ApiError('QUERY_RUNTIME_BUSY', '已有两个项目语义运行时，请等待空闲回收', 429)
      runtime = new JavaRuntime(snapshot, this.options)
      this.sessions.set(key, runtime)
    }
    return runtime
  }
  async close(): Promise<void> {
    this.closing = true
    clearInterval(this.timer)
    await Promise.allSettled([...this.sessions.values()].map((value) => value.close()))
    this.sessions.clear()
  }
}
