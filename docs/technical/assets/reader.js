(function () {
  'use strict';

  const C = window.DOCS_CONFIG, F = window.DOCS_FALLBACK, M = window.Markdown;
  const $ = s => document.querySelector(s), esc = M.escape;
  const technical = document.body.dataset.view === 'technical';
  const content = $('#markdown'), toc = $('#toc'), status = $('#read-status');
  const local = location.protocol === 'file:';
  const pathEncode = p => p.split('/').map(encodeURIComponent).join('/');

  const RAW = [
    'https://raw.githubusercontent.com/' + C.owner + '/' + C.repo + '/' + encodeURIComponent(C.ref) + '/',
    'https://cdn.jsdelivr.net/gh/' + C.owner + '/' + C.repo + '@' + encodeURIComponent(C.ref) + '/'
  ];
  const CACHE_TTL = 10 * 60 * 1000, CACHE_KEY = 'pi-docs:v2:' + C.owner + '/' + C.repo + '@' + C.ref;

  function cacheGet(key) {
    try {
      const v = JSON.parse(localStorage.getItem(CACHE_KEY + ':' + key) || 'null');
      if (v && Date.now() - v.t < CACHE_TTL) return v.v;
    } catch (e) { }
    return null;
  }
  function cacheSet(key, value) {
    try { localStorage.setItem(CACHE_KEY + ':' + key, JSON.stringify({ t: Date.now(), v: value })); } catch (e) { }
  }

  let documents = (F.documents || []).map(d => ({ ...d })), token = 0;

  function selected() { return new URLSearchParams(location.hash.slice(1)).get('doc') || ''; }

  function normalize(path) {
    const out = [];
    for (const p of path.split('/')) {
      if (p === '..') out.pop();
      else if (p && p !== '.') out.push(p);
    }
    return out.join('/');
  }

  function resolve(url, img, path) {
    if (/^(https?:|mailto:|#)/i.test(url)) return url;
    let clean;
    try { clean = decodeURIComponent(url.split('#')[0]); } catch (e) { return '#'; }
    const target = normalize((path || 'README.md').split('/').slice(0, -1).join('/') + '/' + clean);
    if (technical && !img && /\.md$/i.test(target)) return '#doc=' + encodeURIComponent(target);
    if (!technical && !img && target.startsWith('docs/technical/')) {
      const rel = target.slice('docs/technical/'.length);
      if (!rel) return './technical/index.html';
      if (/\.md$/i.test(rel)) return './technical/index.html#doc=' + encodeURIComponent(rel);
    }
    // README 中用仓库相对路径（docs/...）时，映射到站点内相对路径
    if (!technical && !img && (target === 'docs' || target.startsWith('docs/'))) return './' + target.slice(5) + (target === 'docs' ? '/' : '');
    return raw((technical ? C.directory + '/' : '') + target);
  }

  function raw(path) { return RAW[0] + pathEncode(path); }

  function draw(text, path, label, source) {
    content.innerHTML = M.render(text, { resolve: (u, img) => resolve(u, img, path) });
    status.textContent = label;
    $('#source-link').href = source;
    toc.innerHTML = '<strong>本文目录</strong>' + Array.from(content.querySelectorAll('h2,h3')).map(h =>
      '<a href="#' + encodeURIComponent(h.id) + '" data-heading="' + esc(h.id) + '">' + esc(h.textContent) + '</a>').join('');
    document.title = (technical ? (content.querySelector('h1')?.textContent || path) : 'pi-audit-harness') + ' · 文档';
  }

  function list() {
    const q = ($('#doc-search')?.value || '').toLowerCase(), current = selected();
    const visible = documents.filter(d => (d.title + ' ' + d.path).toLowerCase().includes(q));
    $('#document-list').innerHTML = visible.map(d =>
      '<a class="document-link ' + (d.path === current ? 'active' : '') + '" href="#doc=' + encodeURIComponent(d.path) + '">' +
      esc(d.title) + '<small>' + esc(d.path) + '</small></a>').join('') || '<p class="list-status">没有匹配的文档。</p>';
  }

  // 依次尝试多个镜像，任一成功即返回
  async function text(path) {
    let lastError;
    for (const base of RAW) {
      try {
        const r = await fetch(base + pathEncode(path), { cache: 'no-cache' });
        if (!r.ok) throw Error('HTTP ' + r.status);
        return await r.text();
      } catch (e) { lastError = e; }
    }
    throw lastError || Error('读取失败');
  }

  // 目录发现：仓库内的 index.json（随提交更新，raw 数分钟内生效）
  // → jsDelivr 文件清单（无鉴权、不限流，但分支清单有约 12 小时缓存）
  // → GitHub 树接口（未鉴权 60 次/小时）
  // → 页面附带的索引
  const LISTERS = [
    {
      name: 'index.json',
      run: async () => {
        const data = JSON.parse(await text(C.directory + '/index.json'));
        const docs = (data.documents || []).filter(d => d && d.path);
        if (!docs.length) throw Error('索引为空');
        return docs.map(d => {
          const known = (F.documents || []).find(x => x.path === d.path);
          return { path: d.path, title: d.title || known?.title || d.path, content: known?.content };
        });
      }
    },
    {
      name: 'jsDelivr',
      run: async () => {
        const r = await fetch('https://data.jsdelivr.com/v1/packages/gh/' + C.owner + '/' + C.repo + '@' + C.ref + '?structure=flat', { cache: 'no-cache' });
        if (!r.ok) throw Error('HTTP ' + r.status);
        const data = await r.json();
        return toDocuments((data.files || []).map(f => String(f.name).replace(/^\/+/, '')));
      }
    },
    {
      name: 'GitHub API',
      run: async () => {
        const r = await fetch('https://api.github.com/repos/' + C.owner + '/' + C.repo + '/git/trees/' + encodeURIComponent(C.ref) + '?recursive=1', { cache: 'no-cache' });
        if (!r.ok) throw Error('HTTP ' + r.status);
        const data = await r.json();
        if (data.truncated) throw Error('目录不完整');
        return toDocuments((data.tree || []).filter(x => x.type === 'blob').map(x => x.path));
      }
    }
  ];

  function toDocuments(paths) {
    const prefix = C.directory + '/';
    return paths
      .filter(p => p.startsWith(prefix) && /\.md$/i.test(p) && !p.slice(prefix.length).split('/').some(s => s.startsWith('.')))
      .map(p => {
        const path = p.slice(prefix.length), known = (F.documents || []).find(d => d.path === path);
        return { path, title: known?.title || path.split('/').pop().replace(/\.md$/i, ''), content: known?.content };
      })
      .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true }));
  }

  async function discover() {
    const cached = cacheGet('list');
    if (cached) return { docs: cached, via: '缓存' };
    let lastError;
    for (const lister of LISTERS) {
      try {
        const docs = await lister.run();
        if (!docs.length) throw Error('目录为空');
        cacheSet('list', docs.map(({ path, title }) => ({ path, title })));
        return { docs, via: lister.name };
      } catch (e) { lastError = e; }
    }
    throw lastError || Error('目录读取失败');
  }

  async function openDoc() {
    const id = selected() || documents[0]?.path || '';
    list();
    if (!id) { content.innerHTML = '<div class="empty">目录中还没有 Markdown 技术方案。</div>'; return; }
    const doc = documents.find(d => d.path === id);
    if (!doc) { content.innerHTML = '<div class="empty">未找到该文档，请从左侧选择。</div>'; toc.innerHTML = ''; return; }
    const version = ++token, source = raw(C.directory + '/' + doc.path);
    status.textContent = '正在读取 ' + doc.path;
    if (local && doc.content) { draw(doc.content, doc.path, '本地示例 · ' + doc.path, source); return; }
    try {
      const md = await text(C.directory + '/' + doc.path);
      if (version === token) draw(md, doc.path, doc.path, source);
    } catch (e) {
      if (version !== token) return;
      if (doc.content) draw(doc.content, doc.path, '读取失败，显示附带版本 · 可重试', source);
      else { content.innerHTML = '<div class="empty">文档读取失败，请点击重试。</div>'; status.textContent = '读取失败'; toc.innerHTML = ''; }
    }
  }

  async function load() {
    if (!technical) {
      const source = raw('README.md');
      if (local) { draw(F.readme, 'README.md', '本地 README 副本', source); return; }
      status.textContent = '正在读取 README.md';
      try { draw(await text('README.md'), 'README.md', 'README.md · ' + C.ref, source); }
      catch (e) { draw(F.readme, 'README.md', '读取失败，显示附带 README · 可重试', source); }
      return;
    }
    if (local) {
      $('#list-status').textContent = '本地附带索引；在线页面自动发现新增文件。';
      list(); await openDoc(); return;
    }
    $('#list-status').textContent = '正在读取仓库目录…';
    try {
      const { docs, via } = await discover();
      if (docs.length) documents = docs.map(d => ({ ...d }));
      $('#list-status').textContent = documents.length + ' 篇文档 · ' + C.ref + ' · ' + via;
    } catch (e) {
      $('#list-status').textContent = '目录读取失败，显示附带索引；可重试。' + (e && e.message ? '（' + e.message + '）' : '');
    }
    if (!selected() && documents[0]) history.replaceState(null, '', '#doc=' + encodeURIComponent(documents[0].path));
    list();
    await openDoc();
  }

  $('#retry').addEventListener('click', load);
  $('#doc-search')?.addEventListener('input', list);
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-heading]');
    if (a) { e.preventDefault(); document.getElementById(a.dataset.heading)?.scrollIntoView({ behavior: 'smooth' }); }
  });
  window.addEventListener('hashchange', () => { if (technical) openDoc(); });

  load();
})();
