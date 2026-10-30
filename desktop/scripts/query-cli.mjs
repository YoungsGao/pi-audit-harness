#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

export async function queryOnce(input, options = {}) {
  const port = String(options.port ?? process.env.PI_AUDIT_QUERY_PORT ?? '')
  const token = options.token ?? process.env.PI_AUDIT_QUERY_TOKEN
  if (
    !/^\d{1,5}$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535 ||
    typeof token !== 'string' ||
    token.length < 32 ||
    /[\r\n]/.test(token)
  )
    throw Error('QUERY_CLI_CONNECTION')
  const body = JSON.stringify(input)
  if (Buffer.byteLength(body) > 16384) throw Error('QUERY_CLI_INPUT_LIMIT')
  const response = await fetch(`http://127.0.0.1:${port}/code/query`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body,
    signal: options.signal ?? AbortSignal.timeout(120000),
    redirect: 'error'
  })
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > 256 * 1024) {
      await reader.cancel()
      throw Error('QUERY_CLI_OUTPUT_LIMIT')
    }
    chunks.push(Buffer.from(value))
  }
  const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!response.ok || envelope.ok !== true || envelope.data?.contractVersion !== 1)
    throw Error(envelope.error?.code ?? 'QUERY_CLI_RESPONSE')
  return envelope.data
}
export async function cliMain() {
  try {
    if (process.argv.length > 2) throw Error('QUERY_CLI_STDIN_ONLY')
    const chunks = []
    let size = 0
    for await (const chunk of process.stdin) {
      size += chunk.length
      if (size > 16384) throw Error('QUERY_CLI_INPUT_LIMIT')
      chunks.push(chunk)
    }
    const result = await queryOnce(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    process.stdout.write(JSON.stringify(result) + '\n')
    process.exitCode =
      {
        ok: 0,
        'no-match': 0,
        partial: 2,
        unsupported: 3,
        'not-ready': 4,
        timeout: 5,
        cancelled: 130,
        failed: 1
      }[result.status] ?? 1
  } catch (error) {
    const code =
      typeof error?.message === 'string' && /^[A-Z][A-Z_]{1,80}$/.test(error.message)
        ? error.message
        : 'QUERY_CLI_FAILED'
    process.stdout.write(JSON.stringify({ errorCode: code }) + '\n')
    process.exitCode = 1
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await cliMain()
