import type { SourceTools, ToolState } from '../../shared/source-contracts'
import { ApiError } from '../../shared/api-error.ts'
import { command } from './process.ts'
export async function detectTool(name: string, signal?: AbortSignal): Promise<ToolState> {
  try {
    const version = (await command(name, ['--version'], { signal })).split(/\r?\n/)[0]
    if (!/^(?:git version |ripgrep )/.test(version)) return { state: 'failed', version: '' }
    return { state: 'available', version: version.slice(0, 180) }
  } catch (error) {
    if (error instanceof ApiError && error.code === 'SOURCE_CANCELLED') throw error
    return {
      state: error instanceof ApiError && error.code === 'TOOL_MISSING' ? 'missing' : 'failed',
      version: ''
    }
  }
}
export async function detectTools(signal?: AbortSignal): Promise<SourceTools> {
  const [git, rg] = await Promise.all([detectTool('git', signal), detectTool('rg', signal)])
  return { git, rg }
}
