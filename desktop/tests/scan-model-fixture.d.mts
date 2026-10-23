export function createScanModelFixture(): Promise<{
  baseUrl: string
  requests: unknown[]
  close: () => Promise<void>
}>
