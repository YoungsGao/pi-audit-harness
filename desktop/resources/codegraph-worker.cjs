// One-shot SDK worker. Only the parent supplies paths; no CLI/installer/watchers.
'use strict'
const fs = require('node:fs')
const crypto = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
let busy = false
process.once('message', async ({ root, library, files, output }) => {
  if (busy) return
  busy = true
  let graph, db
  const started = Date.now()
  let peakRss = process.memoryUsage().rss
  const sample = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
    process.send?.({ type: 'memory', rss: peakRss })
  }, 100)
  try {
    const { CodeGraph } = require(library)
    graph = await CodeGraph.init(root, { index: false })
    const result = await graph.indexAll()
    const nodes = files
      .flatMap((file) => graph.getNodesInFile(file))
      .map((n) => ({
        id: n.id,
        kind: n.kind,
        name: n.name,
        qualifiedName: n.qualifiedName,
        filePath: n.filePath,
        startLine: n.startLine,
        startColumn: n.startColumn,
        endLine: n.endLine,
        endColumn: n.endColumn,
        signature: n.signature ?? null,
        generated: /lombok|implicit.*record/i.test(n.docstring ?? '')
      }))
      .sort((a, b) => a.id.localeCompare(b.id, 'en'))
    if (nodes.length > 50000) throw Error('QUERY_GRAPH_LIMIT')
    const edges = nodes
      .flatMap((n) => graph.getOutgoingEdges(n.id))
      .filter((e) => ['calls', 'references', 'instantiates', 'type_of'].includes(e.kind))
      .map((e) => ({
        source: e.source,
        target: e.target,
        kind: e.kind,
        line: e.line ?? null,
        column: e.column ?? null,
        provenance: e.provenance ?? 'unspecified',
        resolvedBy: String(e.metadata?.resolvedBy ?? 'unspecified'),
        confidence: Number(e.metadata?.confidence ?? 0)
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'))
    if (edges.length > 150000) throw Error('QUERY_GRAPH_LIMIT')
    const indexed = graph
      .getFiles()
      .filter((f) => files.includes(f.path) && !f.errors?.length)
      .map((f) => f.path)
      .sort()
    const digest = crypto
      .createHash('sha256')
      .update(JSON.stringify({ nodes, edges, indexed }))
      .digest('hex')
    db = new DatabaseSync(output)
    db.exec(`PRAGMA journal_mode=DELETE; CREATE TABLE nodes(id TEXT PRIMARY KEY,file TEXT NOT NULL,json TEXT NOT NULL) STRICT;
      CREATE TABLE edges(source TEXT NOT NULL,target TEXT NOT NULL,kind TEXT NOT NULL,json TEXT NOT NULL) STRICT;
      CREATE INDEX nodes_file ON nodes(file); CREATE INDEX edges_source ON edges(source); CREATE INDEX edges_target ON edges(target);
      CREATE TABLE metadata(json TEXT NOT NULL) STRICT; BEGIN`)
    const nodeInsert = db.prepare('INSERT INTO nodes VALUES(?,?,?)'),
      edgeInsert = db.prepare('INSERT INTO edges VALUES(?,?,?,?)')
    for (const n of nodes) nodeInsert.run(n.id, n.filePath, JSON.stringify(n))
    for (const e of edges) edgeInsert.run(e.source, e.target, e.kind, JSON.stringify(e))
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
    const meta = {
      digest,
      indexed,
      errors: result.filesErrored,
      nodes: nodes.length,
      edges: edges.length,
      durationMs: Date.now() - started,
      peakRss
    }
    db.prepare('INSERT INTO metadata VALUES(?)').run(JSON.stringify(meta))
    db.exec('COMMIT')
    db.close()
    db = undefined
    graph.close()
    graph = undefined
    const fd = fs.openSync(output, 'r+')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    clearInterval(sample)
    // SDK workers can otherwise retain WASM heaps. The exit is intentional.
    process.send?.({ type: 'complete', meta }, () => process.exit(0))
  } catch (e) {
    try {
      db?.close()
      graph?.close()
    } catch {
      /* Failed worker resources are released by process exit. */
    }
    clearInterval(sample)
    process.send?.(
      {
        type: 'error',
        code: /^QUERY_[A-Z_]+$/.test(e.message) ? e.message : 'QUERY_GRAPH_BUILD_FAILED'
      },
      () => process.exit(1)
    )
  }
})
process.once('disconnect', () => process.exit(1))
