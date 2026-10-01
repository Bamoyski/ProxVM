/**
 * Overwatch dashboard: single self-contained page, served same-origin.
 * ProxVM dark styling, tabbed sections, loads on open. Rendering rule:
 * textContent everywhere, never innerHTML — server data is untrusted input.
 */
/** App stylesheet (separate response: nginx CSP forbids inline <style>). */
export const APP_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { background: #020617; color: #e2e8f0; font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; font-size: 14px; }
header { background: #0f172a; border-bottom: 1px solid #1e293b; padding: 12px 20px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }
header h1 { color: #60a5fa; font-size: 17px; margin: 0; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid #334155; color: #94a3b8; }
.badge.ok { color: #4ade80; border-color: #166534; }
.badge.warn { color: #fbbf24; border-color: #92400e; }
main { max-width: 1100px; margin: 0 auto; padding: 20px; }
nav.tabs { display: flex; gap: 4px; margin-bottom: 16px; flex-wrap: wrap; }
nav.tabs button { background: transparent; border: 1px solid transparent; color: #94a3b8; border-radius: 8px; padding: 8px 14px; font: inherit; font-size: 13px; cursor: pointer; }
nav.tabs button:hover { background: #0f172a; color: #e2e8f0; }
nav.tabs button.active { background: #1d4ed8; color: #fff; }
.card { background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
.card h2 { color: #e2e8f0; font-size: 14px; margin: 0 0 12px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
input, textarea, select { background: #020617; border: 1px solid #334155; color: #e2e8f0; border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 13px; }
input:focus, textarea:focus { outline: none; border-color: #2563eb; }
button.action { background: #1d4ed8; border: none; color: #fff; border-radius: 8px; padding: 8px 16px; font: inherit; font-size: 13px; cursor: pointer; }
button.action:hover { background: #2563eb; }
button.ghost { background: #1e293b; }
button.ghost:hover { background: #334155; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #1e293b; vertical-align: top; }
th { color: #64748b; font-weight: 500; font-size: 12px; }
tr:hover td { background: #0b1120; }
pre { background: #020617; border: 1px solid #1e293b; border-radius: 8px; padding: 12px; overflow-x: auto; white-space: pre-wrap; font-size: 12px; }
.err { color: #f87171; background: #450a0a55; border: 1px solid #7f1d1d; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
.ok { color: #4ade80; }
.muted { color: #64748b; font-size: 12px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.stat { background: #020617; border: 1px solid #1e293b; border-radius: 8px; padding: 10px 12px; }
.stat .v { font-size: 20px; color: #e2e8f0; }
.stat .k { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; }
.hidden { display: none !important; }
.kv { display: grid; grid-template-columns: 180px 1fr; gap: 4px 12px; font-size: 13px; }
.kv dt { color: #64748b; }
.kv dd { margin: 0; font-family: ui-monospace, monospace; }
`;

/** App script (separate response: nginx CSP forbids inline <script>). */
export const APP_JS = `
"use strict";
const $ = (id) => document.getElementById(id);
function headers(json) {
  // No token handling: the session cookie is the credential. (If this server
  // ever enforces a bearer again, that belongs in a proper login screen, not
  // a pasted secret.)
  const h = {};
  if (json) h["Content-Type"] = "application/json";
  return h;
}
function td(text) {
  const el = document.createElement("td");
  el.textContent = text == null ? "" : String(text);
  return el;
}
function table(headers, rows, emptyText) {
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
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const d = document.createElement("td");
    d.colSpan = headers.length;
    d.className = "muted";
    d.textContent = emptyText || "Nothing here.";
    tr.appendChild(d);
    tb.appendChild(tr);
  }
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
  const s = document.createElement("div");
  s.className = "err";
  s.textContent = "failed: " + (e && e.message ? e.message : e);
  el.appendChild(s);
}
async function get(path) {
  const res = await fetch(path, { headers: headers(false) });
  if (!res.ok) throw await errOf(res);
  return res.json();
}
async function errOf(res) {
  let detail = "HTTP " + res.status;
  try {
    const j = await res.json();
    if (j && j.message) detail = j.message;
  } catch (_) {}
  return new Error(detail);
}
function fmtDate(v) {
  try { return new Date(v).toLocaleString(); } catch (_) { return String(v); }
}
// Tabs
const TABS = [["overview", "Overview"], ["activity", "Activity"], ["sessions", "Sessions"], ["queue", "Queue + Proxmox"], ["sql", "SQL"], ["logs", "Logs"]];
(function initTabs() {
  const nav = $("tabs");
  for (const [id, label] of TABS) {
    const b = document.createElement("button");
    b.textContent = label;
    b.dataset.tab = id;
    b.onclick = () => {
      for (const x of nav.querySelectorAll("button")) x.classList.remove("active");
      b.classList.add("active");
      for (const [pid] of TABS) $("tab-" + pid).classList.toggle("hidden", pid !== id);
      const loader = { overview: loadOverview, activity: () => {}, sessions: loadSessions, queue: loadQueue, sql: () => {}, logs: () => {} }[id];
      if (loader) loader();
    };
    if (id === "overview") b.classList.add("active");
    nav.appendChild(b);
  }
})();
// Boot: always attempt to load, and say plainly who we are / what is wrong.
// whoami doubles as the login check: no session, non-admin, and server-down
// each get their own message instead of a wall of red "failed" boxes.
fetch("/auth-mode")
  .then((r) => r.json())
  .then((j) => {
    const badge = $("modeBadge");
    if (j && j.tokenEnforced) {
      badge.textContent = "locked (bearer enforced — use curl, see docs)";
      badge.classList.add("warn");
    } else {
      badge.textContent = "admin session mode";
      badge.classList.add("ok");
    }
    return fetch("/overview", { headers: headers(false) });
  })
  .then((r) => {
    if (r.status === 401) throw new Error("not signed in — log into ProxVM as an ADMIN in this browser first");
    if (r.status === 403) throw new Error("signed in, but not an ADMIN — Overwatch is administrators only");
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  })
  .then((o) => {
    $("whoami").textContent = "connected";
    loadOverview();
  })
  .catch((e) => {
    const badge = $("modeBadge");
    badge.textContent = "server unreachable?";
    badge.classList.add("warn");
    const fatal = $("fatal");
    fatal.textContent = "";
    const s = document.createElement("div");
    s.className = "err";
    s.textContent = e && e.message ? e.message : String(e);
    fatal.appendChild(s);
  });
async function loadOverview() {
  const stats = $("overviewStats");
  const raw = $("overviewRaw");
  try {
    const o = await get("/overview");
    stats.textContent = "";
    const add = (k, v) => {
      const d = document.createElement("div");
      d.className = "stat";
      const vv = document.createElement("div");
      vv.className = "v";
      vv.textContent = v;
      const kk = document.createElement("div");
      kk.className = "k";
      kk.textContent = k;
      d.appendChild(vv);
      d.appendChild(kk);
      stats.appendChild(d);
    };
    add("users", (o.users && o.users.total) ?? "?");
    add("vms", (o.vms && o.vms.total) ?? "?");
    const running = o.vms && o.vms.byStatus ? Object.entries(o.vms.byStatus).map(([k, v]) => k + ":" + v).join(" ") : "?";
    add("vm states", running);
    add("active sessions", (o.sessions && o.sessions.active) ?? "?");
    add("open tickets", (o.tickets && o.tickets.open) ?? 0);
    add("db size", o.database && o.database.bytes != null ? (o.database.bytes / 1048576).toFixed(1) + " MB" : "?");
    add("queue failed", (o.queue && o.queue.failed) ?? "?");
    raw.textContent = "proxmox: " + JSON.stringify(o.proxmox) + " · jobs: " + JSON.stringify(o.jobs);
  } catch (e) { showError(stats, e); raw.textContent = ""; }
}
$("btnOverview").onclick = loadOverview;
$("btnSummary").onclick = async () => {
  const el = $("summary");
  try {
    const j = await get("/activity/summary");
    el.textContent = JSON.stringify(j, null, 1);
  } catch (e) { showError(el, e); }
};
function activityQuery() {
  const p = new URLSearchParams({ limit: $("actLimit").value || "25" });
  for (const [id, name] of [["actEvent", "event"], ["actActor", "actor"], ["actVm", "vmId"], ["actSince", "since"], ["actUntil", "until"]]) {
    const v = $(id).value.trim();
    if (v) p.set(name, v);
  }
  return p.toString();
}
$("btnActivity").onclick = async () => {
  const el = $("activity");
  try {
    const j = await get("/activity?" + activityQuery());
    el.textContent = "";
    el.appendChild(table(
      ["time", "event", "actor", "vm"],
      (j.entries || []).map((e) => [fmtDate(e.createdAt), e.event, e.actorUsername || "", e.vmId || ""]),
      "No matching entries.",
    ));
  } catch (e) { showError(el, e); }
};
$("btnExport").onclick = async () => {
  try {
    const res = await fetch("/activity/export?" + activityQuery(), { headers: headers(false) });
    if (!res.ok) throw await errOf(res);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "overwatch-activity.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) {
    showError($("activity"), e);
  }
};
function loadSessions() {
  const el = $("sessions");
  get("/sessions").then((j) => {
    el.textContent = "";
    el.appendChild(table(
      ["user", "ip", "agent", "last active"],
      (j.sessions || []).map((s) => [s.username, s.ip, (s.user_agent || "").slice(0, 60), fmtDate(s.last_active_at)]),
      "No active sessions.",
    ));
  }).catch((e) => showError(el, e));
}
$("btnSessions").onclick = loadSessions;
function loadQueue() {
  const el = $("queueProxmox");
  Promise.all([get("/queue"), get("/proxmox/summary")]).then(([q, p]) => {
    el.textContent = "";
    const dl = document.createElement("dl");
    dl.className = "kv";
    const add = (k, v) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      dl.appendChild(dt);
      dl.appendChild(dd);
    };
    add("queue waiting/active/failed", [q.waiting, q.active, q.failed].join(" / "));
    if (p && p.configured === false) {
      add("proxmox", "not configured (" + (p.detail || "?") + ")");
    } else if (p && p.nodes) {
      for (const n of p.nodes) add("node " + n.node, n.status + " · uptime " + n.uptime + "s");
      add("guests", String(p.guests));
    } else {
      add("proxmox", JSON.stringify(p).slice(0, 200));
    }
    el.appendChild(dl);
  }).catch((e) => showError(el, e));
}
$("btnQueue").onclick = loadQueue;
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
    })), "Query returned no rows."));
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
`;

/** Shell page. See above for why CSS/JS are not inlined. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Overwatch — ProxVM god-mode</title>
<link rel="stylesheet" href="./app.css" />
</head>
<body>
<header>
  <h1>⛨ Overwatch</h1>
  <span id="modeBadge" class="badge">…</span>
  <span style="flex:1"></span>
  <span id="whoami" class="muted"></span>
</header>
<main>
  <div id="fatal"></div>
  <nav class="tabs" id="tabs"></nav>
  <section id="tab-overview" class="tabpage">
    <div class="card"><h2>Fleet overview</h2><div class="row"><button id="btnOverview" class="action">Refresh</button></div><div id="overviewStats" class="stat-grid"></div><pre id="overviewRaw" class="muted"></pre></div>
    <div class="card"><h2>Security summary</h2><div class="row"><button id="btnSummary" class="action">Refresh</button></div><pre id="summary">—</pre></div>
  </section>
  <section id="tab-activity" class="tabpage hidden">
    <div class="card"><h2>Activity</h2>
      <div class="row">
        <input id="actLimit" value="25" size="4" title="limit" />
        <input id="actEvent" placeholder="event" size="16" />
        <input id="actActor" placeholder="actor username" size="16" />
        <input id="actVm" placeholder="vm id" size="20" />
        <input id="actSince" placeholder="since 2026-09-01" size="15" />
        <input id="actUntil" placeholder="until 2026-10-01" size="15" />
        <button id="btnActivity" class="action">Load</button>
        <button id="btnExport" class="ghost">Export CSV</button>
      </div>
      <div id="activity">—</div>
    </div>
  </section>
  <section id="tab-sessions" class="tabpage hidden">
    <div class="card"><h2>Live sessions</h2><div class="row"><button id="btnSessions" class="action">Refresh</button></div><div id="sessions">—</div></div>
  </section>
  <section id="tab-queue" class="tabpage hidden">
    <div class="card"><h2>Job queue</h2><div class="row"><button id="btnQueue" class="action">Refresh</button></div><div id="queueProxmox">—</div></div>
  </section>
  <section id="tab-sql" class="tabpage hidden">
    <div class="card"><h2>SQL console <span class="muted">read-only</span></h2>
      <div class="row"><textarea id="sql" rows="3" cols="90" placeholder="SELECT username FROM users LIMIT 10"></textarea></div>
      <div class="row"><button id="btnSql" class="action">Run (SELECT only)</button><span id="sqlMeta" class="muted"></span></div>
      <div id="sqlOut">—</div>
    </div>
  </section>
  <section id="tab-logs" class="tabpage hidden">
    <div class="card"><h2>Container logs</h2>
      <div class="row"><input id="logService" value="api" size="12" /><input id="logTail" value="200" size="6" /><button id="btnLogs" class="action">Load</button></div>
      <pre id="logs">—</pre>
    </div>
  </section>
</main>
<noscript><p style="padding:20px">Overwatch needs JavaScript enabled.</p></noscript><script src="./app.js"></script>
</body>
</html>
`;
