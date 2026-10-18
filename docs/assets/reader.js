(function(){
'use strict';
const C=window.DOCS_CONFIG,F=window.DOCS_FALLBACK,M=window.Markdown;
const $=s=>document.querySelector(s),esc=M.escape,technical=document.body.dataset.view==='technical';
const content=$('#markdown'),toc=$('#toc'),status=$('#read-status'),local=location.protocol==='file:';
const pathEncode=p=>p.split('/').map(encodeURIComponent).join('/');
const raw=p=>'https://raw.githubusercontent.com/'+C.owner+'/'+C.repo+'/'+encodeURIComponent(C.ref)+'/'+pathEncode(p);
let documents=F.documents.map(d=>({...d})),token=0;
function selected(){return new URLSearchParams(location.hash.slice(1)).get('doc')||'';}
function normalize(path){let a=[];for(const p of path.split('/')){if(p==='..')a.pop();else if(p&&p!=='.')a.push(p);}return a.join('/');}
function resolve(url,img,path){
 if(/^(https?:|mailto:|#)/i.test(url))return url;
 let clean;try{clean=decodeURIComponent(url.split('#')[0]);}catch{return '#';}
 const target=normalize((path||'README.md').split('/').slice(0,-1).join('/')+'/'+clean);
 if(technical&&!img&&/\.md$/i.test(target))return '#doc='+encodeURIComponent(target);
 if(!technical&&!img&&target.startsWith('docs/technical/')){const rel=target.slice('docs/technical/'.length);if(!rel)return './technical/index.html';if(/\.md$/i.test(rel)&&!rel.startsWith('_'))return './technical/index.html#doc='+encodeURIComponent(rel);}
 return raw((technical?C.directory+'/':'')+target);
}
function draw(text,path,label,source){
 content.innerHTML=M.render(text,{resolve:(u,img)=>resolve(u,img,path)});status.textContent=label;$('#source-link').href=source;
 toc.innerHTML='<strong>本文目录</strong>'+Array.from(content.querySelectorAll('h2,h3')).map(h=>'<a href="#'+encodeURIComponent(h.id)+'" data-heading="'+esc(h.id)+'">'+esc(h.textContent)+'</a>').join('');
 document.title=(technical?(content.querySelector('h1')?.textContent||path):'pi-audit-harness')+' · 文档';
}
function list(){
 const q=($('#doc-search')?.value||'').toLowerCase(),current=selected();
 const visible=documents.filter(d=>(d.title+' '+d.path).toLowerCase().includes(q));
 $('#document-list').innerHTML=visible.map(d=>'<a class="document-link '+(d.path===current?'active':'')+'" href="#doc='+encodeURIComponent(d.path)+'">'+esc(d.title)+'<small>'+esc(d.path)+'</small></a>').join('')||'<p class="list-status">没有匹配的文档。</p>';
}
async function text(url){const r=await fetch(url,{cache:'no-cache'});if(!r.ok)throw Error('HTTP '+r.status);return r.text();}
async function openDoc(){
 const id=selected()||documents[0]?.path||'';list();if(!id){content.innerHTML='<div class="empty">目录中还没有 Markdown 技术方案。</div>';return;}
 const doc=documents.find(d=>d.path===id);if(!doc){content.innerHTML='<div class="empty">未找到该文档，请从左侧选择。</div>';toc.innerHTML='';return;}
 const version=++token,source=raw(C.directory+'/'+doc.path);status.textContent='正在读取 '+doc.path;
 if(local&&doc.content){draw(doc.content,doc.path,'本地示例 · '+doc.path,source);return;}
 try{const md=await text(source);if(version===token)draw(md,doc.path,doc.path,source);}
 catch{if(version!==token)return;if(doc.content)draw(doc.content,doc.path,'读取失败，显示附带版本 · 可重试',source);else{content.innerHTML='<div class="empty">文档读取失败，请点击重试。</div>';status.textContent='读取失败';toc.innerHTML='';}}
}
async function load(){
 if(!technical){
  const source=raw('README.md');if(local){draw(F.readme,'README.md','本地 README 副本',source);return;}
  status.textContent='正在读取 README.md';try{draw(await text(source),'README.md','README.md · '+C.ref,source);}catch{draw(F.readme,'README.md','读取失败，显示附带 README · 可重试',source);}return;
 }
 if(local){$('#list-status').textContent='本地附带索引；在线页面自动发现新增文件。';list();await openDoc();return;}
 $('#list-status').textContent='正在读取仓库目录…';
 try{
  const r=await fetch('https://api.github.com/repos/'+C.owner+'/'+C.repo+'/git/trees/'+encodeURIComponent(C.ref)+'?recursive=1',{cache:'no-cache'});if(!r.ok)throw Error('HTTP '+r.status);
  const data=await r.json();if(data.truncated)throw Error('目录不完整');const prefix=C.directory+'/';
  documents=data.tree.filter(x=>x.type==='blob'&&x.path.startsWith(prefix)&&/\.md$/i.test(x.path)&&!x.path.slice(prefix.length).split('/').some(p=>/^[_.]/.test(p))).map(x=>{const path=x.path.slice(prefix.length),known=F.documents.find(d=>d.path===path);return {path,title:known?.title||path.split('/').pop().replace(/\.md$/i,''),content:known?.content};}).sort((a,b)=>a.path.localeCompare(b.path,'zh-CN',{numeric:true}));
  $('#list-status').textContent=documents.length+' 篇文档 · '+C.ref;
 }catch{$('#list-status').textContent='目录读取失败，显示附带索引；可重试。';}
 if(!selected()&&documents[0])history.replaceState(null,'','#doc='+encodeURIComponent(documents[0].path));
 list();await openDoc();
}
$('#retry').addEventListener('click',load);$('#doc-search')?.addEventListener('input',list);
document.addEventListener('click',e=>{const a=e.target.closest('[data-heading]');if(a){e.preventDefault();document.getElementById(a.dataset.heading)?.scrollIntoView({behavior:'smooth'});}});
window.addEventListener('hashchange',()=>{if(technical)openDoc();});load();
})();
