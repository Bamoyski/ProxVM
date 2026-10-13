# Instructions for Vihaan's agent (read this first, every session)

You are a coding agent working for developer **Vihaan** on the ProxVM
repository (`Bamoyski/ProxVM`). Vihaan writes code only — he does not run
the app, hold production secrets, or deploy. The maintainer (Ben) reviews,
live-verifies, merges, and deploys everything.

## Your authority

You have full latitude over implementation: add/edit/delete any code,
tests, or docs; run builds, typechecks, and tests; install dependencies.
Make real engineering decisions and say so in the PR when you do.

## THE RULE (non-negotiable, overrides everything else)

**Never push to `main`. Never commit onto `main`. Never force-push `main`
or any branch you did not create.** Every change ships as a pull request
that Ben reviews and merges. No exceptions, including "trivial" fixes.

Concretely, every task follows this shape:

```bash
git checkout main && git pull --ff-only origin main
git checkout -b vihaan/<short-description>
# ... do the work ...
npm run typecheck && npm run test && npm run build   # all green required
git push -u origin vihaan/<short-description>        # your branch only
gh pr create --base main --title "..." --body "..."  # then wait for review
```

- Branch names start with `vihaan/`.
- Force-push is allowed **only** on your own `vihaan/*` branches (e.g.
  after a rebase). Never on `main`, never on anyone else's branch.
- If `main` moves under you, rebase your branch onto it and re-run the
  full verification before pushing again.
- Review comments from Ben are instructions: apply them as follow-up
  commits on the same branch and push again. Do not open a second PR.

## What "done" means for a PR

1. `npm run typecheck`, `npm run test`, `npm run build` all green.
2. Tests added for the change (positive, negative, boundary, malformed
   input; authorization tests for anything permission-shaped). Never mock
   the security check itself — mocks live only at external boundaries
   (Proxmox/Guacamole/PBS/Cloudflare HTTP).
3. PR description states: what changed, threat-model impact (or "none"),
   tests added, anything intentionally not covered, and screenshots for
   any UI change. If it needs live infrastructure to verify (Guacamole
   launch, real backup, DNS), label the PR `needs-live-verify` — Ben runs
   that leg on the homelab.

## Secrets (hard rules, no exceptions)

- NEVER commit `.env`, `.env.*` (except placeholders-only `.env.example`),
  `.proxvm/`, `*.log`, `*.pid`, `node_modules/`, `dist/`. Verify with
  `git check-ignore` when unsure.
- Test passwords (`Admin-Password-1!`, `must-not-leak`) are obvious fakes.
- NEVER ask for, accept, or store real credentials, tokens, or passwords.
  If a task seems to require them, stop and say so in the PR instead —
  that task needs Ben, not a workaround.

## Required reading (in this order)

1. `CONTRIBUTING.md` — setup, scripts, and especially the authorization
   model primer (expiry, conferral, tenant visibility) before touching
   any permission-shaped code.
2. `README.md` + `docs/pbs-integration.md` if touching those areas.
3. `SECURITY.md` for vulnerability disclosure (private, never a public issue).

## Environment notes

- Tests run on `pg-mem` + `ioredis-mock` — no database or homelab needed.
- The web SPA has no test runner: `typecheck` + `vite build` is the
  compile proof; behavior verification happens on Ben's side.
- Windows note: if `npm.ps1` is blocked by execution policy, invoke
  `npm.cmd`/`npx.cmd` instead. No eslint/prettier configs in this repo.
