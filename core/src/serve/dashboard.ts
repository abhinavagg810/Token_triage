import type { ConnectInfo } from "./server.js";

/**
 * The dashboard SPA — one self-contained HTML string, no CDN, no framework.
 * Data arrives from the local /api/* endpoints; every dynamic value is rendered
 * with textContent (never innerHTML) so database content can never be
 * interpreted as markup. The only server-injected value is the Connect config
 * (host/port numbers chosen by the operator), embedded as JSON.
 */
export function renderDashboard(connect: ConnectInfo = { mode: "serve" }): string {
  const connectJson = JSON.stringify({
    mode: connect.mode,
    host: connect.host ?? "127.0.0.1",
    proxyPort: connect.proxyPort ?? 8484,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TokenTriage — live LLM cost dashboard</title>
<style>
:root{
  --bg:#0a0c10; --bg2:#0e1117; --panel:#13161d; --panel2:#181c25; --raised:#1d222c;
  --border:#262c38; --border2:#323a48; --text:#eef2f7; --text2:#aab4c2; --dim:#6b7689;
  --accent:#34d399; --accent-dim:#0f3b2e; --warn:#fbbf24; --bad:#fb7185; --blue:#60a5fa;
  --purple:#a78bfa; --cyan:#22d3ee; --orange:#fb923c;
  --shadow:0 1px 3px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.25);
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{
  background:var(--bg);color:var(--text);
  font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background-image:radial-gradient(900px 500px at 12% -8%,rgba(52,211,153,.07),transparent 60%),
                   radial-gradient(800px 500px at 92% -4%,rgba(96,165,250,.07),transparent 55%);
  background-attachment:fixed;-webkit-font-smoothing:antialiased;
}
.wrap{max-width:1200px;margin:0 auto;padding:0 20px 64px}

/* top bar */
.topbar{position:sticky;top:0;z-index:20;backdrop-filter:blur(12px);
  background:rgba(10,12,16,.78);border-bottom:1px solid var(--border);
  display:flex;align-items:center;gap:14px;padding:14px 20px;margin:0 -20px 26px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px;letter-spacing:-.2px}
.brand .mark{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;
  background:linear-gradient(135deg,#34d399,#22d3ee);color:#06251c;font-weight:900;font-size:15px;
  box-shadow:0 0 0 1px rgba(52,211,153,.3),0 4px 14px rgba(52,211,153,.25)}
.brand small{color:var(--dim);font-weight:500;font-size:12px}
.spacer{flex:1}
/* live pill */
.live{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:600;
  padding:6px 12px;border-radius:99px;border:1px solid var(--border2);background:var(--panel2);color:var(--text2)}
.live .dot{width:8px;height:8px;border-radius:50%;background:var(--dim);flex:none}
.live.on{color:var(--accent);border-color:rgba(52,211,153,.4);background:rgba(52,211,153,.08)}
.live.on .dot{background:var(--accent);box-shadow:0 0 0 0 rgba(52,211,153,.6);animation:pulse 1.6s infinite}
.live.idle{color:var(--warn);border-color:rgba(251,191,36,.35);background:rgba(251,191,36,.07)}
.live.idle .dot{background:var(--warn)}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.5)}70%{box-shadow:0 0 0 7px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}

.sub{color:var(--dim);font-size:12.5px;margin:-8px 0 22px}

/* connect panel */
.connect{background:linear-gradient(135deg,rgba(52,211,153,.08),rgba(96,165,250,.06)),var(--panel);
  border:1px solid var(--border2);border-radius:16px;padding:22px 24px;margin-bottom:22px;box-shadow:var(--shadow)}
.connect h2{font-size:15px;font-weight:700;margin-bottom:4px;letter-spacing:-.2px}
.connect .lead{color:var(--text2);font-size:13px;margin-bottom:16px}
.tabs{display:inline-flex;gap:4px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:4px;margin-bottom:14px}
.tab{border:0;background:transparent;color:var(--text2);font-size:12.5px;font-weight:600;
  padding:7px 16px;border-radius:7px;cursor:pointer;transition:.15s}
.tab.active{background:var(--raised);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.3)}
.codeblock{position:relative;background:#06080c;border:1px solid var(--border);border-radius:10px;
  padding:14px 50px 14px 16px;font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#cfe3d8;overflow-x:auto;white-space:pre}
.codeblock .cmt{color:var(--dim)}
.codeblock .var{color:var(--cyan)}
.copybtn{position:absolute;top:10px;right:10px;background:var(--raised);border:1px solid var(--border2);
  color:var(--text2);font-size:11px;font-weight:600;padding:5px 11px;border-radius:7px;cursor:pointer;transition:.15s}
.copybtn:hover{color:var(--text);border-color:var(--dim)}
.copybtn.ok{color:var(--accent);border-color:rgba(52,211,153,.4)}
.connect .hint{color:var(--dim);font-size:12px;margin-top:12px}
.connect .hint code{background:var(--bg2);padding:1px 6px;border-radius:5px;color:var(--text2)}

/* KPI row */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:22px}
.kpi{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:18px 20px;
  position:relative;overflow:hidden;transition:transform .15s,border-color .15s}
.kpi:hover{transform:translateY(-1px);border-color:var(--border2)}
.kpi .accent{position:absolute;left:0;top:0;bottom:0;width:3px;border-radius:3px 0 0 3px}
.kpi .v{font-size:28px;font-weight:800;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
.kpi .l{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.9px;margin-top:3px;font-weight:600}
.kpi .v.waste{color:var(--bad)} .kpi .v.save{color:var(--accent)}
.kpi.spotlight{background:linear-gradient(135deg,rgba(52,211,153,.1),var(--panel))}

/* cards */
.section-title{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:700;
  letter-spacing:-.1px;margin:28px 2px 12px;color:var(--text)}
.section-title .pill{font-size:10.5px;font-weight:700;color:var(--dim);background:var(--panel2);
  border:1px solid var(--border);padding:2px 9px;border-radius:99px;letter-spacing:.4px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:18px 22px;margin-bottom:14px;box-shadow:var(--shadow)}
.card h3{font-size:11.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.8px;margin-bottom:14px;font-weight:700;
  display:flex;justify-content:space-between;align-items:center}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:860px){.grid{grid-template-columns:1fr}.topbar{flex-wrap:wrap}}

/* filters */
.filters{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:8px}
.filters label{color:var(--dim);font-size:12px;display:inline-flex;align-items:center;gap:6px}
.filters input,.filters select,.miniselect{background:var(--bg2);border:1px solid var(--border);color:var(--text);
  border-radius:8px;padding:7px 11px;font-size:12.5px;font-family:inherit}
.filters input:focus,.filters select:focus{outline:none;border-color:var(--accent)}
.btn{background:var(--raised);border:1px solid var(--border2);color:var(--text);border-radius:8px;
  padding:7px 16px;font-size:12.5px;font-weight:600;cursor:pointer;transition:.15s;font-family:inherit}
.btn:hover{border-color:var(--dim)}
.btn.primary{background:linear-gradient(135deg,#34d399,#22d3ee);color:#06251c;border:0}

/* findings */
.finding{position:relative;border:1px solid var(--border);border-radius:12px;padding:16px 18px 16px 22px;
  margin-bottom:12px;background:var(--panel2);overflow:hidden;transition:border-color .15s}
.finding:hover{border-color:var(--border2)}
.finding .rail{position:absolute;left:0;top:0;bottom:0;width:4px}
.finding.high .rail{background:var(--bad)} .finding.medium .rail{background:var(--warn)} .finding.low .rail{background:var(--blue)}
.finding .head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.finding .rank{color:var(--dim);font-weight:700;font-variant-numeric:tabular-nums}
.finding .name{font-weight:700;font-size:15px;letter-spacing:-.2px}
.finding .amount{color:var(--bad);font-weight:800;font-variant-numeric:tabular-nums}
.finding .save{margin-left:auto;color:var(--accent);font-weight:700;font-size:13px}
.badge{font-size:10px;padding:3px 9px;border-radius:99px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
.badge.high{background:rgba(251,113,133,.14);color:var(--bad)}
.badge.medium{background:rgba(251,191,36,.14);color:var(--warn)}
.badge.low{background:rgba(96,165,250,.14);color:var(--blue)}
.pctbar{height:6px;background:var(--bg2);border-radius:99px;overflow:hidden;margin:12px 0 4px}
.pctbar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--bad),var(--orange));transition:width .6s ease}
.evlist{margin:12px 0 0;padding:0;list-style:none}
.evlist li{font-size:12.5px;color:var(--text2);padding:5px 0;border-top:1px solid var(--border)}
.evlist li b{color:var(--text);font-weight:600}
.evlist code{background:var(--bg2);padding:1px 6px;border-radius:5px;font-size:12px}
details.fix{margin-top:12px}
details.fix summary{cursor:pointer;color:var(--accent);font-size:12.5px;font-weight:600;list-style:none;user-select:none}
details.fix summary::-webkit-details-marker{display:none}
details.fix summary::before{content:"▸ ";transition:.15s;display:inline-block}
details.fix[open] summary::before{transform:rotate(90deg)}
details.fix p{color:var(--text2);font-size:13px;margin:10px 0}
details.fix ol{margin:8px 0 10px 20px;font-size:12.5px;color:var(--text2)}
details.fix ol li{margin-bottom:4px}
.snippet{position:relative;background:#06080c;border:1px solid var(--border);border-radius:10px;margin-top:8px}
.snippet pre{padding:14px 16px;overflow-x:auto;font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#d6e2f0;white-space:pre}

/* tables */
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{text-align:left;color:var(--dim);font-weight:700;font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;padding:8px 10px;border-bottom:1px solid var(--border)}
td{padding:8px 10px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums;color:var(--text2)}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:var(--panel2);color:var(--text)}
td.num,th.num{text-align:right}
td .chip{font-size:11px;padding:1px 7px;border-radius:6px;background:var(--bg2);color:var(--text2)}
td code{font-size:11.5px;color:var(--text2)}

/* bars */
.barrow{margin-bottom:13px}
.barrow .line{display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:5px}
.barrow .line .lbl{font-weight:600;color:var(--text)}
.bar{height:8px;background:var(--bg2);border-radius:99px;overflow:hidden}
.bar i{display:block;height:100%;border-radius:99px;transition:width .6s ease}

.pager{display:flex;gap:8px;align-items:center;margin-top:12px;font-size:12px;color:var(--dim)}
.pager .btn{padding:5px 12px}
.pager .btn:disabled{opacity:.35;cursor:default}
svg text{font:10px -apple-system,"Segoe UI",sans-serif;fill:var(--dim)}
.muted{color:var(--dim);font-size:13px}
.empty{text-align:center;color:var(--dim);padding:18px;font-size:13px}
.foot{color:var(--dim);font-size:12px;margin-top:30px;border-top:1px solid var(--border);padding-top:16px;line-height:1.7}
.foot b{color:var(--text2)}
.fade{animation:fade .4s ease}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.flash{animation:flash 1s ease}
@keyframes flash{0%{background:rgba(52,211,153,.18)}100%{background:transparent}}
</style>
</head>
<body>
<div class="topbar">
  <div class="brand"><span class="mark">▲</span> TokenTriage <small>live cost auditor</small></div>
  <div class="spacer"></div>
  <div class="live" id="live"><span class="dot"></span><span id="live-text">connecting…</span></div>
</div>

<div class="wrap">
<div class="sub" id="sub">loading…</div>

<div class="connect" id="connect"></div>

<div class="kpis" id="kpis"></div>

<div class="section-title">Why your bill is high <span class="pill" id="findings-count"></span></div>
<div id="findings"></div>

<div class="section-title">Spend over time</div>
<div class="card"><h3>Daily spend (USD)</h3><div id="daily"></div></div>

<div class="section-title">Breakdown</div>
<div class="grid">
  <div class="card"><h3>By model</h3><div id="models"></div></div>
  <div class="card"><h3>By service <span class="muted" style="font-size:11px;text-transform:none">tag with x-tokentriage-service</span></h3><div id="services"></div></div>
</div>

<div class="section-title">Sessions &amp; requests</div>
<div class="card">
  <h3>Top sessions
    <select id="s-metric" class="miniselect">
      <option value="cost">by cost</option><option value="growth">by growth</option><option value="turns">by turns</option>
    </select>
  </h3>
  <div id="sessions"></div>
</div>
<div class="card">
  <h3>Request explorer</h3>
  <div class="filters" style="margin-bottom:14px">
    <label>From <input type="date" id="f-start"></label>
    <label>To <input type="date" id="f-end"></label>
    <label>Model <select id="f-model"><option value="">all</option></select></label>
    <label>Service <select id="f-service"><option value="">all</option></select></label>
    <button class="btn" id="f-apply">Apply</button>
    <button class="btn" id="f-clear">Clear</button>
  </div>
  <div id="requests"></div>
  <div class="pager">
    <button class="btn" id="r-prev">‹ Prev</button>
    <span id="r-page"></span>
    <button class="btn" id="r-next">Next ›</button>
  </div>
</div>

<div class="section-title">Self-audit</div>
<div class="card"><h3>Agent runs — TokenTriage's own token usage</h3><div id="agentruns"></div></div>

<div class="foot">
  <b>Local &amp; private.</b> This dashboard reads a read-only database on this machine. It holds hashes and token counts — never prompt or response content, never API keys. Nothing is sent anywhere.
</div>
</div>

<script>
"use strict";
const CONNECT = ${connectJson};
const $ = (id) => document.getElementById(id);
const state = { start:"", end:"", model:"", service:"", offset:0, limit:50, metric:"cost", generatedAt:"", lastCount:-1, lastChange:0 };

async function j(path, params){
  const u = new URL(path, location.origin);
  for (const [k,v] of Object.entries(params||{})) if (v!=="" && v!=null) u.searchParams.set(k,v);
  const r = await fetch(u);
  if (!r.ok) throw new Error(path+" -> "+r.status);
  return r.json();
}
function el(tag,text,cls){ const e=document.createElement(tag); if(text!=null)e.textContent=text; if(cls)e.className=cls; return e; }
function usd(n,d){ return "$"+Number(n).toLocaleString("en-US",{minimumFractionDigits:d??2,maximumFractionDigits:d??2}); }
function clear(node){ while(node.firstChild) node.removeChild(node.firstChild); }
function qfilters(){ return {start:state.start,end:state.end,model:state.model,service:state.service}; }
const COLORS=["#34d399","#60a5fa","#a78bfa","#fbbf24","#fb7185","#22d3ee","#fb923c","#a3e635","#f472b6","#818cf8"];

/* ---------- connect panel ---------- */
function renderConnect(){
  const root=$("connect"); clear(root);
  const live = CONNECT.mode==="watch";
  const base = "http://"+CONNECT.host+":"+CONNECT.proxyPort;
  root.appendChild(el("h2", live ? "Connect your app — live capture is running" : "Connect your app for live capture"));
  const lead=el("p",null,"lead");
  lead.textContent = live
    ? "Point your Claude or OpenAI SDK at the address below. Requests pass straight through to the provider; usage shows up here automatically."
    : "This is a static snapshot. For live tracking, run \\u0060tokentriage watch\\u0060 and point your SDK at the capture proxy it prints.";
  root.appendChild(lead);

  const tabs=el("div",null,"tabs");
  const providers=[["claude","Claude / Anthropic","ANTHROPIC_BASE_URL",base],
                   ["openai","OpenAI","OPENAI_BASE_URL",base+"/v1"]];
  const code=el("div",null,"codeblock");
  const copy=el("button","Copy","copybtn");
  function show(p){
    const isWin = false;
    const exportCmd = "export "+p[2]+"="+p[3];
    clear(code); code.appendChild(copy);
    const c1=el("span","# 1. start the auditor (one time)\\n","cmt");
    const c2=el("span","tokentriage watch\\n\\n");
    const c3=el("span","# 2. tell your app to route through it\\n","cmt");
    const c4=el("span",exportCmd+"\\n","var");
    const c5=el("span","#    (PowerShell:  $env:"+p[2]+'="'+p[3]+'")',"cmt");
    code.append(c1,c2,c3,c4,c5);
    copy.dataset.text = exportCmd;
  }
  providers.forEach((p,i)=>{
    const t=el("button",p[1],"tab"+(i===0?" active":""));
    t.addEventListener("click",()=>{ tabs.querySelectorAll(".tab").forEach(x=>x.classList.remove("active")); t.classList.add("active"); show(p); });
    tabs.appendChild(t);
  });
  copy.addEventListener("click",()=>{
    const txt=copy.dataset.text||"";
    (navigator.clipboard?.writeText(txt)||Promise.reject()).then(ok,ok).catch(ok);
    function ok(){ copy.textContent="Copied ✓"; copy.classList.add("ok"); setTimeout(()=>{copy.textContent="Copy";copy.classList.remove("ok");},1500); }
  });
  root.appendChild(tabs);
  root.appendChild(code);
  show(providers[0]);

  const hint=el("p",null,"hint");
  if (live){
    hint.innerHTML="";
    hint.appendChild(document.createTextNode("No app handy? Generate sample traffic with your key: "));
    const c=el("code","tokentriage test-traffic --key sk-ant-…"); hint.appendChild(c);
  } else {
    hint.textContent="Already have logs from Helicone/Langfuse? Run: tokentriage analyze logs.jsonl --db audit.db";
  }
  root.appendChild(hint);
}

/* ---------- live status ---------- */
function setLive(reqCount){
  const pill=$("live"), txt=$("live-text");
  if (CONNECT.mode!=="watch"){
    pill.className="live"; txt.textContent="static snapshot"; return;
  }
  const now=Date.now();
  if (state.lastCount>=0 && reqCount>state.lastCount){ state.lastChange=now; }
  state.lastCount=reqCount;
  const sinceChange = now-(state.lastChange||0);
  if (state.lastChange && sinceChange<45000){ pill.className="live on"; txt.textContent="LIVE · "+reqCount.toLocaleString()+" captured"; }
  else if (reqCount>0){ pill.className="live idle"; txt.textContent="watching · idle"; }
  else { pill.className="live idle"; txt.textContent="watching · waiting for traffic"; }
}

/* ---------- KPIs ---------- */
function kpi(value,label,cls,spotlight){
  const k=el("div",null,"kpi"+(spotlight?" spotlight":""));
  const a=el("div",null,"accent"); a.style.background=cls==="waste"?"var(--bad)":cls==="save"?"var(--accent)":"var(--blue)";
  k.appendChild(a);
  k.appendChild(el("div",value,"v"+(cls?" "+cls:"")));
  k.appendChild(el("div",label,"l"));
  return k;
}
async function loadHeader(){
  const {meta,counts}=await j("/api/meta");
  state.generatedAt=meta.generated_at||"";
  const reqs=Number(meta.request_count)||0;
  $("sub").textContent = (meta.period_start&&meta.period_start!=="unknown")
    ? meta.period_start+" → "+meta.period_end+" · "+meta.days_in_dataset+" days · updated "+(meta.generated_at||"").slice(11,19)+" UTC"
    : "waiting for the first requests…";
  const total=Number(meta.total_spend_usd),waste=Number(meta.addressable_waste_usd);
  const monthly=waste*(30/Math.max(1,Number(meta.days_in_dataset)));
  const k=$("kpis"); clear(k);
  k.appendChild(kpi(reqs.toLocaleString(),"Requests captured"));
  k.appendChild(kpi(usd(total),"Total spend"));
  k.appendChild(kpi(usd(waste)+(total>0?"  ("+((waste/total)*100).toFixed(0)+"%)":""),"Addressable waste","waste"));
  k.appendChild(kpi("~"+usd(monthly,0)+"/mo","Potential savings","save",true));
  k.appendChild(kpi(String(counts.sessions),"Sessions"));
  setLive(reqs);
}

/* ---------- findings ---------- */
async function loadFindings(){
  const findings=await j("/api/findings");
  const root=$("findings"); clear(root);
  $("findings-count").textContent = findings.length ? findings.length+" found" : "none yet";
  if(!findings.length){
    const e=el("div",null,"card");
    e.appendChild(el("div","No waste over $0.01 detected yet. Send more traffic, or connect a real app — analyzers ignore sub-cent amounts on purpose.","empty"));
    root.appendChild(e); return;
  }
  findings.forEach((f,i)=>{
    const card=el("div",null,"finding "+f.confidence+" fade");
    card.appendChild(el("span",null,"rail"));
    const head=el("div",null,"head");
    head.appendChild(el("span","#"+(i+1),"rank"));
    head.appendChild(el("span",f.name,"name"));
    head.appendChild(el("span",usd(f.wasted_usd),"amount"));
    head.appendChild(el("span",f.confidence,"badge "+f.confidence));
    head.appendChild(el("span",(f.upper_bound?"up to ":"~")+usd(f.projected_monthly_savings_usd,0)+"/mo","save"));
    card.appendChild(head);
    const bar=el("div",null,"pctbar"); const fill=el("i");
    fill.style.width=Math.min(100,(f.pct_of_total*100)*1.5).toFixed(1)+"%"; bar.appendChild(fill);
    card.appendChild(bar);
    card.appendChild(el("div",(f.pct_of_total*100).toFixed(1)+"% of total spend","muted"));
    const ev=el("ul",null,"evlist");
    f.evidence.forEach(e=>{ const li=el("li"); const b=el("b",e.label+": "); li.appendChild(b); li.appendChild(document.createTextNode(e.detail)); ev.appendChild(li); });
    card.appendChild(ev);
    const det=el("details",null,"fix");
    det.appendChild(el("summary","How to fix this"));
    det.appendChild(el("p",f.fix.summary));
    if(f.fix.steps&&f.fix.steps.length){ const ol=el("ol"); f.fix.steps.forEach(s=>ol.appendChild(el("li",s))); det.appendChild(ol); }
    if(f.fix.snippet){
      const sn=el("div",null,"snippet");
      const cb=el("button","Copy","copybtn"); cb.dataset.text=f.fix.snippet;
      cb.addEventListener("click",()=>{ (navigator.clipboard?.writeText(f.fix.snippet)||Promise.reject()).then(ok,ok).catch(ok);
        function ok(){cb.textContent="Copied ✓";cb.classList.add("ok");setTimeout(()=>{cb.textContent="Copy";cb.classList.remove("ok");},1500);} });
      sn.appendChild(cb); sn.appendChild(el("pre",f.fix.snippet)); det.appendChild(sn);
    }
    card.appendChild(det);
    root.appendChild(card);
  });
}

/* ---------- charts ---------- */
function areaSvg(points,width,height){
  const NS="http://www.w3.org/2000/svg";
  const svg=document.createElementNS(NS,"svg");
  svg.setAttribute("viewBox","0 0 "+width+" "+height); svg.setAttribute("width","100%");
  if(points.length<2){ const t=document.createElementNS(NS,"text"); t.setAttribute("x","12");t.setAttribute("y","24");t.textContent="not enough data points yet"; svg.appendChild(t); return svg; }
  const max=Math.max(...points.map(p=>p.v),0.0001);
  const padL=46,padB=22,padT=10;
  const x=i=>padL+(i/(points.length-1))*(width-padL-12);
  const y=v=>padT+(1-v/max)*(height-padT-padB);
  const grad=document.createElementNS(NS,"linearGradient"); grad.id="ag"; grad.setAttribute("x1","0");grad.setAttribute("y1","0");grad.setAttribute("x2","0");grad.setAttribute("y2","1");
  [["0","#34d399","0.35"],["1","#34d399","0"]].forEach(s=>{const st=document.createElementNS(NS,"stop");st.setAttribute("offset",s[0]);st.setAttribute("stop-color",s[1]);st.setAttribute("stop-opacity",s[2]);grad.appendChild(st);});
  const defs=document.createElementNS(NS,"defs"); defs.appendChild(grad); svg.appendChild(defs);
  [0,0.5,1].forEach(f=>{ const ln=document.createElementNS(NS,"line");
    ln.setAttribute("x1",padL);ln.setAttribute("x2",width-12);ln.setAttribute("y1",y(max*f));ln.setAttribute("y2",y(max*f));
    ln.setAttribute("stroke","#262c38");ln.setAttribute("stroke-dasharray","3,4");svg.appendChild(ln);
    const tx=document.createElementNS(NS,"text");tx.setAttribute("x",padL-6);tx.setAttribute("y",y(max*f)+3);tx.setAttribute("text-anchor","end");
    tx.textContent="$"+(max*f>=10?(max*f).toFixed(0):(max*f).toFixed(2));svg.appendChild(tx); });
  const line=points.map((p,i)=>x(i).toFixed(1)+","+y(p.v).toFixed(1)).join(" ");
  const area=document.createElementNS(NS,"polygon");
  area.setAttribute("points",padL+","+y(0)+" "+line+" "+x(points.length-1)+","+y(0));
  area.setAttribute("fill","url(#ag)");svg.appendChild(area);
  const poly=document.createElementNS(NS,"polyline");
  poly.setAttribute("points",line);poly.setAttribute("fill","none");poly.setAttribute("stroke","#34d399");poly.setAttribute("stroke-width","2");poly.setAttribute("stroke-linejoin","round");svg.appendChild(poly);
  const step=Math.max(1,Math.ceil(points.length/8));
  points.forEach((p,i)=>{ if(i%step)return; const tx=document.createElementNS(NS,"text");
    tx.setAttribute("x",x(i));tx.setAttribute("y",height-4);tx.setAttribute("text-anchor","middle");tx.textContent=p.label.slice(5);svg.appendChild(tx);});
  return svg;
}
async function loadDaily(){
  const rows=await j("/api/daily",{start:state.start,end:state.end});
  const root=$("daily"); clear(root);
  if(!rows.length){ root.appendChild(el("div","No dated data yet.","empty")); return; }
  root.appendChild(areaSvg(rows.map(r=>({label:r.date,v:r.usd})),1100,180));
}
async function loadBars(path,root,labelKey){
  const rows=await j(path,qfilters()); clear(root);
  if(!rows.length){ root.appendChild(el("div","No data.","empty")); return rows; }
  const max=Math.max(...rows.map(r=>r.usd),0);
  rows.slice(0,10).forEach((r,i)=>{
    const w=el("div",null,"barrow");
    const line=el("div",null,"line");
    line.appendChild(el("span",r[labelKey]||"(none)","lbl"));
    line.appendChild(el("span",usd(r.usd)+" · "+Number(r.requests).toLocaleString()+" req","muted"));
    const bar=el("div",null,"bar"); const fill=el("i");
    fill.style.width=(max>0?(r.usd/max)*100:0).toFixed(1)+"%"; fill.style.background=COLORS[i%COLORS.length];
    bar.appendChild(fill); w.appendChild(line); w.appendChild(bar); root.appendChild(w);
  });
  return rows;
}
function tableEl(headers,rows,render){
  const t=el("table"); const thead=el("thead"); const tr=el("tr");
  headers.forEach(h=>tr.appendChild(el("th",h[0],h[1]?"num":""))); thead.appendChild(tr); t.appendChild(thead);
  const tb=el("tbody"); rows.forEach(r=>tb.appendChild(render(r))); t.appendChild(tb); return t;
}
async function loadSessions(){
  const rows=await j("/api/sessions",{metric:state.metric,limit:10});
  const root=$("sessions"); clear(root);
  if(!rows.length){ root.appendChild(el("div","No multi-turn sessions yet.","empty")); return; }
  root.appendChild(tableEl([["Session"],["Turns",1],["Input growth",1],["Cost",1],["Inferred"]],rows,s=>{
    const tr=el("tr");
    const idtd=el("td"); idtd.appendChild(el("code",s.id)); tr.appendChild(idtd);
    tr.appendChild(el("td",String(s.turns),"num"));
    tr.appendChild(el("td",Number(s.first_input_tokens).toLocaleString()+" → "+Number(s.last_input_tokens).toLocaleString(),"num"));
    tr.appendChild(el("td",usd(s.total_cost_usd),"num"));
    const c=el("td"); if(s.inferred){const ch=el("span","inferred","chip");c.appendChild(ch);} tr.appendChild(c);
    return tr;
  }));
}
async function loadRequests(){
  const data=await j("/api/requests",{...qfilters(),limit:state.limit,offset:state.offset});
  const root=$("requests"); clear(root);
  if(!data.rows.length){ root.appendChild(el("div","No requests match.","empty")); }
  else root.appendChild(tableEl([["Time"],["Model"],["Service"],["In",1],["Out",1],["Cached",1],["Status",1],["Cost",1]],data.rows,r=>{
    const tr=el("tr");
    tr.appendChild(el("td",String(r.timestamp).slice(0,19).replace("T"," ")));
    const m=el("td"); m.appendChild(el("code",r.model)); tr.appendChild(m);
    tr.appendChild(el("td",r.service||"—"));
    tr.appendChild(el("td",Number(r.input_tokens).toLocaleString(),"num"));
    tr.appendChild(el("td",Number(r.output_tokens).toLocaleString(),"num"));
    const cached=el("td",Number(r.cache_read_tokens).toLocaleString(),"num");
    if(r.cache_read_tokens>0) cached.style.color="var(--accent)";
    tr.appendChild(cached);
    const st=el("td",String(r.status),"num"); if(r.status>=400)st.style.color="var(--bad)"; tr.appendChild(st);
    tr.appendChild(el("td",usd(r.cost_usd,4),"num"));
    return tr;
  }));
  const page=Math.floor(state.offset/state.limit)+1;
  const pages=Math.max(1,Math.ceil(data.total/state.limit));
  $("r-page").textContent="page "+page+" / "+pages+" · "+data.total.toLocaleString()+" requests";
  $("r-prev").disabled=state.offset===0;
  $("r-next").disabled=state.offset+state.limit>=data.total;
}
async function loadAgentRuns(){
  const rows=await j("/api/agent_runs");
  const root=$("agentruns"); clear(root);
  if(!rows.length){ root.appendChild(el("div","No agent runs yet. The Q&A/investigation agent logs its own usage here.","empty")); return; }
  root.appendChild(tableEl([["Started"],["Kind"],["Model"],["Question"],["In",1],["Out",1],["LLM calls",1]],rows,r=>{
    const tr=el("tr");
    tr.appendChild(el("td",String(r.started_at).slice(0,19).replace("T"," ")));
    const k=el("td"); k.appendChild(el("span",r.kind,"chip")); tr.appendChild(k);
    const m=el("td"); m.appendChild(el("code",r.model)); tr.appendChild(m);
    tr.appendChild(el("td",r.question||""));
    tr.appendChild(el("td",Number(r.input_tokens).toLocaleString(),"num"));
    tr.appendChild(el("td",Number(r.output_tokens).toLocaleString(),"num"));
    tr.appendChild(el("td",String(r.llm_calls),"num"));
    return tr;
  }));
}
async function populateFilterOptions(){
  for(const id of ["f-model","f-service"]){ const sel=$(id); while(sel.options.length>1) sel.remove(1); }
  const [models,services]=await Promise.all([j("/api/models",{}),j("/api/services",{})]);
  models.forEach(m=>{ const o=el("option",m.model); o.value=m.model; $("f-model").appendChild(o); });
  services.forEach(s=>{ const o=el("option",s.service); o.value=s.service; $("f-service").appendChild(o); });
}
async function refresh(){
  await Promise.all([loadDaily(),loadBars("/api/models",$("models"),"model"),loadBars("/api/services",$("services"),"service"),loadSessions(),loadRequests()]);
}

$("f-apply").addEventListener("click",()=>{ state.start=$("f-start").value;state.end=$("f-end").value;state.model=$("f-model").value;state.service=$("f-service").value;state.offset=0;refresh(); });
$("f-clear").addEventListener("click",()=>{ state.start=state.end=state.model=state.service="";state.offset=0;$("f-start").value=$("f-end").value="";$("f-model").value=$("f-service").value="";refresh(); });
$("s-metric").addEventListener("change",e=>{ state.metric=e.target.value; loadSessions(); });
$("r-prev").addEventListener("click",()=>{ state.offset=Math.max(0,state.offset-state.limit); loadRequests(); });
$("r-next").addEventListener("click",()=>{ state.offset+=state.limit; loadRequests(); });

renderConnect();
(async()=>{ try{ await loadHeader(); await Promise.all([loadFindings(),populateFilterOptions(),loadAgentRuns()]); await refresh(); }
  catch(err){ $("sub").textContent="Failed to load: "+err.message; } })();

/* live polling: cheap meta check; full reload only when the export actually changed */
setInterval(async()=>{
  try{
    const {meta}=await j("/api/meta");
    setLive(Number(meta.request_count)||0);
    if(meta.generated_at && meta.generated_at!==state.generatedAt){
      await loadHeader();
      await Promise.all([loadFindings(),populateFilterOptions(),loadAgentRuns()]);
      await refresh();
    }
  }catch{}
}, ${connect.mode === "watch" ? "4000" : "10000"});
</script>
</body></html>`;
}
