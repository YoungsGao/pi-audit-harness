export function createScanModelFixture(mode?: string): Promise<{
  baseUrl: string
  requests: unknown[]
  close: () => Promise<void>
}>
