# Overwatch — god-mode observability console

A **separate service** (`apps/overwatch`, port 4001) for deep inspection:
fleet overview, activity timeline, live sessions, queue depths, Proxmox
rollup, container logs, and a read-only SQL console. Read-only everywhere
except SQL, which is itself double-gated (see below).

## Threat model (read this before exposing it)

1. Every route except `/healthz` requires **both**: an `ADMIN`-role session
   (same `proxvm_session` cookie as the main app) **and** a static bearer
   token (`Authorization: Bearer …`).
2. The bearer token is **fail-closed**: with `PROXVM_OVERWATCH_TOKEN` empty,
   every protected route refuses. Generate one with `openssl rand -hex 32`
   into the local `.env` (gitignored).
3. Binds `127.0.0.1` by default. Expose further only behind real
   authentication (Cloudflare Access, Tailscale) — never the open internet.
4. **No CORS plugin installed on purpose**: cross-origin browsers cannot read
   responses, which makes the bearer token CSRF-proof.
5. Rate-limited (60/min). Denials are logged; SQL executions are audited.

## Endpoints

| Method | Path | What |
|---|---|---|
| GET | `/healthz` | Public liveness (docker healthcheck) |
| GET | `/overview` | Users/VMs/jobs/sessions/tickets/audit-24h/DB size/queue/Proxmox — each source best-effort, partial beats 500 |
| GET | `/activity?limit=&event=` | Recent audit rows (cap 200) |
| GET | `/sessions` | Active sessions metadata **only** — never sid hashes or CSRF tokens |
| GET | `/queue` | BullMQ waiting/active/delayed/failed/paused counts |
| GET | `/proxmox/summary` | Nodes + guest counts, or `{configured:false}` |
| GET | `/docker/logs?service=&tail=` | Container logs; needs `DOCKER_SOCK` + read-only socket mount, else 503 with instructions |
| POST | `/sql` | Read-only console (below) |

Example:

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
