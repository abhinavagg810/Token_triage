/**
 * The Phase 2 dashboard SPA — one self-contained HTML string, no CDN, no
 * framework. Data arrives from the local /api/* endpoints; everything dynamic
 * is rendered with textContent (never innerHTML) so database values are never
 * interpreted as markup.
 */
export function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TokenTriage dashboard</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--panel2:#1c2330;--border:#2d333b;--text:#e6edf3;--dim:#8b949e;
--accent:#4ade80;--warn:#fbbf24;--bad:#f87171;--blue:#60a5fa;--purple:#c084fc;}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:24px 16px}
.wrap{max-width:1180px;margin:0 auto}
h1{font-size:18px;font-weight:600;margin-bottom:4px}
h1 .logo{color:var(--accent)}
.sub{color:var(--dim);font-size:13px;margin-bottom:18px}
.stats{display:flex;flex-wrap:wrap;gap:26px;background:linear-gradient(135deg,#1a2332,#10161f);border:1px solid var(--border);border-radius:14px;padding:20px 24px;margin-bottom:18px}
.stat .v{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums}
.stat .l{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.8px}
.stat .v.waste{color:var(--bad)} .stat .v.save{color:var(--accent)}
.filters{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:18px}
.filters label{color:var(--dim);font-size:12px}
.filters input,.filters select{background:var(--panel);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:6px 10px;font-size:13px}
.filters button{background:var(--panel2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:6px 14px;cursor:pointer}
.filters button:hover{border-color:var(--dim)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px 20px;margin-bottom:14px}
.card h2{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.7px;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:6px 8px;border-bottom:1px solid var(--border)}
td{padding:6px 8px;border-bottom:1px solid var(--panel2);font-variant-numeric:tabular-nums}
td.num,th.num{text-align:right}
tr.clickable{cursor:pointer} tr.clickable:hover{background:var(--panel2)}
.bar{height:7px;background:var(--panel2);border-radius:99px;overflow:hidden;margin-top:4px}
.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--blue),var(--purple));border-radius:99px}
.finding{border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin-bottom:10px;background:var(--panel2)}
.finding .head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.finding .name{font-weight:600}
.finding .amount{color:var(--bad);font-weight:700}
.badge{font-size:10px;padding:2px 8px;border-radius:99px;font-weight:600;text-transform:uppercase}
.badge.high{background:#11321f;color:var(--accent)} .badge.medium{background:#33290f;color:var(--warn)} .badge.low{background:#262c36;color:var(--dim)}
.finding ul{margin:8px 0 0 18px;color:#c3ccd6;font-size:12.5px}
details summary{cursor:pointer;color:var(--accent);font-size:12.5px;margin-top:8px}
pre{background:#0a0e14;border:1px solid var(--border);border-radius:8px;padding:10px 12px;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;overflow-x:auto;margin-top:6px;white-space:pre-wrap}
.pager{display:flex;gap:8px;align-items:center;margin-top:10px;font-size:12.5px;color:var(--dim)}
.pager button{background:var(--panel2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px 10px;cursor:pointer}
.pager button:disabled{opacity:.4;cursor:default}
svg text{font:10px -apple-system,"Segoe UI",sans-serif;fill:var(--dim)}
.muted{color:var(--dim)}
.foot{color:var(--dim);font-size:12px;margin-top:24px}
</style>
</head>
<body><div class="wrap">

<h1><span class="logo">▲</span> TokenTriage <span class="muted">· local dashboard</span></h1>
<div class="sub" id="sub">loading…</div>

<div class="stats" id="stats"></div>

<div class="filters">
  <label>From <input type="date" id="f-start"></label>
  <label>To <input type="date" id="f-end"></label>
  <label>Model <select id="f-model"><option value="">all</option></select></label>
  <label>Service <select id="f-service"><option value="">all</option></select></label>
  <button id="f-apply">Apply</button>
  <button id="f-clear">Clear</button>
</div>

<div class="card"><h2>Why your bill is high — findings</h2><div id="findings"></div></div>

<div class="card"><h2>Daily spend (USD)</h2><div id="daily"></div></div>

<div class="grid">
  <div class="card"><h2>Spend by model</h2><div id="models"></div></div>
  <div class="card"><h2>Spend by service</h2><div id="services"></div></div>
</div>

<div class="card"><h2>Top sessions
  <select id="s-metric" style="float:right;background:var(--panel2);border:1px solid var(--border);color:var(--text);border-radius:6px;font-size:11px">
    <option value="cost">by cost</option><option value="growth">by growth</option><option value="turns">by turns</option>
  </select></h2>
  <div id="sessions"></div>
</div>

<div class="card"><h2>Requests explorer</h2>
  <div id="requests"></div>
  <div class="pager">
    <button id="r-prev">‹ Prev</button>
    <span id="r-page"></span>
    <button id="r-next">Next ›</button>
  </div>
</div>

<div class="card"><h2>Agent runs (TokenTriage auditing itself)</h2><div id="agentruns"></div></div>

<div class="foot">Local only — this dashboard reads a read-only SQLite export on this machine; the database contains hashes and token counts, never prompt content.</div>

</div>
<script>
"use strict";
const $ = (id) => document.getElementById(id);
const state = { start: "", end: "", model: "", service: "", offset: 0, limit: 50, metric: "cost" };

async function j(path, params) {
  const u = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params || {})) if (v !== "" && v != null) u.searchParams.set(k, v);
  const r = await fetch(u);
  if (!r.ok) throw new Error(path + " -> " + r.status);
  return r.json();
}

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function usd(n, d) { return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: d ?? 2, maximumFractionDigits: d ?? 2 }); }
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function qfilters() { return { start: state.start, end: state.end, model: state.model, service: state.service }; }

