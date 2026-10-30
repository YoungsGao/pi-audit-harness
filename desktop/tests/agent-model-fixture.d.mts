export function createAgentModelFixture(options?: {
  mode?: string
  delayMs?: number
  supportPing?: boolean
  beforeReply?: (body: { messages: { role: string }[] }) => Promise<void>
}): Promise<{
  baseUrl: string
  requests: unknown[]
  setMode: (mode: string) => void
  close: () => Promise<void>
}>
