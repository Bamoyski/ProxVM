/**
 * Single-file Overwatch dashboard. Served same-origin from GET /, so no CORS
 * is involved — the browser sends the session cookie automatically, and the
 * operator pastes the bearer token once (kept in sessionStorage only).
 *
 * Rendering rule: textContent everywhere, never innerHTML — server data
 * (usernames, user agents, SQL results) is untrusted input.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Overwatch — ProxVM god-mode</title>
<style>
:root { color-scheme: dark; }
body { background: #020617; color: #e2e8f0; font-family: ui-monospace, monospace; margin: 0; padding: 16px; font-size: 13px; }
h1 { color: #60a5fa; font-size: 18px; margin: 0 0 12px; }
h2 { color: #94a3b8; font-size: 13px; margin: 18px 0 8px; text-transform: uppercase; letter-spacing: 1px; }
.card { background: #0f172a; border: 1px solid #1e293b; border-radius: 8px; padding: 12px; margin-bottom: 12px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
input, textarea, select { background: #1e293b; border: 1px solid #334155; color: #e2e8f0; border-radius: 6px; padding: 6px 8px; font: inherit; }
button { background: #1d4ed8; border: none; color: #fff; border-radius: 6px; padding: 6px 12px; font: inherit; cursor: pointer; }
button:hover { background: #2563eb; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #1e293b; vertical-align: top; }
th { color: #64748b; font-weight: normal; }
pre { background: #020617; border: 1px solid #1e293b; border-radius: 6px; padding: 8px; overflow-x: auto; white-space: pre-wrap; }
.err { color: #f87171; }
.ok { color: #4ade80; }
.muted { color: #64748b; }
</style>
</head>
<body>
<h1>⛨ Overwatch</h1>
<div class="card">
  <div class="row">
    <input id="token" type="password" placeholder="Bearer token (PROXVM_OVERWATCH_TOKEN)" size="44" />
    <button id="saveToken">Use token</button>
    <span id="authState" class="muted"></span>
  </div>
  <div class="muted">Needs an ADMIN session too — log into ProxVM in this browser first (same host shares the cookie).</div>
</div>
<div class="card"><h2>Fleet overview</h2><div class="row"><button id="btnOverview">Refresh</button></div><pre id="overview">—</pre></div>
<div class="card"><h2>Activity</h2>
  <div class="row"><input id="actLimit" value="25" size="4" /><input id="actEvent" placeholder="event filter (optional)" size="28" /><button id="btnActivity">Load</button></div>
  <div id="activity">—</div>
</div>
<div class="card"><h2>Sessions</h2><div class="row"><button id="btnSessions">Load</button></div><div id="sessions">—</div></div>
<div class="card"><h2>Queue + Proxmox</h2><div class="row"><button id="btnQueue">Load</button></div><div id="queueProxmox">—</div></div>
<div class="card"><h2>SQL console (read-only)</h2>
  <div class="row"><textarea id="sql" rows="3" cols="80" placeholder="SELECT * FROM users LIMIT 10"></textarea></div>
  <div class="row"><button id="btnSql">Run (SELECT only)</button><span id="sqlMeta" class="muted"></span></div>
  <div id="sqlOut">—</div>
</div>
<div class="card"><h2>Container logs</h2>
  <div class="row"><input id="logService" value="api" size="12" /><input id="logTail" value="200" size="6" /><button id="btnLogs">Load</button></div>
  <pre id="logs">—</pre>
</div>
<script>
"use strict";
const $ = (id) => document.getElementById(id);
const tokenInput = $("token");
tokenInput.value = sessionStorage.getItem("ow_token") || "";
function headers(json) {
  const h = { Authorization: "Bearer " + (sessionStorage.getItem("ow_token") || "") };
  if (json) h["Content-Type"] = "application/json";
  return h;
}
function setAuthState(ok, msg) {
  const el = $("authState");
  el.textContent = msg;
  el.className = ok ? "ok" : "err";
}
$("saveToken").onclick = () => {
  sessionStorage.setItem("ow_token", tokenInput.value.trim());
  setAuthState(true, "token stored for this tab");
};
function td(text) {
  const el = document.createElement("td");
  el.textContent = text == null ? "" : String(text);
  return el;
}
function table(headers, rows) {
  const t = document.createElement("table");
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  for (const h of headers) {
    const th = document.createElement("th");
    th.textContent = h;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  t.appendChild(thead);
  const tb = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    for (const c of r) tr.appendChild(td(c));
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  return t;
}
function showError(el, e) {
  el.textContent = "";
  const s = document.createElement("span");
  s.className = "err";
  s.textContent = "failed: " + (e && e.message ? e.message : e);
  el.appendChild(s);
}
async function get(path) {
  const res = await fetch(path, { headers: headers(false) });
  if (!res.ok) {
    let detail = res.status + "";
    try {
      const j = await res.json();
      if (j && j.message) detail = j.message;
    } catch (_) {}
    throw new Error(detail);
  }
  return res.json();
}
$("btnOverview").onclick = async () => {
  const el = $("overview");
  try {
    const o = await get("/overview");
    el.textContent = JSON.stringify(o, null, 1);
  } catch (e) { showError(el, e); }
};
$("btnActivity").onclick = async () => {
  const el = $("activity");
  try {
    const q = "?limit=" + encodeURIComponent($("actLimit").value || "25") +
      ($("actEvent").value ? "&event=" + encodeURIComponent($("actEvent").value) : "");
    const j = await get("/activity" + q);
    el.textContent = "";
    el.appendChild(table(
      ["time", "event", "actor", "vm"],
      (j.entries || []).map((e) => [e.createdAt, e.event, e.actorUsername || "", e.vmId || ""]),
    ));
  } catch (e) { showError(el, e); }
};
$("btnSessions").onclick = async () => {
  const el = $("sessions");
  try {
    const j = await get("/sessions");
    el.textContent = "";
    el.appendChild(table(
      ["user", "ip", "agent", "last active"],
      (j.sessions || []).map((s) => [s.username, s.ip, (s.user_agent || "").slice(0, 60), s.last_active_at]),
    ));
  } catch (e) { showError(el, e); }
};
$("btnQueue").onclick = async () => {
  const el = $("queueProxmox");
  try {
    const [q, p] = await Promise.all([get("/queue"), get("/proxmox/summary")]);
    el.textContent = "";
    const qpre = document.createElement("pre");
    qpre.textContent = "queue: " + JSON.stringify(q);
    const ppre = document.createElement("pre");
    ppre.textContent = "proxmox: " + JSON.stringify(p, null, 1).slice(0, 2000);
    el.appendChild(qpre);
    el.appendChild(ppre);
  } catch (e) { showError(el, e); }
};
$("btnSql").onclick = async () => {
  const out = $("sqlOut");
  const meta = $("sqlMeta");
  try {
    const res = await fetch("/sql", {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ query: $("sql").value }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.message || res.status);
    meta.textContent = j.rowCount + " row(s)" + (j.truncated ? " (truncated at 200)" : "");
    out.textContent = "";
    out.appendChild(table(j.columns || [], (j.rows || []).map((r) => (j.columns || []).map((c) => {
      const v = r[c];
      return typeof v === "object" && v !== null ? JSON.stringify(v) : v;
    }))));
  } catch (e) {
    meta.textContent = "";
    showError(out, e);
  }
};
$("btnLogs").onclick = async () => {
  const el = $("logs");
  try {
    const res = await fetch(
      "/docker/logs?service=" + encodeURIComponent($("logService").value) +
      "&tail=" + encodeURIComponent($("logTail").value),
      { headers: headers(false) },
    );
    const j = await res.json();
    if (!res.ok) throw new Error(j.message || res.status);
    el.textContent = j.logs || "(empty)";
  } catch (e) { showError(el, e); }
};
</script>
</body>
</html>
`;
