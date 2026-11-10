// 生成技术方案目录索引与页面附带的兜底数据。
// 用法：node docs/technical/assets/gen-index.mjs
// 新增 / 删除 docs/technical/*.md 之后跑一次，提交 index.json 与 assets/fallback.js。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // docs/technical/assets
const techDir = resolve(here, '..');
const root = resolve(techDir, '..', '..');

const heading = (text, fallback) => {
  const m = text.match(/^#\s+(.+)$/m);
  return (m ? m[1] : fallback).trim();
};

const names = readdirSync(techDir)
  .filter(f => f.toLowerCase().endsWith('.md') && !f.startsWith('.'))
  .map(name => {
    const content = readFileSync(join(techDir, name), 'utf8');
    const title = name === '_template.md' ? '文档模板' : heading(content, name.replace(/\.md$/i, ''));
    return { path: name, title, content };
  });

// README 置顶，数字前缀按自然序，下划线开头的（模板）排最后
const rank = d => (d.path === 'README.md' ? 0 : d.path.startsWith('_') ? 2 : 1);
names.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path, 'zh-CN', { numeric: true }));

const documents = names.map(({ path, title }) => ({ path, title }));
writeFileSync(join(techDir, 'index.json'), JSON.stringify({ documents }, null, 2) + '\n');

const readme = readFileSync(join(root, 'README.md'), 'utf8');
writeFileSync(
  join(techDir, 'assets', 'fallback.js'),
  'window.DOCS_FALLBACK = ' + JSON.stringify({ readme, documents: names }) + ';\n'
);

console.log('index.json: ' + documents.length + ' 篇');
for (const d of documents) console.log('  - ' + d.path + '  →  ' + d.title);
console.log('fallback.js: ' + readFileSync(join(techDir, 'assets', 'fallback.js'), 'utf8').length + ' bytes');
