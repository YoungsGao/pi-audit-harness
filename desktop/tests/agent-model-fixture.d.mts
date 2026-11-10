export function createAgentModelFixture(options?: {
  mode?: string
  port?: number
  delayMs?: number
  supportPing?: boolean
  beforeReply?: (body: { messages: { role: string }[] }) => Promise<void>
  transformDecision?: (
    decision: unknown,
    context: {
      tools: { stepIndex: number; citations?: { id: string }[] }[]
      users: unknown[]
      requests: unknown[]
    }
  ) => unknown
}): Promise<{
  baseUrl: string
  requests: unknown[]
  setMode: (mode: string) => void
  close: () => Promise<void>
}>
