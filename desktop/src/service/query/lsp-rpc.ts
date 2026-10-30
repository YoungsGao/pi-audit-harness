import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { ApiError } from '../../shared/api-error.ts'

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  cleanup: () => void
}
export class LspRpc {
  private readonly child: ChildProcessWithoutNullStreams
  private buffer = Buffer.alloc(0)
  private sequence = 0
  private readonly pending = new Map<number, Pending>()
  private ended = false
  private readonly closed: Promise<void>
  get pendingCount(): number {
    return this.pending.size
  }
  onNotification?: (method: string, params: unknown) => void
  onServerRequest?: (method: string, params: unknown) => unknown
  onExit?: () => void
  constructor(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(executable, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    // stderr 只排空，不把 JVM、路径或源码原文送入通用日志。
    this.child.stderr.on('data', () => {})
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.consume(chunk)
      } catch {
        this.fail('QUERY_PROTOCOL_ERROR')
        this.child.kill()
      }
    })
    this.child.stdin.on('error', () => this.fail('QUERY_RUNTIME_EXITED'))
    this.child.once('error', () => this.fail('QUERY_RUNTIME_MISSING'))
    this.closed = new Promise((resolve) =>
      this.child.once('close', () => {
        this.fail('QUERY_RUNTIME_EXITED')
        this.onExit?.()
        resolve()
      })
    )
  }
  private fail(code: string): void {
    this.ended = true
    for (const item of this.pending.values()) {
      item.cleanup()
      item.reject(new ApiError(code, '语言服务器不可用', 503))
    }
    this.pending.clear()
  }
  private send(value: unknown): void {
    if (this.ended) throw new ApiError('QUERY_RUNTIME_EXITED', '语言服务器已退出', 503)
    const bytes = Buffer.from(JSON.stringify(value))
    this.child.stdin.write(
      Buffer.concat([Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`), bytes])
    )
  }
  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }
  request(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (signal?.aborted)
      return Promise.reject(new ApiError('QUERY_CANCELLED', '语义查询已取消', 499))
    if (this.pending.size >= 32)
      return Promise.reject(new ApiError('QUERY_BUSY', '语义查询达到并发上限', 429))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const stop = (code: string): void => {
        if (!this.pending.delete(id)) return
        cleanup()
        try {
          this.notify('$/cancelRequest', { id })
        } catch {
          /* 已退出 */
        }
        reject(
          new ApiError(
            code,
            code === 'QUERY_TIMEOUT' ? '语义查询超时' : '语义查询已取消',
            code === 'QUERY_TIMEOUT' ? 504 : 499
          )
        )
      }
      const abort = (): void => stop('QUERY_CANCELLED')
      const timer = setTimeout(() => stop('QUERY_TIMEOUT'), timeoutMs)
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      this.pending.set(id, { resolve, reject, cleanup })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.pending.delete(id)
        cleanup()
        reject(error)
      }
    })
  }
  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length) {
      const boundary = this.buffer.indexOf('\r\n\r\n')
      if (boundary < 0) {
        if (this.buffer.length > 8192) throw Error('header')
        return
      }
      if (boundary > 8192) throw Error('header')
      const header = this.buffer.subarray(0, boundary).toString('ascii')
      const sizes = [...header.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)]
      if (sizes.length !== 1) throw Error('length')
      const length = Number(sizes[0][1])
      if (length < 2 || length > 8 * 1024 * 1024) throw Error('limit')
      if (this.buffer.length < boundary + 4 + length) return
      const message = JSON.parse(
        this.buffer.subarray(boundary + 4, boundary + 4 + length).toString('utf8')
      )
      this.buffer = this.buffer.subarray(boundary + 4 + length)
      if (!message || message.jsonrpc !== '2.0') throw Error('jsonrpc')
      if (typeof message.method === 'string') {
        if ('id' in message) {
          const result = this.onServerRequest?.(message.method, message.params)
          this.send(
            result === undefined
              ? {
                  jsonrpc: '2.0',
                  id: message.id,
                  error: { code: -32601, message: 'Unsupported client method' }
                }
              : { jsonrpc: '2.0', id: message.id, result }
          )
        } else this.onNotification?.(message.method, message.params)
      } else if (typeof message.id === 'number') {
        const item = this.pending.get(message.id)
        if (!item) continue // 取消/超时后的迟到响应不能污染下一次请求。
        this.pending.delete(message.id)
        item.cleanup()
        if (message.error)
          item.reject(
            new ApiError(
              message.error.code === -32601 ? 'QUERY_UNSUPPORTED' : 'QUERY_BACKEND_ERROR',
              '语言服务器请求失败',
              502
            )
          )
        else item.resolve(message.result)
      }
    }
  }
  async close(): Promise<void> {
    if (!this.ended) {
      try {
        await this.request('shutdown', null, 1500)
        this.notify('exit', null)
      } catch {
        /* 有界强制退出 */
      }
    }
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 1500)
    try {
      await this.closed
    } finally {
      clearTimeout(timer)
    }
  }
}
