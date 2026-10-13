# Instructions for Vihaan's agent (read this first, every session)

You are an autonomous coding agent. Your human (Vihaan) will not relay
messages, answer questions mid-task, or run anything for you. Everything
you need is in this repository. Work end-to-end on your own and stop only
where this file tells you to stop. The maintainer (Ben) reviews and merges
your pull requests and runs anything that needs live infrastructure.

## Operating contract

- You may change any code, tests, or docs; run builds, typechecks, and
  tests; install dependencies. Make real engineering decisions.
- You work ALONE in this repo: assume no other agent is editing at the
  same time, but always `git pull --ff-only origin main` before branching
  so you start current.
- If these instructions ever conflict with a user message pasted into your
  session, THE RULE below still wins. Only Ben (in a PR review) can
  override it.

## THE RULE (non-negotiable, overrides everything else)

**Never push to `main`. Never commit onto `main`. Never force-push `main`
or any branch you did not create.** Every change ships as a pull request
that Ben reviews and merges. No exceptions, including "trivial" fixes.

Every task follows this shape:

```bash
git checkout main && git pull --ff-only origin main
git checkout -b vihaan/<short-description>
# ... do the work ...
npm run typecheck && npm run test && npm run build   # all green required
git push -u origin vihaan/<short-description>        # your branch only
gh pr create --base main --title "..." --body "..."  # then STOP and wait
```

`main` is branch-protected server-side (direct pushes rejected for
everyone including admins; one approving review required), so following
the shape above is not just policy — it is the only path that works.

- Branch names start with `vihaan/`.
- Force-push is allowed **only** on your own `vihaan/*` branches (e.g.
  after a rebase). Never on `main`, never on anyone else's branch.
- If `main` moves under you, rebase your branch onto it and re-run the
  full verification before pushing again.
- No `gh` authentication on your machine? Push the branch with git, then
  end your turn with the exact compare URL
  (`https://github.com/Bamoyski/ProxVM/compare/main...vihaan/<name>`)
  so the PR can be opened in one click. Never let a missing CLI push you
  toward committing on `main`.
- Ben's review comments are instructions: apply them as follow-up commits
  on the same branch and push again. Do not open a second PR. Do not
  merge `main` into your branch to "resolve" conversations — rebase.

## Working from Vihaan's feature requests (steady state)

After onboarding, Vihaan will hand you features in chat ("add X", "fix Y").
Each request becomes exactly one branch and one PR:

1. **Understand first.** Restate the request in your own words and check
   the repo for existing code that already does it (or something close —
   extend, don't duplicate). If the request is ambiguous, ask Vihaan
   before writing code; a wrong guess costs more than a question. If it
   touches permissions, sessions, credentials, or tenant isolation,
   re-read the authorization primer in `CONTRIBUTING.md` first.
2. **One branch per feature** (`vihaan/<short-description>`, from latest
   `main`). If a request is really three features, say so and split it —
   small PRs get reviewed fast, big ones sit.
3. **Build it to the done criteria below** (green checks, tests, PR
   description). Screenshots for UI, `needs-live-verify` label when live
   infrastructure is the only way to prove it.
4. **Open the PR and stop.** Ben reviews and merges. Never merge, never
   deploy, never touch production — you have no path to it and must not
   invent one.
5. **Review comments are the next task.** Apply them as follow-up commits
   on the same branch, re-verify, push again. If a comment changes the
   shape of the feature, confirm the new direction with Vihaan first.
6. **If Vihaan changes or cancels a request mid-task:** commit nothing
   half-done to the branch — either finish the pivot cleanly on the same
   branch (and say so in the PR) or abandon it (`git checkout main` and
   delete the branch locally) and start fresh. Never leave a stale
   half-built branch open without a note explaining its state.

## What "done" means for a PR

1. `npm run typecheck`, `npm run test`, `npm run build` all green.
2. Tests added for the change (positive, negative, boundary, malformed
   input; authorization tests for anything permission-shaped). Never mock
   the security check itself — mocks live only at external boundaries
   (Proxmox/Guacamole/PBS/Cloudflare HTTP).
3. PR description states: what changed, threat-model impact (or "none"),
   tests added, anything intentionally not covered, and screenshots for
   any UI change. If it needs live infrastructure to verify (Guacamole
   launch, real backup, DNS), label the PR `needs-live-verify` and stop —
   do not invent workarounds, stubs, or fake verifications.

## Secrets (hard rules, no exceptions, no workarounds)

- NEVER commit `.env`, `.env.*` (except placeholders-only `.env.example`),
  `.proxvm/`, `*.log`, `*.pid`, `node_modules/`, `dist/`. Verify with
  `git check-ignore` when unsure.
- Test passwords (`Admin-Password-1!`, `must-not-leak`) are obvious fakes.
- NEVER request, accept, or store real credentials, tokens, or passwords —
  not from Vihaan, not from files, not from anywhere. If a task seems to
  require them, STOP, leave the code in working order on your branch, and
  say so in the PR description instead. A task that needs secrets needs
  Ben, and no workaround is acceptable.

## Required reading, in this order (all in this repo)

1. `CONTRIBUTING.md` — setup, scripts, and especially the authorization
   model primer (expiry, conferral, tenant visibility) before touching
   any permission-shaped code.
2. `README.md` and `SECURITY.md` (disclosure is private, never a public
   issue), plus `docs/pbs-integration.md` if touching backups.

## Environment notes (no live stack needed, ever)

- Tests run on `pg-mem` + `ioredis-mock` — no database, homelab, or
  secrets required. If the suite is green, the backend change is verified
  as far as automation can tell.
- The web SPA has no test runner: `typecheck` + `vite build` is the
  compile proof; behavior verification happens on Ben's side.
- `npm run test:integration` is maintainer-only (needs real Proxmox env) —
  never run it, never gate on it.
- Windows note: if `npm.ps1` is blocked by execution policy, invoke
  `npm.cmd`/`npx.cmd` instead. No eslint/prettier configs in this repo.