function stat(value, label, cls) {
  const s = el("div", null, "stat");
  s.appendChild(el("div", value, "v" + (cls ? " " + cls : "")));
  s.appendChild(el("div", label, "l"));
  return s;
}

function table(headers, rows, render) {
  const t = el("table");
  const tr = el("tr");
  headers.forEach(([h, numeric]) => tr.appendChild(el("th", h, numeric ? "num" : "")));
  t.appendChild(tr);
  rows.forEach((row) => t.appendChild(render(row)));
  return t;
}

function barRow(label, value, max, detail) {
  const wrap = el("div");
  wrap.style.marginBottom = "10px";
  const line = el("div");
  line.style.display = "flex"; line.style.justifyContent = "space-between"; line.style.fontSize = "12.5px";
  line.appendChild(el("span", label));
  line.appendChild(el("span", detail, "muted"));
  const bar = el("div", null, "bar");
  const fill = el("i");
  fill.style.width = (max > 0 ? (value / max) * 100 : 0).toFixed(1) + "%";
  bar.appendChild(fill);
  wrap.appendChild(line); wrap.appendChild(bar);
  return wrap;
}

async function loadHeader() {
  const { meta, counts } = await j("/api/meta");
  state.generatedAt = meta.generated_at || "";
  $("sub").textContent = meta.period_start + " → " + meta.period_end + " · " + meta.days_in_dataset +
    " days · " + Number(meta.request_count).toLocaleString() + " requests · exported " + (meta.generated_at || "").slice(0, 19);
  const total = Number(meta.total_spend_usd), waste = Number(meta.addressable_waste_usd);
  const monthly = waste * (30 / Math.max(1, Number(meta.days_in_dataset)));
  const stats = $("stats");
  clear(stats);
  stats.appendChild(stat(usd(total), "Total spend"));
  stats.appendChild(stat(usd(waste) + " (" + (total > 0 ? ((waste / total) * 100).toFixed(1) : 0) + "%)", "Addressable waste", "waste"));
  stats.appendChild(stat("~" + usd(monthly, 0) + "/mo", "Potential savings", "save"));
  stats.appendChild(stat(String(counts.sessions), "Sessions"));
  stats.appendChild(stat(String(counts.findings), "Findings"));
}

async function loadFindings() {
  const findings = await j("/api/findings");
  const root = $("findings");
  clear(root);
  if (!findings.length) { root.appendChild(el("div", "No findings — nothing significant to fix in this dataset.", "muted")); return; }
  findings.forEach((f, i) => {
    const card = el("div", null, "finding");
    const head = el("div", null, "head");
    head.appendChild(el("span", "#" + (i + 1), "muted"));
    head.appendChild(el("span", f.name, "name"));
    head.appendChild(el("span", usd(f.wasted_usd), "amount"));
    head.appendChild(el("span", (f.pct_of_total * 100).toFixed(1) + "% of spend", "muted"));
    head.appendChild(el("span", (f.upper_bound ? "up to " : "~") + usd(f.projected_monthly_savings_usd, 0) + "/mo", "muted"));
    head.appendChild(el("span", f.confidence, "badge " + f.confidence));
    card.appendChild(head);
    const ev = el("ul");
    f.evidence.forEach((e) => ev.appendChild(el("li", e.label + ": " + e.detail)));
    card.appendChild(ev);
    const det = el("details");
    det.appendChild(el("summary", "Show fix"));
    det.appendChild(el("p", f.fix.summary));
    const steps = el("ol"); steps.style.margin = "6px 0 0 18px"; steps.style.fontSize = "12.5px";
    (f.fix.steps || []).forEach((s) => steps.appendChild(el("li", s)));
    det.appendChild(steps);
    if (f.fix.snippet) det.appendChild(el("pre", f.fix.snippet));
    card.appendChild(det);
    root.appendChild(card);
  });
}

