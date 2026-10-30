export interface SnapshotInfo {
  projectId: string
  runId: string
  snapshotId: string
  sourceStamp: string
  commit: string | null
  createdAt: string
  ignored: string[]
  files: { filePath: string; sha256: string; size: number }[]
}
export const disclosureCategories = [
  'Java 源码片段与可定位的调用方/被调用方函数（可能覆盖快照中的任意 Java 文件）',
  '相对文件路径、函数名、调用参数、项目/任务/路径标识',
  '漏洞规则、选定审计知识模板、项目补充要求、手工调查说明、已有工具证据与本次分析对话'
] as const
export interface DisclosureScope {
  reviewContextHash: string
  projectId: string
  runId: string
  snapshotId: string
  scopeKey: string
  configId: string
  revision: number
  baseUrl: string
  modelId: string
  fileCount: number
  totalBytes: number
  categories: string[]
  authorized: boolean
}
export interface ManualRiskPoint {
  snapshotId: string
  filePath: string
  line: number
  column: number
  functionKey: string | null
  ruleId: string
  note: string
}
