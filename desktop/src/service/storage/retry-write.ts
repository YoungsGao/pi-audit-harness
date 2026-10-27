import { setTimeout as delay } from 'node:timers/promises'
import { ApiError } from '../../shared/api-error.ts'

// Retry only an already rolled-back SQLite transaction. Never repeat a model/Git request.
export async function retryWrite<T>(work: () => T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return work()
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'DB_QUERY_FAILED' || attempt >= 2)
        throw error
      await delay(50 * (attempt + 1))
    }
  }
}
