export function MarkdownPreview({ markdown }: { markdown: string }): React.JSX.Element {
  const rows = markdown.split('\n'),
    blocks: React.JSX.Element[] = []
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].trim()) continue
    const fence = rows[i].match(/^\s*(`{3,}|~{3,})(.*)$/)
    if (fence) {
      const code: string[] = [],
        marker = fence[1]
      while (i + 1 < rows.length && !rows[i + 1].trim().startsWith(marker)) code.push(rows[++i])
      if (i + 1 < rows.length) i++
      blocks.push(
        <pre key={i}>
          <code>{code.join('\n')}</code>
        </pre>
      )
      continue
    }
    const heading = rows[i].match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      blocks.push(
        heading[1].length === 1 ? <h3 key={i}>{heading[2]}</h3> : <h4 key={i}>{heading[2]}</h4>
      )
      continue
    }
    const bullet = (line: string): RegExpMatchArray | null =>
      line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.*)$/)
    if (bullet(rows[i])) {
      const items: string[] = [bullet(rows[i])![1]]
      while (i + 1 < rows.length && bullet(rows[i + 1])) items.push(bullet(rows[++i])![1])
      blocks.push(
        <ul key={i}>
          {items.map((text, n) => (
            <li key={n}>{text}</li>
          ))}
        </ul>
      )
      continue
    }
    if (/^>\s?/.test(rows[i])) {
      blocks.push(<blockquote key={i}>{rows[i].replace(/^>\s?/, '')}</blockquote>)
      continue
    }
    const paragraph = [rows[i]]
    while (
      i + 1 < rows.length &&
      rows[i + 1].trim() &&
      !/^(#|>|```|~~~|\s*[-*+]\s|\d+[.)]\s)/.test(rows[i + 1])
    )
      paragraph.push(rows[++i])
    blocks.push(<p key={i}>{paragraph.join('\n')}</p>)
  }
  return (
    <div className="markdown-preview" data-testid="markdown-preview">
      {blocks.length ? blocks : <p className="muted">填写 Markdown 正文后在此预览。</p>}
    </div>
  )
}