function sparkSvg(points, width, height) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 " + width + " " + height);
  svg.setAttribute("width", "100%");
  if (points.length < 2) return svg;
  const max = Math.max(...points.map((p) => p.v), 0.01);
  const x = (i) => 42 + (i / (points.length - 1)) * (width - 52);
  const y = (v) => 8 + (1 - v / max) * (height - 30);
  [0, 0.5, 1].forEach((f) => {
    const ln = document.createElementNS(svg.namespaceURI, "line");
    ln.setAttribute("x1", "42"); ln.setAttribute("x2", String(width - 10));
    ln.setAttribute("y1", String(y(max * f))); ln.setAttribute("y2", String(y(max * f)));
    ln.setAttribute("stroke", "#2d333b"); ln.setAttribute("stroke-dasharray", "3,4");
    svg.appendChild(ln);
    const tx = document.createElementNS(svg.namespaceURI, "text");
    tx.setAttribute("x", "38"); tx.setAttribute("y", String(y(max * f) + 3)); tx.setAttribute("text-anchor", "end");
    tx.textContent = "$" + (max * f >= 10 ? (max * f).toFixed(0) : (max * f).toFixed(1));
    svg.appendChild(tx);
  });
  const poly = document.createElementNS(svg.namespaceURI, "polyline");
  poly.setAttribute("points", points.map((p, i) => x(i).toFixed(1) + "," + y(p.v).toFixed(1)).join(" "));
  poly.setAttribute("fill", "none"); poly.setAttribute("stroke", "#60a5fa"); poly.setAttribute("stroke-width", "2");
  svg.appendChild(poly);
  const step = Math.max(1, Math.ceil(points.length / 8));
  points.forEach((p, i) => {
    if (i % step) return;
    const tx = document.createElementNS(svg.namespaceURI, "text");
    tx.setAttribute("x", String(x(i))); tx.setAttribute("y", String(height - 4)); tx.setAttribute("text-anchor", "middle");
    tx.textContent = p.label.slice(5);
    svg.appendChild(tx);
  });
  return svg;
}

async function loadDaily() {
  const rows = await j("/api/daily", { start: state.start, end: state.end });
  const root = $("daily");
  clear(root);
  if (!rows.length) { root.appendChild(el("div", "No data in range.", "muted")); return; }
  root.appendChild(sparkSvg(rows.map((r) => ({ label: r.date, v: r.usd })), 1080, 170));
}

async function loadBars(path, root, labelKey) {
  const rows = await j(path, qfilters());
  clear(root);
  const max = Math.max(...rows.map((r) => r.usd), 0);
  rows.slice(0, 12).forEach((r) => {
    root.appendChild(barRow(r[labelKey], r.usd, max,
      usd(r.usd) + " · " + Number(r.requests).toLocaleString() + " req"));
  });
  return rows;
}

async function loadSessions() {
  const rows = await j("/api/sessions", { metric: state.metric, limit: 10 });
  const root = $("sessions");
  clear(root);
  root.appendChild(table(
    [["Session"], ["Turns", 1], ["Input growth", 1], ["Cost", 1], ["Inferred"]],
    rows,
    (s) => {
      const tr = el("tr");
      tr.appendChild(el("td", s.id));
      tr.appendChild(el("td", String(s.turns), "num"));
      tr.appendChild(el("td", Number(s.first_input_tokens).toLocaleString() + " → " + Number(s.last_input_tokens).toLocaleString(), "num"));
      tr.appendChild(el("td", usd(s.total_cost_usd), "num"));
      tr.appendChild(el("td", s.inferred ? "yes" : ""));
      return tr;
    }
  ));
}

