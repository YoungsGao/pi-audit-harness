// Deterministic stdio peer for fragmentation, server requests, cancellation and exit tests.
let buffer = Buffer.alloc(0)
function send(value) {
  const body = Buffer.from(JSON.stringify(value)),
    header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`)
  const packet = Buffer.concat([header, body])
  process.stdout.write(packet.subarray(0, 11))
  setTimeout(() => process.stdout.write(packet.subarray(11)), 2)
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0) return
    const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString())[1])
    if (buffer.length < end + 4 + length) return
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length))
    buffer = buffer.subarray(end + 4 + length)
    if (message.method === 'shutdown') send({ jsonrpc: '2.0', id: message.id, result: null })
    else if (message.method === 'exit') process.exit(0)
    else if (message.method === 'crash') process.exit(2)
    else if (message.method === 'malformed')
      process.stdout.write('Content-Length: 90000000\r\n\r\n')
    else if (message.method === 'unsupported')
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no' } })
    else if (message.method === 'slow')
      setTimeout(() => send({ jsonrpc: '2.0', id: message.id, result: 'late' }), 120)
    else if (message.method === 'client-request') {
      send({ jsonrpc: '2.0', id: 'server-1', method: 'workspace/applyEdit', params: { edit: {} } })
      setTimeout(() => send({ jsonrpc: '2.0', id: message.id, result: '问😀' }), 15)
    } else if (message.method === 'echo')
      send({ jsonrpc: '2.0', id: message.id, result: message.params })
  }
})
