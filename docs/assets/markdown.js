(function(root){
'use strict';
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function safe(s){s=String(s).trim().replace(/[\u0000-\u0020]/g,'');return /^(https?:|mailto:|#)/i.test(s)||!s.includes(':')?s:'#';}
function inline(text,opt){
 const slots=[],stash=s=>'\u0000'+(slots.push(s)-1)+'\u0000';
 text=String(text).replace(/\x60([^\x60]+)\x60/g,(_,s)=>stash('<code>'+esc(s)+'</code>'));
 text=text.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,(_,img,label,url)=>{
  const target=safe(opt.resolve?opt.resolve(safe(url),!!img):safe(url));
  return stash(img?'<img src="'+esc(target)+'" alt="'+esc(label)+'" loading="lazy">':'<a href="'+esc(target)+'">'+esc(label)+'</a>');
 });
 return esc(text).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\*([^*]+)\*/g,'<em>$1</em>').replace(/~~([^~]+)~~/g,'<del>$1</del>').replace(/\u0000(\d+)\u0000/g,(_,n)=>slots[Number(n)]);
}
function render(md,opt={}){
 const used=new Map(),inl=s=>inline(s,opt),cells=s=>s.trim().replace(/^\||\|$/g,'').split('|').map(x=>x.trim());
 function blocks(a){
  let out='',i=0;
  while(i<a.length){
   const l=a[i];if(!l.trim()){i++;continue;}
   const fence=l.match(/^ {0,3}(\x60{3,}|~{3,})(.*)$/);
   if(fence){let body=[];i++;while(i<a.length&&!new RegExp('^ {0,3}'+fence[1][0]+'{'+fence[1].length+',}\\s*$').test(a[i]))body.push(a[i++]);if(i<a.length)i++;out+='<pre><code class="language-'+esc(fence[2].trim().split(/\s/)[0])+'">'+esc(body.join('\n'))+'</code></pre>';continue;}
   const h=l.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
   if(h){const base=h[2].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu,'').trim().replace(/\s+/g,'-')||'section',n=used.get(base)||0;used.set(base,n+1);out+='<h'+h[1].length+' id="'+esc(base+(n?'-'+n:''))+'">'+inl(h[2])+'</h'+h[1].length+'>';i++;continue;}
   if(/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(l)){out+='<hr>';i++;continue;}
   if(/^ {0,3}>/.test(l)){let q=[];while(i<a.length&&/^ {0,3}>/.test(a[i]))q.push(a[i++].replace(/^ {0,3}> ?/,''));out+='<blockquote>'+blocks(q)+'</blockquote>';continue;}
   if(i+1<a.length&&l.includes('|')&&/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(a[i+1])){
    const heads=cells(l);i+=2;let rows=[];while(i<a.length&&a[i].includes('|')&&a[i].trim())rows.push(cells(a[i++]));
    out+='<div class="table-scroll"><table><thead><tr>'+heads.map(x=>'<th>'+inl(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+heads.map((_,k)=>'<td>'+inl(r[k]||'')+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';continue;
   }
   const list=l.match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/);
   if(list){
    const indent=list[1].length,ordered=/^\d/.test(list[2]),tag=ordered?'ol':'ul';let items=[];
    while(i<a.length){
     const m=a[i].match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/);
     if(!m||m[1].length!==indent||/^\d/.test(m[2])!==ordered)break;
     let body=[m[3]];i++;
     while(i<a.length&&a[i].trim()){
      const lead=(a[i].match(/^\s*/)||[''])[0].length;if(lead<=indent)break;
      body.push(a[i++].slice(Math.min(indent+2,lead)));
     }
     items.push('<li>'+blocks(body)+'</li>');
     if(i<a.length&&!a[i].trim())i++;
    }
    out+='<'+tag+'>'+items.join('')+'</'+tag+'>';continue;
   }
   let p=[l];i++;while(i<a.length&&a[i].trim()&&!/^ {0,3}(#{1,6}\s|>|\x60{3,}|~{3,}|[-+*]\s|\d+[.)]\s)/.test(a[i])&&!(i+1<a.length&&a[i].includes('|')&&/^\s*\|?\s*:?-{3,}/.test(a[i+1])))p.push(a[i++]);
   out+='<p>'+inl(p.join('\n')).replace(/ {2}\n/g,'<br>')+'</p>';
  }return out;
 }return blocks(String(md).replace(/\r\n?/g,'\n').split('\n'));
}
root.Markdown={render,escape:esc};
})(globalThis);
