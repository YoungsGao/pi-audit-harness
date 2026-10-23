// 只有测试导入本文件；不能将这些假结果说成真实审计发现。
export function completedFixture(suffix = 'one') {
  return {
    project: {
      id: 'fixture-project-' + suffix,
      name: 'SQLite 教学测试项目',
      path: 'C:/fixture/source',
      sourceType: 'local'
    },
    run: { id: 'fixture-run-' + suffix, sourceStamp: 'fixture-commit', rulesVersion: 'fixture-v1' },
    edges: [
      {
        id: 'fixture-edge-' + suffix,
        filePath: 'src/Demo.java',
        caller: 'Demo#entry',
        callee: 'Db#query',
        line: 12,
        isSink: true
      }
    ],
    paths: [
      {
        id: 'fixture-path-' + suffix,
        hash: 'fixture-hash-' + suffix,
        sinkEdgeId: 'fixture-edge-' + suffix,
        verdict: 'dangerous',
        summary: '受控测试结果：参数进入查询调用',
        edgeIds: ['fixture-edge-' + suffix]
      }
    ],
    report: {
      id: 'fixture-report-' + suffix,
      filePath: 'reports/fixture.html',
      summary: '仅验证报告元数据，不生成 HTML'
    }
  }
}
