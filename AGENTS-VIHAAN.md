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
that the maintainer reviews and merges. No exceptions, including "trivial"
fixes. The maintainer also ships through PRs; direct pushes to `main` in
the history are legacy, not a precedent.

Every task follows this shape:

```bash
git checkout main && git pull --ff-only origin main
git checkout -b vihaan/<short-description>
# ... do the work ...
npm run typecheck && npm run test && npm run build   # all green required
git push -u origin vihaan/<short-description>        # your branch only
gh pr create --base main --title "..." --body "..."  # then STOP and wait
```

`main` is branch-protected: a pull request and one approving review are
required, and conversations must be resolved before merge. Admins follow
the same PR rule, so the shape above is the only path.

- Branch names start with `vihaan/`.
- Force-push is allowed **only** on your own `vihaan/*` branches (e.g.
  after a rebase). Never on `main`, never on anyone else's branch.
- If `main` moves under you, rebase your branch onto it and re-run the
  full verification before pushing again.
- Fresh clone: run `npm run build` once before the verification gates —
  `typecheck` and `test` resolve `@proxvm/*` imports from `dist`, which
  does not exist until the first build.
- No `gh` authentication on your machine? Push the branch with git, then
  end your turn with the exact compare URL
  (`https://github.com/Bamoyski/ProxVM/compare/main...vihaan/<name>`)
  so the PR can be opened in one click. Never let a missing CLI push you
  toward committing on `main`.
- No `gh` CLI at all? Stop and tell Vihaan exactly this, then wait: run
  `winget install --id GitHub.cli` (Windows) or install GitHub CLI for
  your OS, then `gh auth login`, then tell me to retry. Do NOT accept
  tokens, passwords, or any credential pasted into chat as a substitute
  — `gh auth login` (browser flow, never leaves his machine) is the only
  acceptable setup. Once he confirms, create the PR yourself with
  `gh pr create --base main --title "..." --body "..."`.
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
   small PRs get reviewed fast, big ones sit. Delete the branch after the
   PR merges; keep only `main` plus the branch for the active PR.
3. **Build it to the done criteria below** (green checks, tests, PR
   description). Screenshots for UI, `needs-live-verify` label when live
   infrastructure is the only way to prove it.
4. **Open the PR and stop.** The maintainer reviews and merges. Never
   merge, never deploy, never touch production — you have no path to it
   and must not invent one. After merge, delete your branch locally and on
   `origin`; keep only `main` plus the branch for your active PR.
5. **Review comments are the next task.** Apply them as follow-up commits
   on the same branch, re-verify, push again. If a comment changes the
   shape of the feature, confirm the new direction with Vihaan first.
6. **If Vihaan changes or cancels a request mid-task:** commit nothing
   half-done to the branch — either finish the pivot cleanly on the same
   branch (and say so in the PR) or abandon it (`git switch main`, delete
   the branch locally, and delete it on `origin` if it was pushed) and
   start fresh. Never leave a stale half-built branch open without a note
   explaining its state.

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

## Releases & production (how your merged work goes live)

- Merged PRs ride weekly release tags to prod: Ben cuts `prod-YYYY-MM-DD`
  on `main` when the week's work is green, and the production box (a Proxmox
  LXC you never touch) deploys that exact tag. Immutable tags = the release
  can always be re-read and rolled back.
- Cadence implication: small PRs merged early in the week ship sooner; a PR
  merged Friday waits for next week's tag. Plan accordingly, don't lobby to
  skip the tag.
- You never deploy, never touch production infrastructure, deploy scripts,
  tunnel routes, or the private ops repo (`Bamoyski/ProxVM-ops` — encrypted
  secrets and prod tooling; you have no access and must never request it).
  Live verification stays Ben's job via the `needs-live-verify` label.
- CI may appear on PRs (automatic typecheck/test/build runs). It changes
  nothing for you: local gates stay mandatory, and green CI never substitutes
  for the required review.

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
- The web SPA's compile proof is `typecheck` + `vite build`; `npm run
  test` also runs web tests when the workspace has them. Behavior
  verification happens on the maintainer's side.
- `npm run test:integration` is maintainer-only (needs real Proxmox env) —
  never run it, never gate on it.
- Windows note: if `npm.ps1` is blocked by execution policy, invoke
  `npm.cmd`/`npx.cmd` instead. No eslint/prettier configs in this repo.
