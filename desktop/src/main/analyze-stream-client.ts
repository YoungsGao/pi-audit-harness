import type { AnalyzeRequest, StreamFrame } from '../shared/sse-contracts'
import { validateAnalyze } from '../shared/sse-contracts.ts'
import { AnalyzeSseParser } from '../shared/sse-parser.ts'
import { ApiError } from '../shared/api-error.ts'
export async function connectAnalyze(
  port: number,
  token: string,
  input: AnalyzeRequest,
  onFrame: (frame: StreamFrame) => void,
  signal: AbortSignal
): Promise<{ sessionId: string; done: Promise<void> }> {
  validateAnalyze(input)
  const response = await fetch(`http://127.0.0.1:${port}/analyze`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    redirect: 'error',
    signal
  })
  if (!response.ok) {
    const body = (await response.json()) as { error?: { code?: string; message?: string } }
    throw new ApiError(
      body.error?.code ?? 'SSE_HTTP_ERROR',
      body.error?.message ?? '无法连接分析事件流',
      response.status
    )
  }
  const sessionId = response.headers.get('x-session-id') ?? ''
  if (
    !response.headers.get('content-type')?.startsWith('text/event-stream') ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(sessionId) ||
    (input.sessionId && sessionId !== input.sessionId) ||
    !response.body
  )
    throw new ApiError('SSE_INVALID_RESPONSE', '事件流响应无效', 502)
  const body = response.body
  const done = (async () => {
    const parser = new AnalyzeSseParser(sessionId, input.afterId ?? 0),
      reader = body.getReader()
    let terminal = false,
      received = 0
    try {
      while (!signal.aborted) {
        const part = await reader.read()
        if (part.done) break
        let frames: StreamFrame[]
        try {
          frames = parser.push(part.value)
        } catch (error) {
          throw new ApiError(
            error instanceof Error && /^SSE_[A-Z_]+$/.test(error.message)
              ? error.message
              : 'SSE_PARSE_FAILED',
            '事件解析失败',
            502
          )
        }
        for (const frame of frames) {
          if (signal.aborted) break
          if (
            frame.data.projectId !== input.projectId ||
            frame.data.runId !== input.runId ||
            frame.data.chainId !== input.chainId
          )
            throw Error('SSE_SCOPE_MISMATCH')
          onFrame(frame)
          received++
          terminal = parser.terminal
        }
      }
      parser.finish()
      // Reattaching after the last event legitimately yields an empty completed stream.
      const confirmedEmptyReplay =
        received === 0 &&
        !!input.sessionId &&
        (input.afterId ?? 0) > 0 &&
        response.headers.get('x-stream-terminal') === 'true' &&
        response.headers.get('x-stream-last-event-id') === String(input.afterId)
      if (!terminal && !confirmedEmptyReplay && !signal.aborted) throw Error('SSE_DISCONNECTED')
    } catch (error) {
      if (error instanceof ApiError) throw error
      const code =
        error instanceof Error && /^SSE_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'SSE_DISCONNECTED'
      throw new ApiError(code, '事件流中断或解析失败，请读取数据库状态并按原游标重连', 502)
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  })()
  // Attach immediately, while caller installs its own completion/error handler.
  void done.catch(() => {})
  return { sessionId, done }
}
