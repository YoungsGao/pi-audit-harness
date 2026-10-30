import { createServer } from 'node:http'
// Offline fixture speaks actual streaming Chat Completions to the real Pi SDK.
export async function createAgentModelFixture({
  mode = 'finish',
  delayMs = 0,
  supportPing = false,
  beforeReply
} = {}) {
  const requests = []
  const server = createServer(async (request, response) => {
    const parts = []
    for await (const part of request) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'))
    requests.push(body)
    await beforeReply?.(body)
    if (mode === 'unavailable') {
      response.writeHead(503, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'local fixture temporarily unavailable' } }))
      return
    }
    const textOf = (message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content.map((c) => c.text ?? '').join('')
    const users = body.messages.filter((m) => m.role === 'user')
    const first = textOf(users[0])
    if (supportPing && first.trim() === 'ping') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const chunk = (content, finish_reason) => ({
        id: 'configured-ping-fixture',
        object: 'chat.completion.chunk',
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta: content, finish_reason }]
      })
      response.write(
        'data: ' +
          JSON.stringify(
            chunk({ role: 'assistant', content: 'pong from configured local fixture' }, null)
          ) +
          '\n\n'
      )
      response.end('data: ' + JSON.stringify(chunk({}, 'stop')) + '\n\ndata: [DONE]\n\n')
      return
    }
    const context = JSON.parse(first.slice(first.indexOf('\n') + 1))
    const tools = body.messages
      .filter((m) => m.role === 'tool')
      .map((m) => {
        try {
          return JSON.parse(textOf(m))
        } catch {
          return null
        }
      })
      .filter(Boolean)
    const indexes = new Set(tools.map((e) => e.stepIndex))
    const stepIndex = context.steps.find((s) => !indexes.has(s.stepIndex))?.stepIndex
    await new Promise((r) => setTimeout(r, delayMs))
    if (response.destroyed) return
    if (mode === 'hold') return
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunk = (delta, finish_reason) => ({
      id: 'agent-fixture',
      object: 'chat.completion.chunk',
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason }]
    })
    const send = (delta, finish_reason) =>
      response.write('data: ' + JSON.stringify(chunk(delta, finish_reason)) + '\n\n')
    if (stepIndex !== undefined || mode === 'scope' || mode === 'tools') {
      const args =
        mode === 'scope'
          ? { stepIndex: 999, path: '../outside.java' }
          : { stepIndex: mode === 'tools' ? 0 : stepIndex }
      const batch =
        mode === 'batch'
          ? context.steps
              .filter((s) => !indexes.has(s.stepIndex))
              .map((s) => ({ stepIndex: s.stepIndex }))
          : [args]
      send(
        {
          role: 'assistant',
          tool_calls: batch.map((arguments_, index) => ({
            index,
            id: 'read-' + requests.length + '-' + index,
            type: 'function',
            function: { name: 'audit_read_step', arguments: JSON.stringify(arguments_) }
          }))
        },
        null
      )
      send({}, 'tool_calls')
    } else {
      const continuing = mode === 'rounds' || (mode === 'continue' && users.length === 1)
      const result = {
        verdict: 'unknown',
        summary:
          '本机受控模型：已读取路径原文，仍需完整污点证据。<script>fixture-only</script>' +
          (mode === 'ui03' ? ' api_key="fixture-ui03-private"' : ''),
        steps: context.steps.map((s) => {
          const e = tools.find((e) => e.stepIndex === s.stepIndex)
          return {
            stepIndex: s.stepIndex,
            dangerous: null,
            reason: '调用候选不是漏洞证明',
            taintIn: [],
            taintOut: [],
            checks: Object.fromEntries(
              ['source', 'argumentMapping', 'assignment', 'returnValue', 'field', 'defense'].map(
                (k) => [
                  k,
                  { status: 'unknown', reason: '本机替身保留未知，等待语义核对', quotes: [] }
                ]
              )
            ),
            quotes: [
              mode === 'badQuote'
                ? 'invented-evidence'
                : (e.ranges?.[0]?.text ?? e.text).slice(0, 800)
            ]
          }
        })
      }
      if (['dangerous', 'safe', 'invalid', 'contradiction', 'missing-check'].includes(mode)) {
        result.verdict =
          mode === 'contradiction' ? 'safe' : mode === 'missing-check' ? 'unknown' : mode
        result.summary = '本机受控传播核查：' + mode
        for (const step of result.steps) {
          const quotes = step.quotes
          if (mode === 'missing-check') {
            delete step.checks
            continue
          }
          if (mode === 'invalid') continue
          step.dangerous =
            mode === 'safe' ? (step.stepIndex === result.steps.length - 1 ? 0 : null) : 1
          step.taintIn = [
            {
              name: 'q',
              origin: '当前路径输入',
              quotes,
              ...(step.stepIndex > 0 ? { fromStep: step.stepIndex - 1 } : {})
            }
          ]
          step.taintOut = [{ name: 'q', origin: '当前调用输出', quotes }]
          for (const [key, check] of Object.entries(step.checks)) {
            check.status = ['source', 'argumentMapping'].includes(key)
              ? 'supported'
              : 'not_applicable'
            check.reason = '本机夹具逐项核对 ' + key
            check.quotes = check.status === 'supported' ? quotes : []
          }
          if (mode === 'safe' && step.stepIndex === result.steps.length - 1)
            step.checks.defense = { status: 'blocked', reason: '本机夹具阻断证据', quotes }
        }
      }
      const decision = continuing
        ? { action: 'continue', summary: null, next: '核对已有引用是否充分' }
        : { action: 'finish', summary: '完成当前轮检查', result }
      send({ role: 'assistant', content: JSON.stringify(decision) }, null)
      send({}, 'stop')
    }
    response.end('data: [DONE]\n\n')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    setMode(next) {
      mode = next
    },
    async close() {
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    }
  }
}
