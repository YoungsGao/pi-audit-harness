import { createServer } from 'node:http'
// 仅供测试：从实际发送的 evidence 原文生成 unknown 结论，不连接供应商。
export async function createScanModelFixture() {
  const requests = []
  const server = createServer(async (request, response) => {
    const parts = []
    for await (const part of request) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'))
    requests.push(body)
    const message = body.messages.filter((m) => m.role === 'user').at(-1)
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content.map((c) => c.text ?? '').join('')
    const input = JSON.parse(text.slice(text.indexOf('\n') + 1))
    const result = {
      verdict: 'unknown',
      summary: '本机受控模型：已读取路径原文，仍需完整污点证据。<script>fixture-only</script>',
      steps: input.evidence.map((e, stepIndex) => ({
        stepIndex,
        dangerous: null,
        reason: '不能把调用候选当成已确认漏洞。',
        quotes: [
          e.text
            .split('\n')
            .filter((line) => line.trim())
            .at(-1)
        ]
      }))
    }
    await new Promise((r) => setTimeout(r, 600))
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunk = (delta, finish_reason) => ({
      id: 'scan-fixture',
      object: 'chat.completion.chunk',
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason }]
    })
    response.write(
      'data: ' +
        JSON.stringify(chunk({ role: 'assistant', content: JSON.stringify(result) }, null)) +
        '\n\n'
    )
    response.write('data: ' + JSON.stringify(chunk({}, 'stop')) + '\n\n')
    response.end('data: [DONE]\n\n')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    async close() {
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    }
  }
}
