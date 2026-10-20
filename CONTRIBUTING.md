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
cp .env.example .env   # Windows: copy .env.example .env — placeholders only, never commit real values
docker compose up -d postgres redis
npm run dev            # api + worker + web together
```

Database migrations apply automatically when the API/worker starts — there
is no manual migrate step. On a fresh clone, run `npm run build` once
before `npm run dev` so the cross-workspace `dist` typings exist.

Open the web UI and complete the setup wizard (creates the first admin).
All runtime config lives in `.proxvm/config.json` (gitignored — it holds
the vault master key; losing it loses every stored credential).

### Code-only contributors (no local stack)

If you only write code and never run the app, skip Docker, `.env`, and
the wizard entirely. Everything you need to prove your change works is
already mocked:

```bash
git clone https://github.com/Bamoyski/ProxVM.git
cd ProxVM
npm install
npm run build                        # first: generates the cross-workspace dist typings
npm run typecheck && npm run test && npm run build
```

- Unit/integration suites run on `pg-mem` + `ioredis-mock` — no database,
  no Proxmox, no secrets required. If the suite is green, your backend
  change is verified as far as automation can tell.
- The web SPA's compile proof is `typecheck` + `vite build`; `npm run
  test` also runs web tests when the workspace has them. You cannot click
  through flows without a running API — say so in the PR and attach
  screenshots of the changed UI instead; the maintainer verifies behavior
  against the live homelab before merging.
- Never ask for, accept, or store real credentials (`.env` contents,
  tokens, passwords). If a feature needs a live integration to verify
  (Guacamole launch, PBS backup, Cloudflare DNS), mark the PR
  `needs-live-verify` and the maintainer runs that leg.
- `npm run test:integration` is maintainer-only (needs real Proxmox env).

## Layout

- `apps/api` — Fastify routes (`src/routes/`), auth plugin, tickers.
- `apps/worker` — BullMQ provisioning consumer (re-authorizes every job).
- `apps/web` — React SPA (`src/pages/`, TanStack Query; web tests when present).
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
| `npm run test` | shared + core + api (+ web when present) suites (pg-mem, no infra needed) |
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

`main` is PR-only. Every change — including maintainer changes — lands
through a short-lived branch and a pull request; never push `main`
directly, never force-push it. `main` requires a PR, one approving review,
and resolved conversations before merge; branch protection rejects direct
pushes from admins too.

1. Start from current `main`:
   `git fetch origin && git switch -c feature/<short-description> origin/main`.
   Use `fix/` or `docs/` when that is clearer. One branch per PR; if a
   request is really several changes, split it.
2. Keep diffs small and single-purpose. Explain WHY in comments on
   security-sensitive logic, not just what.
3. Run the full gate locally: `npm run typecheck && npm run test &&
   npm run build && npm run audit:ci`. Code-only contributors stop here;
   the maintainer runs live behavior checks and deploys.
4. Push the branch and open a PR against `main`:
   `git push -u origin feature/<short-description>` then
   `gh pr create --base main --title "..." --body "..."`.
5. The PR description should state: what changed, threat-model impact
   (if any), tests added, anything intentionally not covered, and
   (for UI) screenshots of the changed screens.
6. After merge, delete the branch — GitHub can do this automatically;
   otherwise `git push origin --delete <branch>` and `git branch -d
   <branch>`. Keep only `main` plus the branch you are actively working on.

## Secrets (hard rules)

- NEVER commit `.env`, `.env.*` (except placeholders-only `.env.example`),
  `.proxvm/`, `*.log`, `*.pid`, `node_modules/`, `dist/`. Verify with
  `git check-ignore` when unsure.
- Test passwords (`Admin-Password-1!`, `must-not-leak`) are obvious fakes.
- Real tokens/passwords travel in chat or password managers only, via
  transient variables, never printed — and anything pasted in chat counts
  as exposed and must be rotated.
