// Public, reproducible MCP experiments. No model, API key or target build is used.
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openStorage } from '../src/service/storage/schema.ts'
import { SourceRepository } from '../src/service/sources/repository.ts'
import { importLocal } from '../src/service/sources/local.ts'
import { CodeQueryService } from '../src/service/query/service.ts'
import { CallChainRepository } from '../src/service/storage/call-chain-repository.ts'
import { CallChainService } from '../src/service/chains/service.ts'
import { AuditMcpBackend } from '../src/service/mcp/backend.ts'
import { AuditMcpGateway, createAuditMcpServer } from '../src/service/mcp/gateway.ts'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createInterface } from 'node:readline'

export async function createLab(base = resolve(import.meta.dirname, '../../.local/mcp-lab')) {
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'lab-')),
    source = join(root, 'source'),
    dataRoot = join(root, 'runtime')
  await mkdir(source)
  const files = {
    'Web.java':
      'package demo;\nclass Web {\n Service service;\n @GetMapping("/search")\n String search(String input) {\n  return service.search(input);\n }\n}\n@interface GetMapping { String value(); }\n',
    'Service.java':
      'package demo;\nclass Service {\n Repo repo;\n String search(String input) {\n  String value = Helper.clean(input);\n  return repo.query(value);\n }\n}\n',
    'Helper.java':
      'package demo;\nclass Helper {\n static String clean(String input) {\n  return input; // This helper does not sanitize SQL.\n }\n}\n',
    'Repo.java':
      'package demo;\nclass Repo {\n java.sql.Statement stmt;\n String query(String input) {\n  stmt.executeQuery("SELECT * FROM users WHERE name=" + input);\n  return input;\n }\n}\n'
  }
  for (const [name, text] of Object.entries(files)) await writeFile(join(source, name), text)
  const db = openStorage(dataRoot),
    sources = new SourceRepository(db),
    query = new CodeQueryService(sources, { dataRoot }),
    repo = new CallChainRepository(db),
    chains = new CallChainService(repo, query)
  try {
    const project = await importLocal(sources, { projectName: 'MCP evidence lab', path: source })
    const run = await chains.action('prepare', { projectId: project.projectId, maxDepth: 5 })
    const paths = repo.list({ projectId: project.projectId, runId: run.runId }).paths
    const path = paths.find((p) => p.sourceRef?.startsWith('http-entry-candidate:')) ?? paths[0]
    if (!path) throw Error('MCP_LAB_NO_PATH')
    const lab = {
      root,
      source,
      dataRoot,
      projectId: project.projectId,
      runId: run.runId,
      pathId: path.pathId,
      labFile: join(root, 'lab.json'),
      paidModelRequests: 0
    }
    await writeFile(lab.labFile, JSON.stringify(lab, null, 2))
    return lab
  } finally {
    await chains.close()
    await query.close()
    db.close()
  }
}
export async function openLab(file) {
  const lab = JSON.parse(await readFile(resolve(file), 'utf8')),
    db = openStorage(lab.dataRoot),
    sources = new SourceRepository(db),
    query = new CodeQueryService(sources, { dataRoot: lab.dataRoot }),
    repo = new CallChainRepository(db)
  try {
    const path = repo.detail(lab),
      backend = new AuditMcpBackend(query, { ...lab, path }),
      controller = new AbortController(),
      gateway = new AuditMcpGateway(backend, controller.signal)
    return {
      lab,
      db,
      query,
      repo,
      backend,
      gateway,
      controller,
      async close() {
        controller.abort()
        await gateway.close()
        await query.close()
        db.close()
      }
    }
  } catch (error) {
    await query.close()
    db.close()
    throw error
  }
}
export async function runDemo(h) {
  let related, stepIndex
  for (const step of h.backend.input.path.steps) {
    const result = await h.gateway.call('audit_find_related', {
      stepIndex: step.stepIndex,
      direction: 'outgoing'
    })
    const helper = result.items.find((r) => r.item.location.filePath === 'Helper.java')
    if (helper) {
      related = { result, helper }
      stepIndex = step.stepIndex
      break
    }
  }
  if (!related) throw Error('MCP_LAB_HELPER_NOT_FOUND')
  const read = await h.gateway.call('audit_read_related', {
    stepIndex,
    targetId: related.helper.targetId
  })
  const staticScan = await h.gateway.call('audit_static_scan', {
    stepIndex: h.backend.input.path.steps.length - 1
  })
  return {
    paidModelRequests: 0,
    query: related.result,
    read,
    staticScan,
    explanation: 'Helper源码是证据；CodeGraph关系和静态命中是候选信息，未自动生成漏洞结论。'
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, file, kind] = process.argv.slice(2)
  if (mode === 'init' && !file) console.log(JSON.stringify(await createLab()))
  else if ((mode === 'demo' || mode === 'serve' || mode === 'interactive') && file) {
    const h = await openLab(file)
    if (mode === 'demo') {
      try {
        console.log(JSON.stringify(await runDemo(h), null, 2))
      } finally {
        await h.close()
      }
    } else if (mode === 'interactive') {
      const lines = createInterface({ input: process.stdin })
      console.log(
        'MCP实验：输入 outgoing / incoming / definition [步骤]、read <targetId> [步骤]、scan [步骤]、bad 或 quit。JSON请在此程序内输入。'
      )
      try {
        for await (const line of lines) {
          const [op, value, index] = line.trim().split(/\s+/)
          if (op === 'quit') break
          if (!op) continue
          try {
            const request = op.startsWith('{')
              ? JSON.parse(line)
              : ['outgoing', 'incoming', 'definition'].includes(op)
                ? {
                    name: 'audit_find_related',
                    arguments: { stepIndex: Number(value ?? 0), direction: op }
                  }
                : op === 'read'
                  ? {
                      name: 'audit_read_related',
                      arguments: { stepIndex: Number(index ?? 0), targetId: value }
                    }
                  : op === 'scan'
                    ? {
                        name: 'audit_static_scan',
                        arguments: {
                          stepIndex: Number(value ?? h.backend.input.path.steps.length - 1)
                        }
                      }
                    : op === 'bad'
                      ? {
                          name: 'audit_read_related',
                          arguments: {
                            stepIndex: 0,
                            targetId: 'rel-' + '0'.repeat(32),
                            filePath: '../outside.java'
                          }
                        }
                      : null
            if (!request) throw Error('UNKNOWN_LAB_OPERATION')
            console.log(
              JSON.stringify(await h.gateway.call(request.name, request.arguments), null, 2)
            )
          } catch (error) {
            console.log(
              JSON.stringify({ error: error.code ?? 'MCP_LAB_ERROR', message: error.message })
            )
          }
        }
      } finally {
        lines.close()
        await h.close()
      }
    } else {
      if (!['codegraph', 'static'].includes(kind)) throw Error('serve needs codegraph or static')
      const server = createAuditMcpServer(h.backend, kind, h.controller.signal)
      await server.connect(new StdioServerTransport())
      process.stdin.once('end', () => {
        void server.close().finally(() => h.close())
      })
    }
  } else {
    console.error(
      'Usage: node scripts/mcp-lab.mjs init | demo <lab.json> | interactive <lab.json> | serve <lab.json> codegraph|static'
    )
    process.exitCode = 2
  }
}
