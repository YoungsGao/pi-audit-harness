import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import type { AuditPreview } from '../../../shared/pi-contracts.ts'
import { ApiError } from '../../../shared/api-error.ts'
import { PiResultCollector } from '../../pi-result-collector.ts'

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function createReportExtension(
  input: AuditPreview,
  collector: PiResultCollector
): ExtensionFactory {
  return (pi) => {
    pi.registerCommand('report', {
      description: '根据服务提供的指定任务结果生成运行时预览报告',
      handler: async (runId) => {
        if (
          runId !== input.runId ||
          input.scope !== 'runtime-preview' ||
          typeof input.summary !== 'string' ||
          !Array.isArray(input.evidence)
        ) {
          throw new ApiError('INVALID_REPORT_INPUT', '报告输入与本次任务不一致', 400)
        }
        const body = input.evidence
          .map(
            (item) =>
              '<h2>' +
              escapeHtml(item.file) +
              ':' +
              item.startLine +
              '-' +
              item.endLine +
              '</h2>' +
              '<pre>' +
              escapeHtml(item.content) +
              '</pre>'
          )
          .join('')
        collector.report = {
          projectId: input.projectId,
          runId: input.runId,
          html:
            '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
            '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
            '<title>Pi 运行时预览报告</title><style>body{max-width:900px;margin:40px auto;font:16px/1.7 sans-serif}pre{white-space:pre-wrap;background:#f3f4f6;padding:16px}</style>' +
            '<h1>ENV-02 运行时预览</h1><p>用于验证扩展调用，不代表完成正式漏洞审计。</p>' +
            '<p>项目：' +
            escapeHtml(input.projectId) +
            '；任务：' +
            escapeHtml(input.runId) +
            '</p>' +
            '<h2>摘要</h2><p>' +
            escapeHtml(input.summary) +
            '</p>' +
            body +
            '</html>'
        }
      }
    })
  }
}
