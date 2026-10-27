import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CreateAgentSessionResult, ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { PiRuntime, throwIfCancelled, waitWithSignal } from '../pi-runtime.ts'
import { loadPiSdk } from '../pi-sdk.ts'
import { createPiResources } from '../pi-resources.ts'
import { ApiError } from '../../shared/api-error.ts'
import type { ReportScope } from '../../shared/report-contracts'
import type { ReportSnapshot } from './snapshot.ts'
import { renderSavedReport } from './html.ts'

// This is a real Pi command session, with no audit model credentials or provider requests.
export async function executeSavedReport(
  runtime: PiRuntime,
  scope: ReportScope,
  readSnapshot: () => ReportSnapshot,
  publish: (snapshot: ReportSnapshot, html: string) => Promise<void>,
  outerSignal?: AbortSignal
): Promise<void> {
  await runtime.run(
    async (signal) => {
      const sdk = await waitWithSignal(loadPiSdk(), signal)
      let session: CreateAgentSessionResult['session'] | undefined
      let commandError: unknown
      let extensionError = false,
        completed = false
      const extension: ExtensionFactory = (pi) => {
        pi.on('before_provider_request', () => {
          throw new ApiError('REPORT_MODEL_FORBIDDEN', '保存结果报告不允许发起模型请求', 409)
        })
        pi.registerCommand('report', {
          description: '从指定项目与任务的 SQLite 快照生成 HTML 报告',
          handler: async (args) => {
            try {
              if (args !== `${scope.projectId} ${scope.runId}`)
                throw new ApiError('REPORT_INVALID_INPUT', '报告命令作用域无效', 400)
              throwIfCancelled(signal)
              const snapshot = readSnapshot()
              const html = renderSavedReport(snapshot)
              throwIfCancelled(signal)
              await publish(snapshot, html)
              throwIfCancelled(signal)
              completed = true
            } catch (error) {
              commandError = error
              throw error
            }
          }
        })
      }
      try {
        const directory = join(runtime.workDir, 'report-' + randomUUID())
        await mkdir(directory, { recursive: true })
        const modelRuntime = await sdk.ModelRuntime.create({
          authPath: join(directory, 'unused-auth.json'),
          modelsPath: null,
          modelsStorePath: join(directory, 'models.sqlite'),
          refreshOnCreate: false,
          allowModelNetwork: false,
          signal
        })
        const resources = await createPiResources(directory, runtime.agentDir, [
          { name: 'saved-report@1', factory: extension }
        ])
        const created = await waitWithSignal(
          sdk.createAgentSession({
            cwd: directory,
            agentDir: runtime.agentDir,
            modelRuntime,
            resourceLoader: resources,
            tools: [],
            noTools: 'builtin',
            thinkingLevel: 'off',
            sessionManager: sdk.SessionManager.inMemory(directory),
            settingsManager: sdk.SettingsManager.inMemory({
              retry: { enabled: false },
              compaction: { enabled: false }
            })
          }),
          signal,
          (late) => late.session.dispose()
        )
        session = created.session
        await session.bindExtensions({
          mode: 'json',
          onError: () => {
            extensionError = true
          }
        })
        await waitWithSignal(session.prompt(`/report ${scope.projectId} ${scope.runId}`), signal)
        if (commandError) throw commandError
        if (extensionError || !completed)
          throw new ApiError('REPORT_EXTENSION_FAILED', 'Pi 报告扩展未生成有效产物', 502)
      } finally {
        session?.dispose()
      }
    },
    30000,
    outerSignal
  )
}
