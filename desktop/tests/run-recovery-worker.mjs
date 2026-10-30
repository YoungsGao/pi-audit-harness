// Deliberately terminates without cleanup at a requested durability boundary.
import { join } from 'node:path'
import { openStorage } from '../src/service/storage/schema.ts'
import { SourceRepository } from '../src/service/sources/repository.ts'
import { CallChainRepository } from '../src/service/storage/call-chain-repository.ts'
import { ScanRepository } from '../src/service/storage/scan-repository.ts'
import { CodeQueryService } from '../src/service/query/service.ts'
import { CallChainService } from '../src/service/chains/service.ts'
import { PathAnalysisService } from '../src/service/chains/path-analysis.ts'
import { runAgentLoop } from '../src/service/chains/agent-loop.ts'
import { RecoveryExecution } from '../src/service/chains/recovery.ts'
import { PiRuntime } from '../src/service/pi-runtime.ts'
process.once('message', async ({ root, scope, pathId, action, killAt, maxPaths = 10 }) => {
  const db = openStorage(join(root, 'runtime')),
    repo = new CallChainRepository(db)
  repo.scans.recover()
  const query = new CodeQueryService(new SourceRepository(db)),
    chains = new CallChainService(repo, query),
    runtime = new PiRuntime(join(root, 'worker-pi'))
  const ports = {
    getConfig: async (id) => {
      const r = db.get('SELECT * FROM model_configs WHERE id=?', id)
      return r
        ? {
            id: String(r.id),
            revision: Number(r.revision),
            name: String(r.name),
            baseUrl: String(r.base_url),
            modelId: String(r.model_id),
            api: r.api,
            secretRef: String(r.secret_ref)
          }
        : undefined
    },
    readSecret: async () => 'local-fixture-key'
  }
  chains.analysis = new PathAnalysisService(
    repo,
    query,
    (input, signal) => runAgentLoop(runtime, ports, input, signal),
    true
  )
  const crash = () => process.kill(process.pid, 'SIGKILL')
  if (killAt === 'checkpoint' || killAt === 'finish-checkpoint') {
    const original = RecoveryExecution.prototype.save
    RecoveryExecution.prototype.save = function (...args) {
      original.apply(this, args)
      if (args[1].action === (killAt === 'finish-checkpoint' ? 'finish' : 'continue')) crash()
    }
  }
  if (killAt === 'tool-receipt') {
    const original = RecoveryExecution.prototype.read
    RecoveryExecution.prototype.read = async function (...args) {
      const value = await original.apply(this, args)
      crash()
      return value
    }
  }
  if (killAt === 'published-file') {
    const original = db.run.bind(db)
    db.run = (sql, ...args) => {
      if (sql.startsWith('INSERT INTO recovery_checkpoints')) crash()
      return original(sql, ...args)
    }
  }
  if (killAt === 'result-commit') {
    const original = ScanRepository.prototype.complete
    ScanRepository.prototype.complete = function (...args) {
      original.apply(this, args)
      crash()
    }
  }
  if (killAt === 'claim') {
    const original = ScanRepository.prototype.claim
    ScanRepository.prototype.claim = function (...args) {
      const result = original.apply(this, args)
      crash()
      return result
    }
  }
  try {
    if (action === 'resume') {
      const plan = await chains.action('recovery', scope)
      process.send?.({ type: 'plan', pid: process.pid, plan })
      await chains.action('resume', {
        ...scope,
        expectedRecoveryKey: plan.recoveryKey,
        maxPaths
      })
    } else await chains.action('analyze', { ...scope, pathId, modelConfigId: 'model' })
    process.send?.({ type: 'started', pid: process.pid })
    await chains.analysis.waitForIdle()
    process.send?.({
      type: 'done',
      pid: process.pid,
      view: await chains.action('recovery', scope),
      paths: repo.list(scope).paths
    })
    await chains.close()
    await runtime.close()
    await query.close()
    db.close()
    process.exit(0)
  } catch (error) {
    process.send?.({ type: 'error', message: String(error), stack: error.stack })
    await chains.close()
    await runtime.close()
    await query.close()
    db.close()
    process.exit(1)
  }
})
