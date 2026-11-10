import { fork } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path'
import {
  existsSync,
  lstatSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  statSync
} from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { ApiError } from '../../shared/api-error.ts'
import { graphHash } from '../storage/graph-repository.ts'
import { GRAPH_ADAPTER, GRAPH_ENGINE } from './graph-contracts.ts'
import type { GraphBinding, GraphNode, GraphEdge } from './graph-contracts.ts'
import type { QuerySnapshot, RuntimeOptions } from './query-runtime.ts'
import type { QueryRuntimeState } from '../../shared/query-contracts.ts'
import { isSnapshotJavaPath } from '../../shared/snapshot-path.ts'
import { graphEnvironment } from './graph-environment.ts'

const hashFile = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex')
interface Artifact {
  file: string
  binding: GraphBinding
  durationMs: number
  peakRss: number
}
interface BuildMeta {
  digest: string
  indexed: string[]
  errors: number
  durationMs: number
  peakRss: number
}
const unpack = (path: string): string => path.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
function workerResources(): { worker: string; binary: string; library: string } {
  const req = createRequire(import.meta.url)
  const pkg = `@colbymchenry/codegraph-${process.platform}-${process.arch}`
  const packagedLibrary = join(
    process.resourcesPath ?? '',
    'codegraph-packages',
    `codegraph-${process.platform}-${process.arch}`,
    'lib/dist/index.js'
  )
  const library = existsSync(packagedLibrary)
    ? packagedLibrary
    : unpack(req.resolve(pkg + '/lib/dist/index.js'))
  const packageRoot = resolve(dirname(library), '../..')
  const binary = join(packageRoot, process.platform === 'win32' ? 'node.exe' : 'node')
  let folder = dirname(fileURLToPath(import.meta.url))
  let worker = join(process.resourcesPath ?? '', 'codegraph-worker.cjs')
  for (let depth = 0; !existsSync(worker) && depth < 8; depth++) {
    worker = join(folder, 'resources/codegraph-worker.cjs')
    folder = dirname(folder)
  }
  if (!existsSync(worker) || !existsSync(binary))
    throw new ApiError('QUERY_GRAPH_RUNTIME_MISSING', 'CodeGraph平台制品或worker缺失', 503)
  const pkgVersion = JSON.parse(
    readFileSync(req.resolve('@colbymchenry/codegraph/package.json'), 'utf8')
  ).version
  const libVersion = JSON.parse(readFileSync(join(packageRoot, 'lib/package.json'), 'utf8')).version
  if (pkgVersion !== '1.6.2' || libVersion !== '1.6.2')
    throw new ApiError('QUERY_GRAPH_VERSION', 'CodeGraph版本不匹配', 503)
  return { worker, binary, library }
}
export class CodeGraphPool {
  private readonly root: string
  private readonly options: RuntimeOptions
  private active?: {
    key: string
    task: Promise<Artifact>
    controller: AbortController
    waiters: number
  }
  private readonly states = new Map<string, QueryRuntimeState>()
  private closed = false
  constructor(options: RuntimeOptions, root: string) {
    this.options = options
    this.root = join(root, 'query-index')
  }
  key(snapshot: QuerySnapshot): string {
    return graphHash([
      snapshot.projectId,
      snapshot.snapshotId,
      snapshot.sourceStamp,
      GRAPH_ENGINE,
      GRAPH_ADAPTER,
      snapshot.files.map((f) => [f.filePath, graphHash(f.source)])
    ])
  }
  status(snapshot: QuerySnapshot): QueryRuntimeState {
    const previous = this.states.get(this.key(snapshot))
    return previous
      ? { ...previous, capabilities: [...previous.capabilities] }
      : {
          state: 'disabled',
          index: 'unknown',
          wholeWorkspaceIndexed: false,
          starts: 0,
          pending: 0,
          errorCode: null,
          positionEncoding: 'utf-16',
          capabilities: ['symbols', 'definition', 'references', 'incomingCalls', 'outgoingCalls']
        }
  }
  private directory(key: string): string {
    mkdirSync(this.root, { recursive: true })
    if (lstatSync(this.root).isSymbolicLink())
      throw new ApiError('QUERY_GRAPH_UNSAFE', '索引根目录不可为链接', 409)
    const folder = join(this.root, key)
    if (existsSync(folder) && lstatSync(folder).isSymbolicLink())
      throw new ApiError('QUERY_GRAPH_UNSAFE', '索引目录不可为链接', 409)
    mkdirSync(folder, { recursive: true })
    return folder
  }
  private cached(key: string): Artifact | null {
    const folder = this.directory(key),
      manifest = join(folder, 'ready.json')
    if (!existsSync(manifest)) return null
    try {
      if (lstatSync(manifest).isSymbolicLink() || statSync(manifest).size > 256 * 1024)
        throw Error('manifest')
      const row = JSON.parse(readFileSync(manifest, 'utf8')) as Artifact & {
        name: string
        sha256: string
      }
      if (
        !/^projection-[\w-]+\.sqlite3$/.test(row.name) ||
        row.binding.graphKey !== key ||
        row.binding.engine !== GRAPH_ENGINE ||
        row.binding.adapter !== GRAPH_ADAPTER
      )
        throw Error('identity')
      const file = join(folder, row.name)
      if (
        lstatSync(file).isSymbolicLink() ||
        statSync(file).size > 64 * 1024 * 1024 ||
        hashFile(file) !== row.sha256
      )
        throw Error('digest')
      return { file, binding: row.binding, durationMs: row.durationMs, peakRss: row.peakRss }
    } catch {
      throw new ApiError(
        'QUERY_GRAPH_CORRUPT',
        '已发布图缓存校验失败；保留原任务并明确重建新缓存',
        409
      )
    }
  }
  async artifact(snapshot: QuerySnapshot, signal: AbortSignal): Promise<Artifact> {
    if (signal.aborted || this.closed) throw new ApiError('QUERY_CANCELLED', '图查询已取消', 499)
    const names = new Set<string>()
    let bytes = 0
    if (!Array.isArray(snapshot.files) || !snapshot.files.length || snapshot.files.length > 2000)
      throw new ApiError('QUERY_GRAPH_SCOPE', '图快照文件范围无效', 400)
    for (const file of snapshot.files) {
      if (
        !isSnapshotJavaPath(file.filePath) ||
        typeof file.source !== 'string' ||
        names.has(file.filePath.toLowerCase()) ||
        Buffer.byteLength(file.source) > 2 * 1024 * 1024
      )
        throw new ApiError('QUERY_GRAPH_SCOPE', '图快照路径或文件内容无效', 400)
      names.add(file.filePath.toLowerCase())
      bytes += Buffer.byteLength(file.source)
    }
    if (bytes > 20 * 1024 * 1024)
      throw new ApiError('QUERY_GRAPH_SCOPE', '图快照超出总大小范围', 400)
    const key = this.key(snapshot),
      state = this.states.get(key) ?? this.status(snapshot)
    this.states.set(key, state)
    const cached = this.cached(key)
    if (cached) {
      state.state = 'ready'
      state.index = 'quiescent'
      return cached
    }
    if (this.active && this.active.key !== key)
      throw new ApiError('QUERY_RUNTIME_BUSY', '已有快照正在建图，请稍后重试', 429)
    if (!this.active) {
      const controller = new AbortController()
      const current = {
        key,
        controller,
        waiters: 0,
        task: Promise.resolve(null as unknown as Artifact)
      }
      current.task = this.build(snapshot, key, state, controller.signal).finally(() => {
        if (this.active === current) this.active = undefined
      })
      this.active = current
    }
    const active = this.active
    active.waiters++
    state.pending++
    try {
      return await new Promise<Artifact>((resolve, reject) => {
        const abort = (): void => reject(new ApiError('QUERY_CANCELLED', '查询等待已取消', 499))
        signal.addEventListener('abort', abort, { once: true })
        active.task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
        if (signal.aborted) abort()
      })
    } finally {
      active.waiters--
      state.pending--
      if (!active.waiters && this.active === active) active.controller.abort()
    }
  }
  private async build(
    snapshot: QuerySnapshot,
    key: string,
    state: QueryRuntimeState,
    signal: AbortSignal
  ): Promise<Artifact> {
    const folder = this.directory(key),
      // SQLite's Windows WAL filenames need headroom below MAX_PATH. Keep the full
      // snapshot hash, but shorten this disposable generation directory (64 random bits).
      generation = randomUUID().replaceAll('-', '').slice(0, 16),
      root = join(folder, generation, 'src')
    state.state = 'preparing'
    state.errorCode = null
    mkdirSync(root, { recursive: true })
    for (const file of snapshot.files) {
      const target = resolve(root, file.filePath),
        rel = relative(root, target)
      if (
        isAbsolute(rel) ||
        rel.startsWith('..') ||
        rel.split(sep).includes('.codegraph') ||
        !isSnapshotJavaPath(file.filePath)
      )
        throw new ApiError('QUERY_GRAPH_SCOPE', '非法快照文件', 400)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.source, { flag: 'wx' })
    }
    try {
      const resources = workerResources(),
        output = join(folder, `projection-${generation}.sqlite3`)
      state.starts++
      state.state = 'indexing'
      state.index = 'working'
      const meta = await new Promise<BuildMeta>((resolve, reject) => {
        const child = fork(resources.worker, [], {
          execPath: resources.binary,
          execArgv: ['--liftoff-only', '--max-old-space-size=256'],
          windowsHide: true,
          cwd: root,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          env: graphEnvironment(process.env)
        })
        let complete: BuildMeta | undefined, failure: string | undefined
        const abort = (): void => {
          failure = 'QUERY_CANCELLED'
          child.kill()
        }
        const timer = setTimeout(() => {
          failure = 'QUERY_TIMEOUT'
          child.kill()
        }, this.options.graphTimeoutMs ?? 90000)
        signal.addEventListener('abort', abort, { once: true })
        child.on('message', (message: unknown) => {
          const row = message as {
            type: string
            rss?: number
            meta?: typeof complete
            code?: string
          }
          const rss = row.type === 'complete' ? row.meta?.peakRss : row.rss
          if (Number(rss) > (this.options.graphMemoryMb ?? 512) * 1024 * 1024) {
            failure = 'QUERY_MEMORY_LIMIT'
            child.kill()
          }
          if (row.type === 'complete') complete = row.meta
          if (row.type === 'error') failure = row.code
        })
        child.once('error', () => {
          failure = 'QUERY_GRAPH_RUNTIME_MISSING'
        })
        child.once('close', (code) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          if (!failure && code === 0 && complete && /^[a-f0-9]{64}$/.test(complete.digest))
            resolve(complete)
          else
            reject(
              new ApiError(
                failure ?? 'QUERY_GRAPH_BUILD_FAILED',
                'CodeGraph建图未完成，未发布产物',
                503
              )
            )
        })
        child.send({
          root,
          library: resources.library,
          files: snapshot.files.map((f) => f.filePath),
          output
        })
        if (signal.aborted) abort()
      })
      if (signal.aborted) throw new ApiError('QUERY_CANCELLED', '建图已取消', 499)
      if (statSync(output).size > 64 * 1024 * 1024)
        throw new ApiError('QUERY_GRAPH_LIMIT', '图投影超过大小预算，未发布产物', 503)
      const gaps = [
        'GRAPH_STRUCTURAL_NOT_SEMANTIC',
        ...snapshot.files
          .filter((f) => !meta.indexed.includes(f.filePath))
          .map(() => 'GRAPH_FILE_NOT_INDEXED'),
        ...(meta.errors ? ['GRAPH_PARSE_INCOMPLETE'] : [])
      ]
      const binding: GraphBinding = {
        version: 1,
        backend: 'codegraph',
        engine: GRAPH_ENGINE,
        adapter: GRAPH_ADAPTER,
        graphKey: key,
        graphDigest: meta.digest,
        gaps: [...new Set(gaps)]
      }
      const artifact = {
        binding,
        durationMs: meta.durationMs,
        peakRss: meta.peakRss,
        name: `projection-${generation}.sqlite3`,
        sha256: hashFile(output)
      }
      const temp = join(folder, `ready-${generation}.tmp`)
      writeFileSync(temp, JSON.stringify(artifact), { flag: 'wx' })
      renameSync(temp, join(folder, 'ready.json'))
      state.state = 'ready'
      state.index = 'quiescent'
      return { file: output, ...artifact }
    } catch (e) {
      state.state = signal.aborted ? 'stopped' : 'failed'
      state.errorCode = e instanceof ApiError ? e.code : 'QUERY_GRAPH_BUILD_FAILED'
      throw e
    }
  }
  async read<T>(
    snapshot: QuerySnapshot,
    signal: AbortSignal,
    action: (db: DatabaseSync, binding: GraphBinding) => T
  ): Promise<T> {
    const artifact = await this.artifact(snapshot, signal)
    if (signal.aborted) throw new ApiError('QUERY_CANCELLED', '查询已取消', 499)
    const db = new DatabaseSync(artifact.file, { readOnly: true })
    try {
      return action(db, artifact.binding)
    } finally {
      db.close()
    }
  }
  nodes(db: DatabaseSync, file?: string): GraphNode[] {
    return (
      file
        ? db.prepare('SELECT json FROM nodes WHERE file=?').all(file)
        : db.prepare('SELECT json FROM nodes').all()
    ).map((r) => JSON.parse(String(r.json)))
  }
  edges(db: DatabaseSync, id: string, incoming = false): GraphEdge[] {
    return db
      .prepare(`SELECT json FROM edges WHERE ${incoming ? 'target' : 'source'}=?`)
      .all(id)
      .map((r) => JSON.parse(String(r.json)))
  }
  async close(): Promise<void> {
    this.closed = true
    this.active?.controller.abort()
    await this.active?.task.catch(() => {})
    this.states.clear()
  }
}
