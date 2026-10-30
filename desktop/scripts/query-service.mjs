// Standalone local supervisor for CLI users; one long-lived service owns all LSP sessions.
import { isAbsolute, join } from 'node:path'
import { stat } from 'node:fs/promises'
import { openStorage } from '../src/service/storage/schema.ts'
import { SourceRepository } from '../src/service/sources/repository.ts'
import { CodeQueryService } from '../src/service/query/service.ts'
import { startHttpServer } from '../src/service/http-server.ts'
let db, query, server, stopping
async function shutdown() {
  stopping ??= (async () => {
    await server?.close()
    await query?.close()
    db?.close()
  })()
  await stopping
}
try {
  const root = process.env.PI_AUDIT_DATA_ROOT,
    token = process.env.PI_AUDIT_QUERY_TOKEN
  if (
    process.argv.length > 2 ||
    !root ||
    !isAbsolute(root) ||
    !token ||
    token.length < 32 ||
    /[\r\n]/.test(token)
  )
    throw Error('QUERY_CLI_CONNECTION')
  // CLI supervisor only opens an existing audit database; project/run creation remains the app workflow.
  if (!(await stat(join(root, 'storage', 'audit.sqlite3'))).isFile())
    throw Error('QUERY_CLI_DATABASE_MISSING')
  db = openStorage(root)
  query = new CodeQueryService(new SourceRepository(db), { dataRoot: root })
  server = await startHttpServer(token, {
    codeQuery: (action, input, signal) => {
      if (action !== 'query') throw Error('QUERY_CLI_FIXED_ROUTE')
      return query.action(action, input, signal)
    }
  })
  for (const name of ['SIGINT', 'SIGTERM'])
    process.once(name, () => {
      void shutdown().then(() => process.exit(0))
    })
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (text) => {
    if (text.trim() === 'shutdown') void shutdown().then(() => process.exit(0))
  })
  process.stdout.write(JSON.stringify({ state: 'ready', port: server.port }) + '\n')
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      errorCode: /^[A-Z_]+$/.test(error?.code ?? error?.message ?? '')
        ? (error.code ?? error.message)
        : 'QUERY_CLI_START_FAILED'
    }) + '\n'
  )
  await shutdown()
  process.exitCode = 1
}