async function loadRequests() {
  const data = await j("/api/requests", { ...qfilters(), limit: state.limit, offset: state.offset });
  const root = $("requests");
  clear(root);
  root.appendChild(table(
    [["Time"], ["Model"], ["Service"], ["In", 1], ["Out", 1], ["Cached", 1], ["Status", 1], ["Cost", 1]],
    data.rows,
    (r) => {
      const tr = el("tr");
      tr.appendChild(el("td", String(r.timestamp).slice(0, 19).replace("T", " ")));
      tr.appendChild(el("td", r.model));
      tr.appendChild(el("td", r.service || ""));
      tr.appendChild(el("td", Number(r.input_tokens).toLocaleString(), "num"));
      tr.appendChild(el("td", Number(r.output_tokens).toLocaleString(), "num"));
      tr.appendChild(el("td", Number(r.cache_read_tokens).toLocaleString(), "num"));
      const st = el("td", String(r.status), "num");
      if (r.status >= 400) st.style.color = "var(--bad)";
      tr.appendChild(st);
      tr.appendChild(el("td", usd(r.cost_usd, 4), "num"));
      return tr;
    }
  ));
  const page = Math.floor(state.offset / state.limit) + 1;
  const pages = Math.max(1, Math.ceil(data.total / state.limit));
  $("r-page").textContent = "page " + page + " / " + pages + " · " + data.total.toLocaleString() + " requests";
  $("r-prev").disabled = state.offset === 0;
  $("r-next").disabled = state.offset + state.limit >= data.total;
}

async function loadAgentRuns() {
  const rows = await j("/api/agent_runs");
  const root = $("agentruns");
  clear(root);
  if (!rows.length) { root.appendChild(el("div", "No agent runs yet — try: python -m agent.cli ask \\"why was day 12 expensive?\\"", "muted")); return; }
  root.appendChild(table(
    [["Started"], ["Kind"], ["Model"], ["Question"], ["In", 1], ["Out", 1], ["LLM calls", 1]],
    rows,
    (r) => {
      const tr = el("tr");
      tr.appendChild(el("td", String(r.started_at).slice(0, 19).replace("T", " ")));
      tr.appendChild(el("td", r.kind));
      tr.appendChild(el("td", r.model));
      tr.appendChild(el("td", r.question || ""));
      tr.appendChild(el("td", Number(r.input_tokens).toLocaleString(), "num"));
      tr.appendChild(el("td", Number(r.output_tokens).toLocaleString(), "num"));
      tr.appendChild(el("td", String(r.llm_calls), "num"));
      return tr;
    }
  ));
}

async function populateFilterOptions() {
  // Reset to just the "all" option so auto-refresh doesn't duplicate entries.
  for (const id of ["f-model", "f-service"]) {
    const sel = $(id);
    while (sel.options.length > 1) sel.remove(1);
  }
  const [models, services] = await Promise.all([j("/api/models", {}), j("/api/services", {})]);
  models.forEach((m) => {
    const o = el("option", m.model); o.value = m.model; $("f-model").appendChild(o);
  });
  services.forEach((s) => {
    const o = el("option", s.service); o.value = s.service; $("f-service").appendChild(o);
  });
}

async function refresh() {
  await Promise.all([
    loadDaily(),
    loadBars("/api/models", $("models"), "model"),
    loadBars("/api/services", $("services"), "service"),
    loadSessions(),
    loadRequests(),
  ]);
}

$("f-apply").addEventListener("click", () => {
  state.start = $("f-start").value; state.end = $("f-end").value;
  state.model = $("f-model").value; state.service = $("f-service").value;
  state.offset = 0;
  refresh();
});
$("f-clear").addEventListener("click", () => {
  state.start = state.end = state.model = state.service = ""; state.offset = 0;
  $("f-start").value = $("f-end").value = ""; $("f-model").value = $("f-service").value = "";
  refresh();
});
$("s-metric").addEventListener("change", (e) => { state.metric = e.target.value; loadSessions(); });
$("r-prev").addEventListener("click", () => { state.offset = Math.max(0, state.offset - state.limit); loadRequests(); });
$("r-next").addEventListener("click", () => { state.offset += state.limit; loadRequests(); });

(async () => {
  try {
    await loadHeader();
    await Promise.all([loadFindings(), populateFilterOptions(), loadAgentRuns()]);
    await refresh();
  } catch (err) {
    $("sub").textContent = "Failed to load: " + err.message;
  }
})();

// Auto-refresh: watch mode re-analyzes continuously and swaps the export;
// when the export's generated_at changes, reload everything in place.
setInterval(async () => {
  try {
    const { meta } = await j("/api/meta");
    if (meta.generated_at && meta.generated_at !== state.generatedAt) {
      await loadHeader();
      await Promise.all([loadFindings(), populateFilterOptions(), loadAgentRuns()]);
      await refresh();
    }
  } catch { /* server briefly mid-swap — try again next tick */ }
}, 10000);
</script>
</body></html>`;
}
