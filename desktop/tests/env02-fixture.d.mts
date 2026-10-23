import type { ModelConfig, ModelPorts } from '../src/shared/pi-contracts'

export function createEnv02Fixture(options?: {
  holdReply?: boolean
  errorStatus?: number
}): Promise<{
  directory: string
  projectRoot: string
  config: ModelConfig
  ports: ModelPorts
  requests: unknown[]
  close: () => Promise<void>
}>
