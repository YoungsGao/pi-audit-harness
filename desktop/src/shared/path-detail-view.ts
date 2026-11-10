import type { PathSummary } from './scan-contracts'
import { redactText } from './redaction.ts'

export const detailTabs = [
  { id: 'path', label: '调用路径' },
  { id: 'evidence', label: '传播证据' },
  { id: 'defense', label: '防护分析' },
  { id: 'process', label: '分析过程' }
] as const
export type DetailTab = (typeof detailTabs)[number]['id']
export interface DetailSelection {
  projectId: string
  runId: string
  pathId: string
  tab: DetailTab
}
export const detailSelectionKey = 'audit.detail.selection.v1'
export const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

// Only selection identifiers are remembered here. Evidence and events always come from SQLite.
export function parseDetailSelection(raw: string | null): DetailSelection | null {
  try {
    if (!raw || raw.length > 600) return null
    const value = asRecord(JSON.parse(raw))
    if (
      Object.keys(value).length !== 4 ||
      !['projectId', 'runId', 'pathId'].every(
        (key) => typeof value[key] === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value[key])
      ) ||
      !detailTabs.some((tab) => tab.id === value.tab)
    )
      return null
    return value as unknown as DetailSelection
  } catch {
    return null
  }
}

export function pathOutcome(path: Pick<PathSummary, 'status' | 'verdict'>): string {
  if (path.status === 'pending') return '未分析'
  if (path.status === 'analyzing') return '分析中，结论待确认'
  if (path.status === 'failed') return '分析失败，风险未知'
  if (path.status === 'invalid') return '无效调用链，风险未知'
  if (path.verdict === 'dangerous') return '风险：静态证据支持'
  if (path.verdict === 'safe') return '阻断：当前路径已有防护证据'
  return '证据不足，风险未知'
}

export function publicAnalysisText(text: string, secrets: readonly string[] = []): string {
  return redactText(text, secrets)
}

// Display-only defense in depth; service-side redaction remains the primary boundary.
export function publicAnalysisValue(
  value: unknown,
  depth = 0,
  secrets: readonly string[] = []
): unknown {
  if (depth > 16) return '[记录过深，未展开]'
  if (typeof value === 'string') return publicAnalysisText(value, secrets)
  if (Array.isArray(value))
    return value.map((item) => publicAnalysisValue(item, depth + 1, secrets))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /api.?key|secret|password|authorization|(?:access|refresh).?token|^token$/i.test(key)
          ? '[REDACTED]'
          : publicAnalysisValue(item, depth + 1, secrets)
      ])
    )
  return value
}

export interface SavedEvidence {
  filePath: string
  startLine: number
  endLine: number
  quote: string
}
export function savedEvidence(value: unknown): SavedEvidence[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is SavedEvidence => {
    const row = asRecord(item)
    return (
      typeof row.filePath === 'string' &&
      !!row.filePath.trim() &&
      Number.isSafeInteger(row.startLine) &&
      Number(row.startLine) >= 1 &&
      Number.isSafeInteger(row.endLine) &&
      Number(row.endLine) >= Number(row.startLine) &&
      typeof row.quote === 'string' &&
      !!row.quote.trim()
    )
  })
}
