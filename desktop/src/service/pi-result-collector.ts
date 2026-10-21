import { ApiError } from '../shared/api-error.ts'
import type { ReportPreview, SourceEvidence } from '../shared/pi-contracts.ts'

export class PiResultCollector {
  readonly evidence: SourceEvidence[] = []
  report?: ReportPreview
  error?: ApiError

  fail(): void {
    this.error = new ApiError('PI_EXTENSION_FAILED', 'Pi 扩展执行失败，请根据请求编号排查', 502)
  }

  assertHealthy(): void {
    if (this.error) throw this.error
  }
}
