import { createHash, randomUUID } from 'node:crypto'
import { ApiError } from '../../shared/api-error.ts'
import type { SnapshotInfo } from '../../shared/input-enhancements'
import type { LocalDatabase } from './database'

export const ignoredSourceScope = [
  '仅纳入 .java 文件；非 Java 文件、配置、资源与二进制均不纳入',
  '不跟随符号链接和目录联接',
  '忽略目录：.git、.svn、node_modules、target、build、dist、.idea、.gradle、vendor',
  '最多 2000 个文件、单文件 2MiB、总计 20MiB；超限整次失败'
]
export class SnapshotRepository {
  private readonly db: LocalDatabase
  constructor(db: LocalDatabase) {
    this.db = db
  }

  save(
    projectId: string,
    runId: string,
    sourceStamp: string,
    files: { filePath: string; bytes: Uint8Array }[]
  ): SnapshotInfo {
    const manifest = files
      .map((file) => ({
        filePath: file.filePath,
        sha256: createHash('sha256').update(file.bytes).digest('hex'),
        size: file.bytes.length
      }))
      .sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0))
    const stamp =
      'java-sha256:' +
      createHash('sha256')
        .update(
          manifest
            .map((f) => JSON.stringify([f.filePath, f.sha256]))
            .sort()
            .join('\n')
        )
        .digest('hex')
    if (stamp !== sourceStamp || !files.length)
      throw new ApiError('SNAPSHOT_CHANGED', '快照内容与登记指纹不一致，请重新登记', 409)
    this.db.transaction((tx) => {
      const run = tx.get(
        'SELECT source_stamp FROM audit_runs WHERE id=? AND project_id=?',
        runId,
        projectId
      )
      if (!run || run.source_stamp !== sourceStamp)
        throw new ApiError('SNAPSHOT_SCOPE_INVALID', '快照不属于指定任务', 409)
      let id = tx.get(
        'SELECT snapshot_id FROM source_snapshots WHERE project_id=? AND source_stamp=?',
        projectId,
        sourceStamp
      )?.snapshot_id
      if (!id) {
        id = randomUUID()
        const project = tx.get('SELECT git_commit FROM projects WHERE id=?', projectId)!
        tx.run(
          'INSERT INTO source_snapshots VALUES (?,?,?,?,?,?,?)',
          id,
          projectId,
          sourceStamp,
          JSON.stringify(manifest),
          JSON.stringify(ignoredSourceScope),
          project.git_commit,
          new Date().toISOString()
        )
        for (const file of files) {
          const entry = manifest.find((m) => m.filePath === file.filePath)!
          tx.run(
            'INSERT INTO snapshot_files VALUES (?,?,?,?)',
            id,
            file.filePath,
            entry.sha256,
            file.bytes
          )
        }
      }
      tx.run('INSERT INTO run_snapshots VALUES (?,?,?)', runId, projectId, id)
    })
    const info = this.info(projectId, runId)
    // 校验复用的快照，不能用新磁盘内容覆盖已损坏记录。
    for (const file of info.files) this.read(projectId, runId, file.filePath)
    return info
  }

  info(projectId: string, runId: string): SnapshotInfo {
    const row = this.db.get(
      `SELECT s.* FROM run_snapshots r JOIN source_snapshots s
      ON s.snapshot_id=r.snapshot_id AND s.project_id=r.project_id WHERE r.project_id=? AND r.run_id=?`,
      projectId,
      runId
    )
    if (!row)
      throw new ApiError('SNAPSHOT_MISSING', '此任务没有固定源码快照，请重新登记并创建新任务', 409)
    return {
      projectId,
      runId,
      snapshotId: String(row.snapshot_id),
      sourceStamp: String(row.source_stamp),
      commit: row.source_commit === null ? null : String(row.source_commit),
      createdAt: String(row.created_at),
      ignored: JSON.parse(String(row.ignored_json)),
      files: JSON.parse(String(row.manifest_json))
    }
  }

  read(projectId: string, runId: string, filePath: string): string {
    const info = this.info(projectId, runId),
      entry = info.files.find((f) => f.filePath === filePath)
    if (!entry) throw new ApiError('QUERY_FILE_OUT_OF_SCOPE', '文件不在任务快照范围内', 403)
    const file = this.db.get(
      'SELECT content,sha256 FROM snapshot_files WHERE snapshot_id=? AND file_path=?',
      info.snapshotId,
      filePath
    )
    if (
      !file ||
      !(file.content instanceof Uint8Array) ||
      file.content.length !== entry.size ||
      file.sha256 !== entry.sha256 ||
      createHash('sha256').update(file.content).digest('hex') !== entry.sha256
    )
      throw new ApiError(
        'SNAPSHOT_CORRUPT',
        '快照文件缺失或摘要不一致，停止取证；请创建新任务',
        409
      )
    return Buffer.from(file.content).toString('utf8')
  }
}
