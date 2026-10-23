import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { ApiError } from '../../shared/api-error.ts'

export type Row = Record<string, SQLOutputValue>
export interface SqlSession {
  exec(sql: string): void
  run(sql: string, ...params: SQLInputValue[]): void
  all(sql: string, ...params: SQLInputValue[]): Row[]
  get(sql: string, ...params: SQLInputValue[]): Row | undefined
}

// 只供服务进程内部使用。前端永远拿不到连接、SQL 或文件路径参数。
export class LocalDatabase implements SqlSession {
  readonly filePath: string
  private connection: DatabaseSync
  private closed = false
  private inTransaction = false

  constructor(dataRoot: string) {
    if (!isAbsolute(dataRoot)) throw new ApiError('DB_INVALID_ROOT', '数据库目录必须为绝对路径')
    this.filePath = join(dataRoot, 'storage', 'audit.sqlite3')
    let opened: DatabaseSync | undefined
    try {
      mkdirSync(join(dataRoot, 'storage'), { recursive: true })
      opened = new DatabaseSync(this.filePath, {
        enableForeignKeyConstraints: true,
        allowExtension: false,
        timeout: 1000
      })
      // 显式设置并读回：不要假定所有 SQLite 驱动都默认开启外键。
      opened.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000;')
      if (opened.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1)
        throw new Error('foreign keys disabled')
      this.connection = opened
    } catch {
      opened?.close()
      throw new ApiError('DB_OPEN_FAILED', '无法打开本地数据库，请检查目录权限和文件状态')
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new ApiError('DB_CLOSED', '数据库连接已经关闭')
  }

  exec(sql: string): void {
    this.ensureOpen()
    try {
      this.connection.exec(sql)
    } catch {
      throw new ApiError('DB_QUERY_FAILED', '数据库操作失败，请检查约束或锁状态')
    }
  }

  run(sql: string, ...params: SQLInputValue[]): void {
    this.ensureOpen()
    try {
      this.connection.prepare(sql).run(...params)
    } catch {
      throw new ApiError('DB_QUERY_FAILED', '数据库写入失败，请检查约束或锁状态')
    }
  }

  all(sql: string, ...params: SQLInputValue[]): Row[] {
    this.ensureOpen()
    try {
      return this.connection.prepare(sql).all(...params)
    } catch {
      throw new ApiError('DB_QUERY_FAILED', '数据库查询失败')
    }
  }

  get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.all(sql, ...params)[0]
  }

  transaction<T>(work: (session: SqlSession) => T): T {
    this.ensureOpen()
    if (this.inTransaction) throw new ApiError('DB_NESTED_TRANSACTION', '不允许嵌套事务')
    if (work.constructor.name === 'AsyncFunction')
      throw new ApiError('DB_ASYNC_TRANSACTION', '事务回调必须同步执行')
    this.exec('BEGIN IMMEDIATE')
    this.inTransaction = true
    let active = true
    // 回调结束后使会话失效，防止异步续体在回滚后继续通过该会话写数据。
    const check = (): void => {
      if (!active) throw new ApiError('DB_TRANSACTION_ENDED', '事务会话已经结束')
    }
    const scoped: SqlSession = {
      exec: (sql) => {
        check()
        this.exec(sql)
      },
      run: (sql, ...params) => {
        check()
        this.run(sql, ...params)
      },
      all: (sql, ...params) => {
        check()
        return this.all(sql, ...params)
      },
      get: (sql, ...params) => {
        check()
        return this.get(sql, ...params)
      }
    }
    try {
      const result = work(scoped)
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        // 防止被拒绝的 Promise 产生未处理拒绝；事务仍立即回滚。
        void Promise.resolve(result).catch(() => {})
        throw new ApiError('DB_ASYNC_TRANSACTION', '事务回调不能返回 Promise')
      }
      this.exec('COMMIT')
      return result
    } catch (error) {
      this.exec('ROLLBACK')
      throw error
    } finally {
      active = false
      this.inTransaction = false
    }
  }

  close(): void {
    if (this.closed) return
    if (this.inTransaction) throw new ApiError('DB_TRANSACTION_ACTIVE', '事务中不能关闭数据库')
    this.connection.close()
    this.closed = true
  }
}
