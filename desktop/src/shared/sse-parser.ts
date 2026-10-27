import { streamEvents, terminalEvents, streamEventSpec } from './sse-contracts.ts'
import type { StreamFrame } from './sse-contracts'
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
export class AnalyzeSseParser {
  private decoder = new TextDecoder('utf-8', { fatal: true })
  private buffer = ''
  private cr = ''
  private sessionId: string | undefined
  private lastId: number
  private state: string | undefined
  terminal = false
  constructor(sessionId?: string, afterId = 0) {
    this.sessionId = sessionId
    this.lastId = afterId
  }
  push(bytes: Uint8Array): StreamFrame[] {
    return this.parse(this.decoder.decode(bytes, { stream: true }))
  }
  finish(): void {
    this.parse(this.decoder.decode() + (this.cr ? '\n' : ''))
    this.cr = ''
    if (this.buffer.trim()) throw Error('SSE_INCOMPLETE_FRAME')
  }
  private parse(text: string): StreamFrame[] {
    text = this.cr + text
    this.cr = ''
    if (text.endsWith('\r')) {
      text = text.slice(0, -1)
      this.cr = '\r'
    }
    this.buffer += text.replace(/\r\n|\r/g, '\n')
    const result: StreamFrame[] = []
    let index: number
    while ((index = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 2)
      if (block.length > 65536) throw Error('SSE_FRAME_LIMIT')
      const lines = block.split('\n').filter((l) => l && !l.startsWith(':'))
      if (!lines.length) continue
      const fields: Record<string, string> = {}
      for (const line of lines) {
        const colon = line.indexOf(':')
        if (colon < 0) throw Error('SSE_INVALID_FRAME')
        const key = line.slice(0, colon),
          value = line.slice(colon + 1).replace(/^ /, '')
        if (!['event', 'id', 'data'].includes(key) || key in fields)
          throw Error('SSE_INVALID_FRAME')
        fields[key] = value
      }
      if (
        !streamEvents.includes(fields.event as StreamFrame['event']) ||
        !/^\d+$/.test(fields.id ?? '')
      )
        throw Error('SSE_INVALID_FRAME')
      const id = Number(fields.id),
        data: unknown = JSON.parse(fields.data)
      if (
        !Number.isSafeInteger(id) ||
        id < 1 ||
        !object(data) ||
        Object.keys(data).sort().join(',') !==
          [
            'projectId',
            'runId',
            'chainId',
            'sessionId',
            'attemptId',
            'type',
            'status',
            'message',
            'summaryMissing',
            'details'
          ]
            .sort()
            .join(',') ||
        !['projectId', 'runId', 'chainId', 'sessionId'].every(
          (k) => typeof data[k] === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(data[k] as string)
        ) ||
        !Number.isInteger(data.attemptId) ||
        Number(data.attemptId) < 1 ||
        !(data.message === null || typeof data.message === 'string') ||
        typeof data.summaryMissing !== 'boolean' ||
        data.summaryMissing !== !data.message
      )
        throw Error('SSE_INVALID_DATA')
      const spec = streamEventSpec[fields.event as StreamFrame['event']]
      if (data.status !== spec.status || data.type !== spec.type) throw Error('SSE_STATE_MISMATCH')
      this.sessionId ??= data.sessionId as string
      if (data.sessionId !== this.sessionId) throw Error('SSE_SESSION_MISMATCH')
      if (id <= this.lastId) continue
      if (id !== this.lastId + 1) throw Error('SSE_CURSOR_GAP')
      if (this.terminal) throw Error('SSE_AFTER_TERMINAL')
      if (
        (id === 1 && fields.event !== 'queued') ||
        (this.state && !spec.from.includes(this.state))
      )
        throw Error('SSE_STATE_MISMATCH')
      this.state = String(data.status)
      this.lastId = id
      this.terminal = terminalEvents.has(fields.event as StreamFrame['event'])
      result.push({
        event: fields.event as StreamFrame['event'],
        id,
        data: data as unknown as StreamFrame['data']
      })
    }
    if (this.buffer.length > 65536) throw Error('SSE_FRAME_LIMIT')
    return result
  }
}
