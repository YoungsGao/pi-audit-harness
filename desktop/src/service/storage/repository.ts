import { ApiError } from '../../shared/api-error.ts'
import type { DatabaseInfo, StorageOverview } from '../../shared/storage-contracts.ts'
import type { LocalDatabase } from './database.ts'

// 这是供后续分析器调用的持久化边界，不是一个对前端开放的写入接口。
// 本阶段通过受控 fixture 验证；真实源码解析、模型调用和报告生成属于后续需求。
export interface CompletedAudit {
  project: { id: string; name: string; path: string; sourceType: 'local' | 'git' }
  run: { id: string; sourceStamp: string; rulesVersion: string }
  edges: {
    id: string
    filePath: string
    caller: string
    callee: string
    line: number
    isSink: boolean
  }[]
  paths: {
    id: string
    hash: string
    sinkEdgeId: string | null
    verdict: 'unknown' | 'safe' | 'dangerous'
    summary: string
    edgeIds: string[]
  }[]
  report?: { id: string; filePath: string; summary: string }
}

export class AuditRepository {
  private readonly db: LocalDatabase
  constructor(db: LocalDatabase) {
    this.db = db
  }

  getInfo(): DatabaseInfo {
    return {
      state: 'ready',
      schemaVersion: Number(this.db.get('PRAGMA user_version')?.user_version),
      journalMode: 'wal'
    }
  }

  saveCompletedAudit(input: CompletedAudit): void {
    const rows =
      2 +
      input.edges.length +
      input.paths.length +
      input.paths.reduce((sum, path) => sum + path.edgeIds.length, 0) +
      (input.report ? 1 : 0)
    // DatabaseSync 会占用服务事件循环；限制每批行数，并且不能在事务里 await 模型/网络。
    if (rows > 1000) throw new ApiError('DB_BATCH_TOO_LARGE', '单次持久化最多 1000 行')
    const now = new Date().toISOString()
    const project = input.project
    this.db.transaction((tx) => {
      // 值全部使用绑定参数，用户文本中的引号不会被当成 SQL 指令。
      tx.run(
        `INSERT INTO projects (id,name,path,source_type,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, path=excluded.path,
          source_type=excluded.source_type, updated_at=excluded.updated_at`,
        project.id,
        project.name,
        project.path,
        project.sourceType,
        now,
        now
      )
      tx.run(
        `INSERT INTO audit_runs VALUES (?, ?, 'completed', ?, ?, NULL, ?, ?)`,
        input.run.id,
        project.id,
        input.run.sourceStamp,
        input.run.rulesVersion,
        now,
        now
      )
      for (const edge of input.edges)
        tx.run(
          'INSERT INTO call_edges (uid,run_id,project_id,file_path,caller_key,callee_key,call_line,is_sink,rule_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
          edge.id,
          input.run.id,
          project.id,
          edge.filePath,
          edge.caller,
          edge.callee,
          edge.line,
          Number(edge.isSink)
        )
      for (const path of input.paths) {
        const dangerous = path.verdict === 'unknown' ? null : Number(path.verdict === 'dangerous')
        tx.run(
          "INSERT INTO call_paths (path_id,run_id,project_id,path_hash,sink_edge_id,verdict,dangerous,result_summary,created_at,status,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)",
          path.id,
          input.run.id,
          project.id,
          path.hash,
          path.sinkEdgeId,
          path.verdict,
          dangerous,
          path.summary,
          now,
          now
        )
        path.edgeIds.forEach((edgeId, index) =>
          tx.run(
            'INSERT INTO path_steps (path_id,step_index,edge_uid,run_id,project_id) VALUES (?, ?, ?, ?, ?)',
            path.id,
            index,
            edgeId,
            input.run.id,
            project.id
          )
        )
      }
      if (input.report)
        tx.run(
          "INSERT INTO reports VALUES (?, ?, ?, ?, 'ready', ?, ?)",
          input.report.id,
          input.run.id,
          project.id,
          input.report.filePath,
          input.report.summary,
          now
        )
    })
  }

  overview(): StorageOverview {
    // 表名固定在代码中，绝不拼接前端传入的表名、排序或 SQL。
    const count = (table: string): number =>
      Number(this.db.get(`SELECT count(*) AS n FROM ${table}`)?.n)
    return {
      database: this.getInfo(),
      counts: {
        projects: count('projects'),
        runs: count('audit_runs'),
        results: count('call_paths'),
        reports: count('reports')
      },
      projects: this.db
        .all('SELECT id,name,source_type FROM projects ORDER BY updated_at DESC,id LIMIT 20')
        .map((row) => ({
          id: String(row.id),
          name: String(row.name),
          sourceType: row.source_type as 'local' | 'git'
        })),
      runs: this.db
        .all('SELECT id,project_id,status FROM audit_runs ORDER BY created_at DESC,id LIMIT 20')
        .map((row) => ({
          id: String(row.id),
          projectId: String(row.project_id),
          status: String(row.status)
        })),
      results: this.db
        .all(
          'SELECT path_id,run_id,verdict,result_summary FROM call_paths ORDER BY created_at DESC,path_id LIMIT 20'
        )
        .map((row) => ({
          id: String(row.path_id),
          runId: String(row.run_id),
          verdict: row.verdict as 'unknown' | 'safe' | 'dangerous',
          summary: String(row.result_summary)
        })),
      reports: this.db
        .all('SELECT id,run_id,status,summary FROM reports ORDER BY created_at DESC,id LIMIT 20')
        .map((row) => ({
          id: String(row.id),
          runId: String(row.run_id),
          status: String(row.status),
          summary: String(row.summary)
        }))
    }
  }
}
