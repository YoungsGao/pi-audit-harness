export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly retryable: boolean
  readonly requestId?: string

  constructor(code: string, message: string, status = 500, retryable = false, requestId?: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.retryable = retryable
    this.requestId = requestId
  }
}
