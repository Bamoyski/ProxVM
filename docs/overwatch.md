# Overwatch — god-mode observability console

A **separate service** (`apps/overwatch`, port 4001) for deep inspection:
fleet overview, activity timeline, live sessions, queue depths, Proxmox
rollup, container logs, and a read-only SQL console. Read-only everywhere
except SQL, which is itself double-gated (see below).

## Threat model (read this before exposing it)

1. Every route except `/healthz` requires an `ADMIN`-role session (same
   `proxvm_session` cookie as the main app), **plus** a static bearer token
   (`Authorization: Bearer …`) **when `PROXVM_OVERWATCH_TOKEN` is set**.
   Unset means session-only gating with a boot warning — zero config, still
   localhost-only with no CORS, so there is no cross-site angle either way.
   Set the token (e.g. `openssl rand -hex 32` into the local `.env`,
   gitignored) for the extra lock.
2. Binds `127.0.0.1` on the host side (compose publishes
   `127.0.0.1:4001:4001`).
3. The process itself listens on `0.0.0.0` *inside* the container —
   required, or published-port traffic is accepted then dropped (empty
   responses). Expose further only behind real authentication (Cloudflare
   Access, Tailscale) — never the open internet.
4. **No CORS plugin installed on purpose**: cross-origin browsers cannot read
   responses, which makes the bearer token CSRF-proof.
5. Rate-limited (60/min). Denials are logged; SQL executions are audited.

## Endpoints

## Access

Same origin as the app: `https://your-domain/overwatch/` (nginx strips the
prefix and forwards). That is what makes the dashboard work with no extra
login — the session cookie flows because the host is identical. Direct
`http://localhost:4001/` works too, but only with a session cookie minted
for `localhost` (i.e. logged in via `localhost:8080`), which is why a
public-domain login seemingly "doesn't work" there.

| Method | Path | What |
|---|---|---|
| GET | `/healthz` | Public liveness (docker healthcheck) |
| GET | `/auth-mode` | Public ping: whether a bearer is enforced (lets the UI adapt) |
| GET | `/overview` | Users/VMs/jobs/sessions/tickets/audit-24h/DB size/queue/Proxmox — each source best-effort, partial beats 500 |
| GET | `/activity?limit=&offset=&event=&vmId=&actor=&since=&until=` | Audit rows (cap 200); actor is a username, since/until are ISO datetimes |
| GET | `/activity/export?...` | Same filters as CSV download (cap 5000) |
| GET | `/activity/summary` | Security rollups: failed logins by user/IP, secret touches, quota denials, console use, 7-day volume |
| GET | `/sessions` | Active sessions metadata **only** — never sid hashes or CSRF tokens |
| GET | `/queue` | BullMQ waiting/active/delayed/failed/paused counts |
| GET | `/proxmox/summary` | Nodes + guest counts, or `{configured:false}` |
| GET | `/docker/logs?service=&tail=` | Container logs; needs `DOCKER_SOCK` + read-only socket mount, else 503 with instructions |
| POST | `/sql` | Read-only console (below) |

## Dashboard UI

Open `http://localhost:4001/` in a browser: a single self-contained page
(served same-origin, so no CORS is involved) with fleet overview, activity,
sessions, queue/Proxmox, a SQL console, and container logs. Same-origin
means the session cookie rides along automatically; paste the bearer token
once per tab (kept in `sessionStorage` only, never persisted). All rendering
uses `textContent` — server data is never injected as HTML.

API use still works for scripts:

```bash
export OW_TOKEN=...  # PROXVM_OVERWATCH_TOKEN value
curl -s -b "proxvm_session=<sid-from-login>" -H "Authorization: Bearer $OW_TOKEN" \
  http://127.0.0.1:4001/overview | jq .
```

(Get a session id by logging into the main app and copying the
`proxvm_session` cookie.)

## Read-only SQL console

Two independent gates, either sufficient alone:

1. **Statement gate**: only `SELECT/WITH/EXPLAIN/SHOW/VALUES/TABLE`-led
   statements (unit-tested).
2. **Server enforcement**: executed inside `START TRANSACTION READ ONLY`
   with a 10s statement timeout — smuggled writes fail in Postgres itself.
   Always rolled back, connection always released.

Results cap at 200 rows. Every execution is audited as `OVERWATCH_SQL`
(actor + truncated query + row count).
