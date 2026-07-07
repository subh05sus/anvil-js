import type { Middleware } from '../kernel/types.js';
import type { ListTracesOptions, TraceStore } from './types.js';

export interface DashboardOptions {
  /** Mount path. Default: '/_anvil'. */
  path?: string;
}

/**
 * Serve the local trace dashboard (PRD §6.6) as middleware — mount it in a
 * root `_middleware.ts`. Bundled, self-contained HTML (no external assets, no
 * frontend deps imposed on the user) at the base path, plus a small JSON API
 * the page fetches from.
 */
export function dashboardMiddleware(store: TraceStore, options: DashboardOptions = {}): Middleware {
  const base = (options.path ?? '/_anvil').replace(/\/$/, '');

  return async (ctx, next) => {
    const { path, method } = ctx;
    if (method !== 'GET' || (path !== base && !path.startsWith(base + '/'))) return next();

    if (path === base || path === base + '/') {
      return new Response(html(base), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (path === base + '/api/traces') {
      const opts: ListTracesOptions = { limit: Number(ctx.query.limit ?? 100) };
      const traces = await store.listTraces(opts);
      // List view: drop spans to keep the payload small.
      return Response.json(traces.map(({ spans: _spans, ...t }) => t));
    }
    const detail = path.match(new RegExp(`^${escapeRe(base)}/api/traces/([^/]+)$`));
    if (detail) {
      const trace = await store.getTrace(decodeURIComponent(detail[1]!));
      return trace ? Response.json(trace) : Response.json({ error: 'not found' }, { status: 404 });
    }
    return next();
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function html(base: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Anvil traces</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0f1115;color:#d6dae0}
header{padding:10px 16px;border-bottom:1px solid #232733;font-weight:600;color:#fff;display:flex;gap:10px;align-items:baseline}
header small{color:#7d8595;font-weight:400}
.wrap{display:flex;height:calc(100vh - 43px)}
.list{width:340px;border-right:1px solid #232733;overflow:auto}
.detail{flex:1;overflow:auto;padding:16px}
.row{padding:10px 14px;border-bottom:1px solid #1a1e27;cursor:pointer}
.row:hover{background:#161a22}.row.sel{background:#1b2130}
.row .n{color:#fff}.row .m{color:#7d8595;font-size:11px;margin-top:2px}
.badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px}
.ok{background:#12351f;color:#4ade80}.error{background:#3a1720;color:#f87171}.running,.aborted{background:#3a2f14;color:#fbbf24}
.span{margin:2px 0;padding:4px 8px;border-left:2px solid #2b3242;border-radius:0 4px 4px 0;background:#12151c}
.k{color:#60a5fa}.dur{color:#7d8595}
pre{white-space:pre-wrap;word-break:break-word;background:#0b0d11;padding:8px;border-radius:4px;color:#9aa4b2;margin:4px 0 0}
.stat{display:inline-block;margin-right:16px}.stat b{color:#fff}
</style></head><body>
<header>⚒ Anvil <small>trace dashboard</small></header>
<div class="wrap">
  <div class="list" id="list">loading…</div>
  <div class="detail" id="detail">Select a trace.</div>
</div>
<script>
const BASE=${JSON.stringify(base)};
const fmtDur=(a,b)=> (b&&a)?((b-a)+'ms'):'…';
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function loadList(){
  const r=await fetch(BASE+'/api/traces');const traces=await r.json();
  document.getElementById('list').innerHTML = traces.length? traces.map(t=>
    '<div class="row" data-id="'+t.id+'"><div class="n">'+esc(t.name)+' <span class="badge '+t.status+'">'+t.status+'</span></div>'+
    '<div class="m">'+fmtDur(t.startedAt,t.endedAt)+' · '+(t.totalInputTokens+t.totalOutputTokens)+' tok · $'+(t.totalCostUsd||0).toFixed(4)+'</div></div>'
  ).join('') : '<div class="row">No traces yet. Run an agent route.</div>';
  document.querySelectorAll('.row[data-id]').forEach(el=>el.onclick=()=>select(el.dataset.id,el));
}
async function select(id,el){
  document.querySelectorAll('.row').forEach(r=>r.classList.remove('sel'));el&&el.classList.add('sel');
  const r=await fetch(BASE+'/api/traces/'+id);const t=await r.json();
  const byParent={};(t.spans||[]).forEach(s=>{(byParent[s.parentId||'']=byParent[s.parentId||'']||[]).push(s)});
  const render=(pid,depth)=>(byParent[pid]||[]).map(s=>
    '<div class="span" style="margin-left:'+(depth*16)+'px">'+
    '<span class="k">'+esc(s.kind)+'</span> '+esc(s.name)+' <span class="badge '+s.status+'">'+s.status+'</span> '+
    '<span class="dur">'+fmtDur(s.startedAt,s.endedAt)+'</span>'+
    (s.attributes&&Object.keys(s.attributes).length?'<pre>'+esc(JSON.stringify(s.attributes,null,2))+'</pre>':'')+
    (s.error?'<pre>'+esc(s.error)+'</pre>':'')+
    '</div>'+render(s.id,depth+1)
  ).join('');
  document.getElementById('detail').innerHTML=
    '<h3>'+esc(t.name)+'</h3>'+
    '<div class="stat">tokens <b>'+(t.totalInputTokens+t.totalOutputTokens)+'</b></div>'+
    '<div class="stat">cost <b>$'+(t.totalCostUsd||0).toFixed(4)+'</b></div>'+
    '<div class="stat">status <b>'+t.status+'</b></div>'+
    '<div style="margin-top:12px">'+(render('',0)||'no spans')+'</div>';
}
loadList();setInterval(loadList,3000);
</script></body></html>`;
}
