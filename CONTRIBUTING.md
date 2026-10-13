# Contributing to ProxVM

Welcome! ProxVM is a homelab VM management platform: Proxmox VE
provisioning, an AES-256-GCM credential vault, RBAC + IAM with temporary
grants, Apache Guacamole remote sessions, PBS backups, and a Fastify +
React (Vite) codebase. This guide gets a second developer productive
without breaking the security model. For vulnerabilities, see
`SECURITY.md` (private disclosure — never open a public issue for them).

## Prerequisites

- Node.js 22, Docker + Docker Compose, Git, `gh` (GitHub CLI, optional).
- For full-stack work: reachable Proxmox VE, Guacamole (+ MariaDB/Postgres),
  and Proxmox Backup Server. For most development you do NOT need them —
  unit/integration tests run against `pg-mem` + `ioredis-mock`.

## Setup

```bash
git clone https://github.com/Bamoyski/ProxVM.git
cd ProxVM
npm install
cp .env.example .env   # placeholders only — never commit real values
docker compose up -d postgres redis
npm run db:migrate -w @proxvm/api
npm run dev            # api + worker + web together
```

Open the web UI and complete the setup wizard (creates the first admin).
All runtime config lives in `.proxvm/config.json` (gitignored — it holds
the vault master key; losing it loses every stored credential).

## Layout

- `apps/api` — Fastify routes (`src/routes/`), auth plugin, tickers.
- `apps/worker` — BullMQ provisioning consumer (re-authorizes every job).
- `apps/web` — React SPA (`src/pages/`, TanStack Query, no test runner).
- `packages/core` — all business logic: `services/`, `provisioning/`,
  `proxmox/` + `pbs/` + `cloudflare/` + `guacamole/` clients, `db/`.
- `packages/shared` — Zod schemas, types, enums shared by API and web.
- `scripts/` — ops helpers (e.g. break-glass admin recovery).

## Scripts (repo root)

| Command | What it does |
|---|---|
| `npm run dev` | api + worker + web with hot reload |
| `npm run build` | all workspaces (ships `dist/`) |
| `npm run typecheck` | `tsc --noEmit` everywhere |
| `npm run test` | shared + core + api suites (pg-mem, no infra needed) |
| `npm run test:integration` | live-Proxmox tests (needs `PROXVM_INTEGRATION=1` + env) |
| `npm run audit:ci` | `npm audit --omit=dev`, moderate+ fails |

Green means: typecheck + tests + build, in that order.

## The authorization model (read before touching auth)

- **Two layers.** Legacy system roles (`ADMIN`/`OPERATOR`/`USER` in
  `packages/core/src/services/rbac.ts`) are a zero-query fast path over
  the session user. Everything richer (custom roles, group roles, direct
  grants) resolves in `services/iam.ts` (`resolveEffectiveAccess`,
  `checkAccess`). Routes declare permissions via
  `app.requirePermission(...)` — the backend is authoritative, the
  frontend is UX-only.
- **Expiry is authoritative.** Every grant table filters
  `expires_at IS NULL OR expires_at > NOW()` in SQL *and* in memory
  (`isLive`, strictly-greater: expiring exactly now is already dead).
  Any new grant path must do both or expired privileges resurrect.
- **Conferral rules.** `assertMayConfer` (can't grant what you don't hold)
  and `assertCanAdministerTarget` (can't act upward) guard every
  invite/grant path. Delegated VM invites are capped at 24h + the
  inviter's own protocols.
- **Tenant visibility.** `vms.visibleTo()` + `resolveVmAccess` gate every
  `:id` route; privacy-flagged VMs need a concrete grant even for admins.
- **Audit everything security-relevant** via the request-scoped
  `app.audit(request, …)` (fills IP/actor) — never `ctx.audit.record`
  directly on HTTP paths. Never log secrets; audit detail is recursively
  redacted (`services/audit.ts`).

## Testing conventions

- Vitest, `pg-mem` for Postgres, `ioredis-mock` for Redis — no live infra.
- For every change: positive + negative + boundary + malformed-input
  tests; authorization tests (allowed/denied); multi-tenant tests.
- **Never mock the security check itself** — mocks live only at external
  boundaries (Proxmox/Guacamole/PBS/Cloudflare HTTP). A test that stubs
  `checkAccess` to return true proves nothing.
- Run one file: `npx vitest run src/<name>.test.ts` inside
  `apps/api` or `packages/core`. (Windows: use `npm.cmd`/`npx.cmd` by
  full path if `npm.ps1` is blocked by execution policy.)

## Pull requests

1. Branch from `main`. Push the branch, open a PR — never push `main`
   directly, never force-push it.
2. Keep diffs small and single-purpose. Explain WHY in comments on
   security-sensitive logic, not just what.
3. CI-green required: typecheck + tests + build + `npm run audit:ci`.
4. The PR description should state: what changed, threat-model impact
   (if any), tests added, and anything intentionally not covered.

## Secrets (hard rules)

- NEVER commit `.env`, `.env.*` (except placeholders-only `.env.example`),
  `.proxvm/`, `*.log`, `*.pid`, `node_modules/`, `dist/`. Verify with
  `git check-ignore` when unsure.
- Test passwords (`Admin-Password-1!`, `must-not-leak`) are obvious fakes.
- Real tokens/passwords travel in chat or password managers only, via
  transient variables, never printed — and anything pasted in chat counts
  as exposed and must be rotated.
