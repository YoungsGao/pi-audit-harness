import { createServer } from 'node:http'
// A protocol test double, always unknown. Never a model-quality or vulnerability oracle.
export async function engineeringModel(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const c of request) chunks.push(c)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const first = body.messages.find((m: { role: string }) => m.role === 'user')
      const text = (m: { content: string | { text?: string }[] }): string =>
        typeof m.content === 'string' ? m.content : m.content.map((c) => c.text ?? '').join('')
      const firstText = text(first)
      const context = JSON.parse(firstText.slice(firstText.indexOf('\n') + 1))
      const results = body.messages
        .filter((m: { role: string }) => m.role === 'tool')
        .map((m: { content: string }) => JSON.parse(text(m)))
      const names = new Set(body.tools.map((t: { function: { name: string } }) => t.function.name))
      let call: { name: string; args: Record<string, unknown> } | undefined
      const step = context.steps.find(
        (s: { stepIndex: number }) =>
          !results.some(
            (r: { stepIndex: number; tool?: string }) => r.stepIndex === s.stepIndex && !r.tool
          )
      )
      if (step) call = { name: 'audit_read_step', args: { stepIndex: step.stepIndex } }
      else if (
        names.has('audit_find_related') &&
        !results.some((r: { tool: string }) => r.tool === 'audit_find_related')
      )
        call = { name: 'audit_find_related', args: { stepIndex: 0, direction: 'outgoing' } }
      else {
        const found = results.find((r: { tool: string }) => r.tool === 'audit_find_related')
        if (
          found?.items.length &&
          !results.some((r: { tool: string }) => r.tool === 'audit_read_related')
        )
          call = {
            name: 'audit_read_related',
            args: { stepIndex: 0, targetId: found.items[0].targetId }
          }
        else if (
          names.has('audit_static_scan') &&
          !results.some((r: { tool: string }) => r.tool === 'audit_static_scan')
        )
          call = { name: 'audit_static_scan', args: { stepIndex: context.steps.length - 1 } }
      }
      const result = call
        ? null
        : {
            action: 'finish',
            summary: '本地协议替身完成工程流程；不作模型质量判断。',
            result: {
              verdict: 'unknown',
              summary: '工程替身始终保留未知。',
              steps: context.steps.map((s: { stepIndex: number }) => {
                const read = results.find(
                  (r: { stepIndex: number; tool?: string }) =>
                    r.stepIndex === s.stepIndex && !r.tool
                )
                return {
                  stepIndex: s.stepIndex,
                  dangerous: null,
                  reason: '未运行真实模型',
                  quotes: [
                    read.citations[0].id,
                    ...results
                      .filter(
                        (r: { tool?: string; stepIndex: number }) =>
                          r.tool === 'audit_read_related' && r.stepIndex === s.stepIndex
                      )
                      .flatMap((r: { citations: { id: string }[] }) =>
                        r.citations.slice(0, 1).map((c) => c.id)
                      )
                  ],
                  taintIn: [],
                  taintOut: [],
                  checks: Object.fromEntries(
                    [
                      'source',
                      'argumentMapping',
                      'assignment',
                      'returnValue',
                      'field',
                      'defense'
                    ].map((key) => [
                      key,
                      { status: 'unknown', reason: '工程替身不提供语义证明', quotes: [] }
                    ])
                  )
                }
              })
            }
          }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const frame = (delta: unknown, finish_reason: string | null): string =>
        'data: ' +
        JSON.stringify({
          id: 'evaluation-fixture',
          object: 'chat.completion.chunk',
          created: 0,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason }]
        }) +
        '\n\n'
      response.write(
        frame(
          call
            ? {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-' + results.length,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.args) }
                  }
                ]
              }
            : { role: 'assistant', content: JSON.stringify(result) },
          null
        )
      )
      response.end(frame({}, call ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n')
    } catch {
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Invalid engineering fixture request' } }))
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      })
  }
}
