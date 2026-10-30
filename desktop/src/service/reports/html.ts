import { escapeHtml } from '../pi/extensions/report.ts'
import type { ReportSnapshot } from './snapshot.ts'
import { pathOutcome, savedEvidence, asRecord } from '../../shared/path-detail-view.ts'
import { reviewLabels } from '../../shared/review-contracts.ts'

const e = (value: unknown): string => escapeHtml(String(value ?? '未记录'))
function humanReview(snapshot: ReportSnapshot, pathId: string): string {
  const review = snapshot.humanReviews.find((row) => row.pathId === pathId)
  if (!review || review.revision === 0)
    return '<h3>独立人工复核</h3><p>未复核；没有人工结论，不改变机器结论。</p>'
  return `<h3>独立人工复核</h3><p>状态：${e(reviewLabels[review.status])}；版本：${review.revision}；保存：${e(review.savedAt)}</p>${review.stale ? '<p class="notice">复核基线已更新：此人工记录对应较早的机器结果，需重新复核。</p>' : ''}<pre>${e(review.note || '未填写备注')}</pre><p>复核基线：${e(review.baseline?.status)} / ${e(review.baseline?.verdict)}，尝试 ${e(review.baseline?.attempt)}；基线摘要 ${e(review.baseline?.version)}</p><p>人工记录独立保存，不修改机器结论或源码证据。</p>`
}
export function renderSavedReport(snapshot: ReportSnapshot): string {
  const stats = snapshot.statistics
  const paths = snapshot.paths
    .map(
      (path) => `<article><h2>${e(pathOutcome(path))}</h2>
    <p>pathId：${e(path.pathId)}；规则：${e(path.ruleId)}</p><p>来源：${e(path.sourceRef)}</p>
    ${path.manualPoint ? `<p>手工调查位置：${e(path.manualPoint.filePath)}:${path.manualPoint.line}:${path.manualPoint.column}；快照 ${e(path.manualPoint.snapshotId)}</p><p>调查说明：${e(path.manualPoint.note)}</p>` : ''}
    <p>调查状态：${e(path.status)}；verdict：${e(path.verdict)}；dangerous：${path.dangerous === null ? 'NULL（未知）' : e(path.dangerous)}</p>
    <p>机器结论：${e(path.summary || '尚无已提交结论')}</p>${humanReview(snapshot, path.pathId)}${path.truncated ? `<p class="notice">部分覆盖：${e(path.truncationReason)}</p>` : ''}
    ${['analyzing', 'failed'].includes(path.status) ? '<p class="notice">当前尝试未成功完成；步骤证据可能来自此前提交的快照，不能作为本次完成依据。</p>' : ''}
    <ol>${[...path.steps]
      .sort((a, b) => a.stepIndex - b.stepIndex)
      .map(
        (
          step
        ) => `<li><h3>第 ${step.stepIndex + 1} 步：${e(step.edge.functionName)} → ${e(step.edge.calledFunctionName)}</h3>
      <p>${e(step.edge.filePath)}:${step.edge.callLine}:${step.edge.callColumn}；${e(step.edge.resolutionStatus)}；${step.edge.isSink ? '候选 Sink' : '候选调用'}</p>
      <h4>源码证据</h4>${
        savedEvidence(step.evidence)
          .map(
            (quote) =>
              `<p>取证范围 ${e(quote.filePath)}:${quote.startLine}–${quote.endLine}</p><pre>${e(quote.quote)}</pre>`
          )
          .join('') || '<p>没有已保存的有效原文引用，不能补造证据。</p>'
      }
      <h4>污染输入 / 输出</h4><pre>${e(JSON.stringify({ taintIn: step.taintIn, taintOut: step.taintOut }, null, 2))}</pre>
      <h4>传播核查与防护</h4><pre>${e(JSON.stringify(step.propagation, null, 2))}</pre><p>${e(step.defenseSummary || '没有已保存的防护说明；不能据此判断已阻断。')}</p>
      ${asRecord(step.propagation.defense).status === 'blocked' ? '<p>本步骤保存了局部阻断记录；不代表整个项目安全。</p>' : ''}</li>`
      )
      .join('')}</ol></article>`
    )
    .join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <title>${snapshot.stageReport ? '阶段报告' : '审计结果报告'} · ${e(snapshot.project.name)}</title>
    <style>body{max-width:1100px;margin:36px auto;padding:0 24px;font:16px/1.7 system-ui,sans-serif;color:#172536}h1,h2,h3{line-height:1.4}article{border-top:2px solid #bbcbd9;margin-top:28px;padding-top:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef3f7;padding:16px;border-radius:8px}p,li{overflow-wrap:anywhere}.notice{padding:12px;border-left:4px solid #b46d19;background:#fff4df}table{border-collapse:collapse}td,th{padding:10px;border:1px solid #b5c5d2;text-align:left}</style></head><body>
    <h1>${snapshot.stageReport ? '阶段报告' : '审计结果报告'}</h1><p class="notice">仅汇总生成时 SQLite 已保存的静态结果。${snapshot.stageReport ? '存在待办、未知、失败或未覆盖内容，不是完成全部审计的证明。' : '结论仍需人工复核，不包含动态利用验证。'}</p>
    <h2>阶段、结束原因与导出范围</h2>${snapshot.stageReasons.length ? `<ul>${snapshot.stageReasons.map((reason) => `<li>${e(reason)}</li>`).join('')}</ul>` : '<p>生成时所保存的任务结果已结束；结论仍只适用于当前代码版本。</p>'}<p>本次筛选 ${stats.paths} / ${snapshot.allStatistics.paths} 条路径；筛选条件：${e(JSON.stringify(snapshot.filter))}</p><p>结果摘要：${e(snapshot.snapshotKey)}</p>
    <h2>项目与任务</h2><p>${e(snapshot.project.name)}；项目 ${e(snapshot.project.projectId)}；来源 ${e(snapshot.project.sourceType)}</p>
    <p>仓库：${e(snapshot.project.gitUrl)}；提交：${e(snapshot.project.commit)}</p><p>runId：${e(snapshot.run.runId)}；生成时间：${e(snapshot.generatedAt)}</p>
    <p>源码指纹：${e(snapshot.run.sourceStamp)}；规则版本：${e(snapshot.run.rulesVersion)}</p><p>任务状态：${e(snapshot.run.status)} / ${e(snapshot.run.stage)}</p>
    <p>任务结束时间：${e(snapshot.run.finishedAt ?? '尚未结束或历史未记录')}；结束原因：${e(snapshot.run.errorCode ?? '未记录错误码')}</p>
    <h2>停止、恢复来源与用量边界</h2><p>控制状态：${e(snapshot.recovery.controlState)}；本次范围记录模型请求 ${snapshot.recovery.recordedRequests} 次，其中完成用量未确认 ${snapshot.recovery.uncertainRequests} 次。已发送请求可能收费；恢复可能重做未完成工作，记录次数不等于供应商账单。</p><pre>${e(JSON.stringify(snapshot.recovery.paths, null, 2))}</pre>
    <h2>固定源码快照与实际发送记录</h2>${snapshot.sourceSnapshot ? `<p>快照 ID：${e(snapshot.sourceSnapshot.snapshotId)}；文件数：${snapshot.sourceSnapshot.files.length}</p><details><summary>文件摘要与忽略范围</summary><pre>${e(JSON.stringify({ files: snapshot.sourceSnapshot.files, ignored: snapshot.sourceSnapshot.ignored }, null, 2))}</pre></details>` : '<p>历史任务没有固定源码快照。</p>'}
    <p>以下为请求前保存的实际配置及 SDK 返回的模型标识；请求失败可能未真正送达，未返回时不补造上游模型。</p><pre>${e(JSON.stringify(snapshot.transmissions, null, 2))}</pre>
    <h2>任务审计知识与项目补充要求</h2><p>保存状态：${e(snapshot.reviewConfig.state)}；材料摘要：${e(snapshot.reviewConfig.contextHash)}</p><p>自定义知识未经验证；补充提示不代表新增全部漏洞发现能力。</p><pre>${e(JSON.stringify(snapshot.reviewConfig, null, 2))}</pre>
    <h2>分析摘要与统计快照</h2><p>已登记 ${stats.paths} 条路径；危险路径 ${stats.dangerous} 条，按 Sink/规则去重后的风险点 ${stats.riskPoints} 个。</p>
    <table><thead><tr><th>口径</th><th>数量</th></tr></thead><tbody>${[
      ['危险路径（不同 pathId）', stats.dangerous],
      ['风险点（Sink/规则）', stats.riskPoints],
      ['已阻断路径', stats.safe],
      ['风险未知路径（含未分析等）', stats.unknown],
      ['待分析', stats.pending],
      ['分析中', stats.analyzing],
      ['证据不足', stats.unresolved],
      ['失败', stats.failed],
      ['无效链', stats.invalid],
      ['候选 Sink（不是漏洞数）', stats.sinks]
    ]
      .map(([label, n]) => `<tr><td>${e(label)}</td><td>${e(n)}</td></tr>`)
      .join('')}</tbody></table>
    <p>未知是风险维度；待分析、分析中、证据不足、失败是调查状态，不能将这些重叠口径相加。危险步骤和危险 API 数不作为漏洞数。</p>
    <h2>人工复核统计（独立口径）</h2><p>未复核 ${snapshot.reviewCounts.unreviewed}；人工确认 ${snapshot.reviewCounts.confirmed}；人工判为误报 ${snapshot.reviewCounts.false_positive}；待补充 ${snapshot.reviewCounts.needs_more_info}；其中基线已更新 ${snapshot.reviewCounts.stale}。人工状态不覆盖以上机器统计。</p>
    <h2>预处理覆盖范围</h2><p>状态：${e(snapshot.scan.state)}；截断：${snapshot.scan.truncated ? '是' : '否'}</p>
    ${snapshot.scan.warnings.length ? `<pre>${e(JSON.stringify(snapshot.scan.warnings, null, 2))}</pre>` : '<p>没有已保存的预处理警告；仍只代表当前支持范围。</p>'}
    <h2>调用路径、风险判断与已保存证据</h2>${paths || '<p>本次范围没有匹配的已保存调用路径；筛选无结果或零命中不代表整个项目安全。</p>'}
    <h2>未知项与后续建议</h2><ul><li>待分析 ${stats.pending} 条、分析中 ${stats.analyzing} 条、失败 ${stats.failed} 条、证据不足 ${stats.unresolved} 条；优先核对这些未确认内容。</li><li>对已成立风险检查输入来源、实参与形参映射和 Sink 的原文引用，再进行人工复核。</li><li>已阻断结论只针对所列路径与保存的源码版本，不能推广为项目整体安全。</li><li>源码或规则变化后创建新任务；新报告不会改写本报告及其统计快照。</li></ul>
    <p>由 Pi /report 扩展读取指定任务并按固定模板生成；未额外请求模型、未加载外部资源，也未包含未保存的模型过程。</p></body></html>`
}
