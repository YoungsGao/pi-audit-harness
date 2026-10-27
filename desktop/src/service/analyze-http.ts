import type { IncomingMessage, ServerResponse } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import type { AnalyzeRequest, StreamFrame } from '../shared/sse-contracts'
import { ApiError } from '../shared/api-error.ts'
export interface AnalyzeStreamApi {
  open(value: unknown): AnalyzeRequest
  read(input: AnalyzeRequest): { frames: StreamFrame[]; terminal: boolean; lastEventId?: number }
}
async function write(response: ServerResponse, text: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted || response.destroyed) return
  if (response.write(text)) return
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer)
      response.off('drain', done)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const done = (): void => finish()
    const timer = setTimeout(() => {
      finish()
      response.destroy()
      reject(new ApiError('SSE_SLOW_CONSUMER', '事件读取过慢，请按游标重新连接', 408))
    }, 5000)
    response.once('drain', done)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })
}
export async function serveAnalyze(
  request: IncomingMessage,
  response: ServerResponse,
  api: AnalyzeStreamApi,
  signal: AbortSignal,
  heartbeatMs = 5000
): Promise<void> {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json'))
    throw new ApiError('INVALID_ANALYZE', '分析请求必须为 JSON', 415)
  const chunks: Buffer[] = []
  let size = 0
  for await (const part of request) {
    size += part.length
    if (size > 8192) throw new ApiError('INVALID_ANALYZE', '分析请求超过8KiB', 413)
    chunks.push(part)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ApiError('INVALID_ANALYZE', '分析请求 JSON 无效', 400)
  }
  let input = api.open(value)
  // A reconnect only reads the persisted session. It never starts or resumes an agent.
  const initial = api.read(input)
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    'X-Session-Id': input.sessionId!,
    'X-Stream-Terminal': String(initial.terminal),
    'X-Stream-Last-Event-Id': String(initial.lastEventId ?? 0)
  })
  response.flushHeaders()
  let heartbeat = Date.now()
  while (!signal.aborted && !response.destroyed) {
    const page = api.read(input)
    for (const frame of page.frames) {
      await write(
        response,
        `event: ${frame.event}\nid: ${frame.id}\ndata: ${JSON.stringify(frame.data)}\n\n`,
        signal
      )
      input = { ...input, afterId: frame.id }
    }
    if (page.terminal && page.frames.length < 50) break
    if (Date.now() - heartbeat >= heartbeatMs) {
      await write(response, ': ping\n\n', signal)
      heartbeat = Date.now()
    }
    try {
      await delay(100, undefined, { signal })
    } catch {
      break
    }
  }
  if (!response.destroyed) response.end()
}
