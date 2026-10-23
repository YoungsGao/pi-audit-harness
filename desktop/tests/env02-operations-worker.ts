import assert from 'node:assert/strict'
import type { ModelConfig } from '../src/shared/pi-contracts'
import { PiRuntime } from '../src/service/pi-runtime'
import { PiOperations } from '../src/service/pi-adapter'

const parent = process.parentPort
if (!parent) throw new Error('本文件仅用于 Electron 测试子进程')
parent.once('message', (event: { data: unknown }) => {
  const input = event.data as { root: string; projectRoot: string; config: ModelConfig }
  const runtime = new PiRuntime(input.root)
  void (async () => {
    try {
      const operations = new PiOperations(runtime, {
        getConfig: async (id) => (id === input.config.id ? input.config : undefined),
        readSecret: async () => 'fixture-key-not-a-real-secret'
      })
      const context = {
        requestId: 'electron-audit',
        projectId: 'electron-project',
        runId: 'electron-run'
      }
      const ping = await operations.ping(input.config.id, { requestId: 'electron-ping' })
      const audit = await operations.auditPreview(input.config.id, context, {
        projectId: context.projectId,
        runId: context.runId,
        projectRoot: input.projectRoot,
        file: 'Demo.java',
        startLine: 1,
        endLine: 3
      })
      const report = await operations.reportPreview(
        input.config.id,
        { ...context, requestId: 'electron-report' },
        audit
      )
      assert.deepEqual(ping.model, audit.model)
      assert.equal(audit.evidence.length, 1)
      assert.ok(report.html.includes('ENV-02'))
      parent.postMessage({ ok: true, html: report.html })
      await runtime.close()
      process.exit(0)
    } catch (error) {
      parent.postMessage({
        ok: false,
        message: error instanceof Error ? error.message : '扩展探针失败'
      })
      await runtime.close().catch(() => {})
      process.exit(1)
    }
  })()
})
