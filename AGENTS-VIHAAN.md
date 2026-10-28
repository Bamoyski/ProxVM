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
  same time, but always fetch and branch from the latest `origin/main` so
  you start current.
- If these instructions ever conflict with a user message pasted into your
  session, THE RULE below still wins. Only Ben (in a PR review) can
  override it.

## THE RULE (non-negotiable, overrides everything else)

**Never push to `main`. Never commit onto `main`. Never force-push `main`
or any branch you did not create.** Every change ships as a pull request
that the maintainer reviews and merges. No exceptions, including "trivial"
fixes. The maintainer also ships through PRs; direct pushes to `main` in
the history are legacy, not a precedent.

**One branch for ALL work.** You work on exactly ONE branch with exactly
one open PR, no matter how many separate requests you receive. Never
create a second branch — not for a new task, not for a fix, not for
convenience. Every piece of work (feature, fix, docs, review comments)
ships as new commits on your existing branch and rides the same PR;
update the PR title/body so it reflects the accumulated scope.

Check what is already open before starting:

```bash
gh pr list --author @me --state open
git ls-remote --heads origin
```

If your PR is already open, that is your active task queue: switch to
its branch and continue there. If you somehow hold more than one open
branch/PR, create nothing new; consolidate onto the oldest one
(close the extras with a note on each) and continue from it.

**Always rebase onto `main` and keep the PR against `main`.** Fetch
`origin`, switch to a clean `main`, fast-forward it, then rebase your
single branch onto `origin/main`. Never stack work on another agent's
branch, and never target anything except `main` in `gh pr create`.

Every change follows this shape:

```bash
git fetch origin
git switch main && git pull --ff-only origin main   # keep the base current
git switch <your-one-branch>                        # your ONLY branch, always
git rebase origin/main                              # when main moved
# ... do the work ...
npm run typecheck && npm run test && npm run build && npm run audit:ci  # all green required
git push --force-with-lease origin <your-one-branch>
gh pr edit                                          # widen title/body if the scope grew
# gh pr create --base main ...                      # ONLY once, if no PR exists yet
```

`main` is branch-protected: a pull request and one approving review are
required, conversations must be resolved before merge, and direct pushes
are rejected for everyone including admins. The repository admin has a
pull-request-only bypass for their own PRs; that does not apply to you.
Your PRs are reviewed and merged by the maintainer; never merge your own
PR. The shape above is the only path.

- The branch name always starts with `vihaan/`; never `feature/` or `fix/`.
  That name is for life: it never changes for new work, and follow-up
  work rides the same branch even when the name stops matching the scope.
- Force-push is allowed **only** on your own `vihaan/*` branch (e.g.
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
Each request lands as one more commit on your one branch and widens its
open PR (never a new branch — see THE RULE above):

1. **Understand first.** Restate the request in your own words and check
   the repo for existing code that already does it (or something close —
   extend, don't duplicate). If the request is ambiguous, ask Vihaan
   before writing code; a wrong guess costs more than a question. If it
   touches permissions, sessions, credentials, or tenant isolation,
   re-read the authorization primer in `CONTRIBUTING.md` first.
2. **Your one branch, always** (`vihaan/...`, rebased onto latest
   `main`). New requests do NOT get new branches: land them as new commits
   on the existing branch and widen the open PR (title/body/scope).
   Rebase before pushing when `main` has moved. If the branch is deleted
   after a merge, recreate a single `vihaan/` branch from `origin/main`
   for the next batch of work.
3. **Build it to the done criteria below** (green checks, tests, PR
   description). Screenshots for UI, `needs-live-verify` label when live
   infrastructure is the only way to prove it.
4. **Keep the PR open and stop.** The maintainer reviews and merges. Never
   merge, never deploy, never touch production — you have no path to it
   and must not invent one. After a merge, delete nothing: the branch is
   your one-and-only work branch. Verify `git ls-remote --heads origin`
   shows only `main` plus your single `vihaan/` branch.
5. **Review comments are the next task.** Apply them as follow-up commits
   on the same branch, re-verify, push again. If a comment changes the
   shape of the feature, confirm the new direction with Vihaan first.
6. **Never move work between branches.** Stashes, uncommitted changes, and
   files from another feature stay on the branch where they were created.
   Before switching tasks, commit them on the current branch or discard
   them; never `git stash pop` on a new branch, and never copy a session log
   or unrelated file across branches. If a branch contains unrelated
   changes, remove them before opening the PR.
7. **If Vihaan changes or cancels a request mid-task:** commit nothing
   half-done to the branch — either finish the pivot cleanly on the same
   branch (and say so in the PR) or abandon it (`git switch main`, delete
   the branch locally, and delete it on `origin` if it was pushed) and
   start fresh. Never leave a stale half-built branch open without a note
   explaining its state.

## What "done" means for a PR

1. `npm run typecheck`, `npm run test`, `npm run build`, and
   `npm run audit:ci` all green (same gate as CONTRIBUTING.md).
2. Tests added for the change (positive, negative, boundary, malformed
   input; authorization tests for anything permission-shaped). Never mock
   the security check itself — mocks live only at external boundaries
   (Proxmox/Guacamole/PBS/Cloudflare HTTP).
3. PR description states: what changed, threat-model impact (or "none"),
   tests added, anything intentionally not covered, and screenshots for
   any UI change. If it needs live infrastructure to verify (Guacamole
   launch, real backup, DNS), label the PR `needs-live-verify` and stop —
   do not invent workarounds, stubs, or fake verifications.
4. The diff contains only files for this feature. No session logs, stashes,
   copied files, or changes from another branch.

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

## Hard-won lessons: mass ops, drift detection, and destructive remediation

Everything below came out of review on two pull requests: PR #4 (bulk VM
operations) and PR #8 (ground-truth drift detection). Every defect named
here was real, was found in review, and has a file path and an identifier
you can grep for. Read this before you write a bulk endpoint, widen a
validator, add a detection pass, or write anything that deletes.

### 1. A mass operation is a SET, never a toggle

**RULE.** A bulk endpoint receives an explicit target state and writes it,
exactly like the single-VM endpoints already do (`PATCH /vms/:id/privacy`
takes `{ enabled }`). It never derives "the other value" from what it read.

**WHY.** `POST /vms/bulk-action` in `apps/api/src/routes/vms.ts` derived
the target from the row it read: a retry flipped the flag back (one call
set `privacy_flag` true, an identical second set it false again and still
answered `{ok:true, private:false}`), and a mixed selection flipped in
opposite directions. Worst variant: isolation's "off" branch calls
`removeIsolation()` in `packages/core/src/services/firewall.ts`, which
DELETES the default-deny ruleset and resets the guest to
`policy_in: ACCEPT, policy_out: ACCEPT` — "Isolate" on a mixed selection
DE-ISOLATED the already-isolated VMs.

```ts
// BEFORE: the target is derived from the row the loop just read.
const enabled = !vm.privacyFlag;                          // privacy
const target = vm.vmClass === "user" ? "server" : "user";  // class
// AFTER: the caller supplies the target; the route writes it verbatim.
const target = body.enabled;                             // body: { ids, action, enabled }
results.push({ vmId, ok: true, private: item.private });  // persisted value
// PR #4 also shipped the mirror image: bulkSetPrivacy compared the target
// against the INVERTED flag, so "turn privacy on" wrote NOTHING and still
// returned ok: true plus a PRIVACY_ENABLED audit line.
```

**TEST.** Call the endpoint twice with the same body and assert the second
call changes nothing; on a mixed selection, assert every VM lands in the
one explicit `enabled` state.

### 2. A widened validator is a security change, not a convenience

**RULE.** When you widen a validator, first enumerate the values the
DOWNSTREAM system treats specially, then add an explicit denylist and a
test that pins the REJECTED cases, not just the accepted one.

**WHY.** `assertAddress()` in `packages/core/src/services/firewall.ts` used
to accept only IPv4/CIDR. PR #4 widened it to accept RFC-1123 hostnames so
the Guacamole host could be used as a firewall rule source — and the new
regex also matches the bare label `any`, Proxmox's SPECIAL FIREWALL
KEYWORD for `0.0.0.0/0`. Verified: `buildIsolationRules({ allowFrom:
"any" })` produced `ACCEPT in tcp 22/3389/5900:5910 source=any`, so the
"default-deny" ruleset became allow-all-inbound from the internet while
the API still reported `isolated: true`.

The same question ("what does this mean to Proxmox?") had to be asked of
the form that was ALLOWED: the CIDR branch accepted a `/0` prefix, so
`0.0.0.0/0` — the same hole spelled out — was already accepted before the
widening. Both are refused now.

```ts
// BEFORE: IPv4/CIDR only.
/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/([0-9]|[12][0-9]|3[0-2]))?$/
// AFTER: hostnames too - so the Proxmox keywords must be refused by name,
//         and a /0 prefix must be refused too.
const PROXMOX_FIREWALL_KEYWORDS = new Set(["any", "all", "$allowlist"]);
if (PROXMOX_FIREWALL_KEYWORDS.has(value.trim().toLowerCase())) {
  throw AppError.validation(`${field} must not be the Proxmox keyword "${value}"`);
}
if (match[6] !== undefined && Number(match[6]) === 0) {
  throw AppError.validation(`${field} must not be a 0.0.0.0/0 network (it would allow every source)`);
}
```

A validator shared by several routes is shared by several attack surfaces:
`assertAddress` is reached from `buildIsolationRules` AND from
`assertFirewallRuleInput` for hand-written rules.

**TEST.** Pin the REJECTED cases — `any`, `ALL`, `$ALLOWLIST`, `0.0.0.0/0`,
`1.2.3.4/33`, `*`, `a b` — not only the accepted one
(`guac.example.com`, `192.168.1.22`). Widening a validator an existing
endpoint uses is a behaviour change too: `docs/network-isolation.md`
still said "IPv4 only" afterwards — update it in the same PR.

### 3. A partial write must fail OPEN, not closed

**RULE.** When a change is several writes (a policy plus its rules, a
record plus its dependents), order them so that an interruption leaves the
system in its PREVIOUS, working state — never in a stricter one it cannot
recover from on its own.

**WHY.** `applyIsolation()` in `packages/core/src/services/firewall.ts`
used to set the guest firewall policy to DROP **first** and create the
exception rules second. A rule Proxmox refused to create — an unresolvable
DNS source, a Proxmox-side error — left the guest with `policy_in: DROP`
and no inbound exception: locked out, unreachable, while the database
still said "not isolated" and the bulk route reported the item as failed
without saying the guest was half-firewalled. `removeIsolation()` had the
mirror image (delete the rules, then open the policies), so a failed
delete left a locked-out guest with `firewall_isolated` still true.

```ts
// BEFORE: DROP first, rules second - a failure locks the guest out.
await proxmox.setGuestFirewallOptions(node, vmid, { enable: true, policy_in: "DROP", policy_out: "DROP" });
for (const rule of reversed) await proxmox.createGuestFirewallRule(node, vmid, rule);
// AFTER: enable WITHOUT changing the policy, create the rules, THEN flip it.
await proxmox.setGuestFirewallOptions(node, vmid, { enable: true });       // policy untouched
for (const rule of reversed) await proxmox.createGuestFirewallRule(node, vmid, rule);
await proxmox.setGuestFirewallOptions(node, vmid, { enable: true, policy_in: "DROP", policy_out: "DROP" });
```

The same rule applies to the reverse direction: open the policies BEFORE
deleting the rules, so a failure leaves the guest open (which is where the
operator wanted it anyway) instead of locked out.

A failed item must also be VISIBLE: the bulk route audits a failed
isolation item with `applied: false` rather than dropping it, so a
half-applied firewall is not invisible in the audit trail.

**TEST.** Stub the rule creation to throw. Assert the guest's policy is
still the pre-call one, the database flag was not flipped, and the audit
trail records the failure.

### 4. "Not observed" is not "verified fixed" — scope to the DIMENSION

**RULE.** A finding may only be auto-resolved if its check RAN for its VM
and did not reproduce. Track that per (vm, dimension): different
dimensions have different failure modes.

**WHY.** `applyFindings()` in `packages/core/src/services/drift.ts`
auto-resolved any active finding whose fingerprint was not re-emitted. It
had a per-VM `unrefined` set, but the carve-out was hardcoded to two
dimensions. Two holes, both verified: the per-VM `catch` block logged "its
findings are preserved this pass" while only ip and credential were
preserved (a thrown `qemuConfig()` auto-resolved an open `hw` finding:
`resolved = 1`, finding gone, hardware never re-checked), and
`if (!lr) continue;` skipped a VM missing from the cluster resource list
BEFORE any `unrefined.add(...)` could run, so its ip/credential findings
were auto-resolved too.

```ts
// BEFORE: unrefinedVmIds?: Set<string> + a carve-out hardcoded to "ip" | "credential".
// AFTER: per (vm, dimension) - every dimension that did not run is listed.
unrefined?: Map<string, Set<DriftDimension>>;   // vmId -> dimensions not checked
const preserved = row.vm_id && (opts.unrefined?.get(row.vm_id)?.has(row.dimension as DriftDimension) ?? false);
if (preserved) continue;
```

Mark EVERY dimension that did not run, including when the VM was skipped
entirely: agent down (ip), SSH probe in its 24h cooldown (credential) and a
failing config read (hw) are three different failures, so "unrefined" is a
per-dimension fact, not a per-VM one. The log message is part of the
contract: "its findings are preserved this pass" was a lie the code did not
implement — write it AFTER the behaviour, naming the limitation.

**TEST.** Open a finding in dimension `hw`, make `qemuConfig()` throw, run
one pass, assert the finding is still OPEN and the pass reported
`resolved: 0`.

### 5. Fail-open must never lead into a destructive path

**RULE.** Detect deletion against the FULL resource list (templates
included — a template still exists), sanity-check the cluster view before
acting on a bulk disappearance, and re-verify against an INDEPENDENT
source.

**WHY.** `detectDeletedVms()` treats "vmid absent from
`clusterResources()`" as "the guest was deleted out-of-band". But `GET
/cluster/resources` is silently PARTIAL when a node is offline or the API
token lacks `VM.Audit` on that node, and `decommissionDriftVm()` then
re-verified against THE SAME degraded source — so the re-verify passed and
it soft-deleted the VM record and hard-deleted the real Guacamole
connections for guests that were alive. A second trigger:
`findableResources()` filtered `r.template !== 1`, so a tracked VM
converted to a Proxmox TEMPLATE out-of-band was reported as `deleted`
(severity high, "VM \"web\" no longer exists in Proxmox") and could be
decommissioned even though the guest exists.

```ts
// BEFORE: templates filtered out, so "absent" meant "deleted".
.filter((r) => r && typeof r.vmid === "number" && r.template !== 1)
// AFTER: a template still exists, so it stays in the list.
.filter((r) => r && typeof r.vmid === "number")
export function clusterViewLooksDegraded(recorded: number, deleted: number): boolean {
  if (recorded < 5) return false;          // small fleets: no statistical signal
  return deleted >= 3 && deleted / recorded >= 0.2;   // partial listing, not mass deletion
}
```

The decommission path applies the same guard and refuses with 409.
"Re-verify before acting" is worthless if the re-verification uses the
same possibly-degraded source: re-verify with a per-VM API call
(`client.qemuConfig(node, vmid)`), or sanity-check the source.

**TEST.** Stub `clusterResources()` to omit 3 of 5 tracked VMs; assert the
pass reports them as deleted, and assert the decommission refuses with a
conflict instead of deleting anything.

### 6. Destructive actions need typed confirmation AND the right permission

**RULE.** A confirmation that lives only in the browser is a UX nicety, not
a control. The API must require the typed token AND the permission that
matches the blast radius.

**WHY.** The repo convention is a typed confirmation string on every
destructive route: `DELETE /vms/:id` in `apps/api/src/routes/vms.ts`
requires `body.confirmText === \`DELETE ${vm.name}\`` plus `vm.delete`;
`apps/api/src/routes/templates.ts` and `apps/api/src/routes/guacamole.ts`
require the same, and the Guacamole one ALSO requires `guac.manage`. The
drift decommission endpoint had NO server-side confirmation — the
`DECOMMISSION <name>` token existed only in `apps/web/src/pages/Drift.tsx` —
so one authenticated POST destroyed a VM record plus its Guacamole
connections, and it needed only `drift.manage`, handing a "review
findings" permission the destructive power of `vm.delete` + `guac.manage`
without either.

```ts
const body = z.object({ action: z.enum(REMEDIATE_ACTIONS), confirmText: z.string().optional() }).parse(request.body ?? {});
if (body.action === "decommission") {
  const vm = await ctx.vms.requireById(finding.vmId);
  if (body.confirmText !== `DECOMMISSION ${vm.name}`) {
    throw AppError.validation(`Confirmation text must be exactly: DECOMMISSION ${vm.name}`);
  }
  await app.requirePermission("vm.delete")(request);      // blast radius, not "drift.manage"
  await app.requirePermission("guac.manage")(request);
}
```

**TEST.** Wrong token → 400. Right token but only `drift.manage` → 403.
`vm.delete` + `guac.manage` and the right token → record and console
connections gone.

### 7. A soft delete is not a delete — replicate the canonical cleanup

**RULE.** When you write a new path that soft-deletes, copy the cleanup
list from the canonical delete path, and diff the two functions side by
side before you ship.

**WHY.** `DELETE /vms/:id` in `apps/api/src/routes/vms.ts` stops the
guest, deletes it in Proxmox, then cleans up the ProxVM records. The drift
decommission only called `softDelete`. Because that is an UPDATE, the FK
cascades never fire — `vm_credentials`, `vm_access` and `vm_power_periods`
are all `ON DELETE CASCADE` on `vms(id)`, and an UPDATE does not trigger
them. So `vm_access` grants survive, `vm_credentials` survives (the
encrypted password of a decommissioned VM is still stored), and
`vm_power_periods` keeps an OPEN row: `reconcileVmPower()` only closes it
when it can reach the guest, the metering ticker skips VMs whose
`qemuStatus` throws, and `monthlyUsage()` counts "Open periods count up to
now". Usage kept accruing for a VM that no longer existed.

```ts
await ctx.guac.deleteVmResources(vm.id, guacDb);   // real console connections
await ctx.creds.delete(vm.id);                     // vault entries
await closePowerPeriod(ctx.db, vm.id);             // metering
await ctx.vms.softDelete(vm.id);
await ctx.vms.revokeAllAccess(vm.id);              // "Soft-delete does not trigger FK cascades"
```

**TEST.** After the decommission path, assert there is no `vm_access` row,
no `vm_credentials` row, and no open `vm_power_periods` row for that VM —
not merely that the `vms` row is soft-deleted.

### 8. New background work that touches credentials is opt-in and rate-limited

**RULE.** (1) New background features default OFF and ship with a real UI
toggle, not just a settings row. (2) Anything that opens network
connections or costs money gets a per-route rate limit. (3) The "only one
at a time" guard must live where BOTH the ticker and the manual endpoint
can reach it.

**WHY.** `drift.enabled` only skipped the pass when the stored value was
literally the string `"false"`, so UNSET meant ENABLED. There was no
seeded default and no UI toggle — the key was written nowhere outside
tests — so every install ran a full drift pass every 15 minutes, including
up to 10 real SSH PASSWORD login attempts against guests
(`MAX_CREDENTIAL_PROBES_PER_PASS` in
`packages/core/src/services/drift.ts`), plus admin alerts. The repo
convention for expensive endpoints is an explicit per-route limit:
`POST /discovery/run` → `rateLimit: { max: 10, timeWindow: "1 hour" }`,
`apps/api/src/routes/guacamole.ts` → 10/hour,
`apps/api/src/routes/backups.ts` → 5/hour. The drift manual run had only
the global 400/min, and it called `runDriftPass` DIRECTLY, bypassing the
ticker's in-flight guard (`driftInFlight` was a closure local to
`startHomelabTickers` in `apps/api/src/app.ts`), so a manual run could
stack with a ticker pass and defeat the 24h probe cooldown.

```ts
// BEFORE: the guard lived in the ticker's closure; the route bypassed it.
let driftInFlight = false;   // local to startHomelabTickers in apps/api/src/app.ts
// AFTER: one exported guard both callers can reach, plus a route limit.
let driftPassInFlight = false;
export async function runDriftPassOnce(deps: DriftPassDeps): Promise<DriftPassResult | null> {
  if (driftPassInFlight) return null;      // one at a time, whoever asked
  driftPassInFlight = true;
  try { return await runDriftPass(deps); } finally { driftPassInFlight = false; }
}
// apps/api/src/routes/drift.ts - the route rate limit plus the shared guard.
app.post("/drift/run", { preHandler: app.requirePermission("drift.manage"),
  config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
  async () => runDriftPassOnce(buildDriftPassDeps(ctx)));
```

"Unset means off" is the important half: the pass now treats anything
other than an explicit `"true"` as disabled, and the operator gets a real
toggle in Settings → Application (`driftEnabled` on `PUT /settings/app`).

**TEST.** With `drift.enabled` unset, assert the ticker performs no pass.
Start a pass and immediately POST `/drift/run`; assert the second call
reports "already running" instead of starting a second pass.

### 9. An existence oracle is a disclosure

**RULE.** Run the AUTHORIZATION check FIRST, and make "not found" and "not
allowed" answer identically. Never let a helper's `NOT_FOUND` leak past
the access gate.

**WHY.** The bulk loop called `ctx.vms.requireById(vmId)` BEFORE the access
check, so the per-item error distinguished `"VM not found"` from `"No
access to this VM"`. The single-VM endpoints return a generic 403 for
both, because `visibleTo()` returns `allowed: false` for a missing VM. For
the privacy action the access check was skipped entirely, so ANY
authenticated user got an existence + grant oracle out of the error
strings: probe a UUID, and the difference between "VM not found" and "No
access to this VM" tells you whether the VM exists and whether you hold a
grant on it.

```ts
// BEFORE: the existence lookup ran first, so its NOT_FOUND leaked.
const vm = await ctx.vms.requireById(vmId);
if (action !== "privacy") { const access = await resolveVmAccess(request, vmId); ... }
// AFTER: the access gate runs first, and both refusals read the same.
const access = await resolveVmAccess(request, vmId);
if (!access.allowed) throw AppError.forbidden("No access to this VM");
const vm = await ctx.vms.requireById(vmId);
```

**TEST.** Call the bulk endpoint with a random UUID and with the UUID of a
VM you cannot see; assert both return the same status code and message.

### 10. Do not change a shared write helper without auditing every caller

**RULE.** A shared setter's contract is every caller's contract. Before
you change one: (1) grep every caller, (2) decide whether each caller's
behaviour changes, (3) make the INVARIANT hold on every write path, not
just the one you touched, and (4) write the behaviour change into the PR
description and the docs.

**WHY.** Moving a guard into `setVmClass()` in
`packages/core/src/services/vms.ts` changed the behaviour of the
pre-existing single-VM endpoint `PATCH /vms/:id/class`: it now returns 400
for a request that previously succeeded, and the PR body described only
the bulk path. It also changed `setVmClass` to skip the write when the
class is unchanged, while the routes still audited `VM_EDITED` — an audit
entry for a mutation that did not happen. And the guard was ONE-SIDED:
`POST /api/schedules` never looked at `vm_class`, so you could still
create the exact conflict the guard existed to prevent (verified: creating
an enabled schedule on a user-class VM returned 200).

```ts
// BEFORE: the guard lived only in the bulk path.
await this.db.query("UPDATE vms SET vm_class = $2 ...", [id, vmClass]);
// AFTER: the shared setter blocks server -> user, and EVERY write path asks.
async setVmClass(id: string, vmClass: "server" | "user"): Promise<boolean> {
  if (vmClass === "user" && vm.vmClass !== "user") { /* enabled vm_schedules? refuse */ }
}
// apps/api/src/routes/vms.ts - the schedule write blocks create/enable too.
app.post("/schedules", async (request) => {
  if (vm.vmClass === "user") throw AppError.validation("A user-class VM may not have an enabled schedule");
```

**TEST.** `rg "setVmClass\(" --type ts` lists every caller; assert each
caller's documented behaviour still holds, and assert `POST /schedules` on
a user-class VM is refused too.

### 11. A "bulk" helper that is called with one element is not a bulk helper

**RULE.** If the signature says "bulk", the implementation must be one
pass with one write per item, and the caller must pass the whole array.
Otherwise rename it to the single-item thing it really is.

**WHY.** `bulkSetPrivacy`, `bulkSetVmClass`, `bulkToggleIsolation` and
`bulkSetStartOnBoot` all take an array, but the route called them one
item at a time. The "bulk" orchestration was in the route; the helpers
were single-item wrappers with array-shaped signatures. Each call re-read
the VM, so the request was N+1 queries, and the `[0]` indexing meant the
helper's own per-item error handling was re-implemented by the route's
`catch`.

```ts
// BEFORE: the route called the "bulk" helper one item at a time.
const item = (await ctx.vms.bulkSetPrivacy([vmId], enabled, user.id, user.roles))[0];
// AFTER: the whole array goes in, one write per item inside the helper.
const items = await ctx.vms.bulkSetPrivacy(body.ids, target, user.id, user.roles);
for (const item of items) results.push({ vmId: item.vmId, ok: item.ok, error: item.error });
```

**TEST.** Assert the number of VM reads for a 10-item selection is 10, not
10 reads plus 10 re-reads inside the helper.

### 12. The PR description is part of the deliverable

**RULE.** Write the description LAST, from the diff, not from memory. Every
number in it must be verifiable from the branch. If you push follow-up
commits that change the design, update the description in the same push.

**WHY.** PR #4's description had drifted from the code in five separate
ways: it documented per-action permission arrays the code did not use
(`privacy requires ["vm.manage"]` when the code had NO policy permission
at all for privacy; `class/isolation/start-on-boot require
["vm.manage","vm.edit"]` when the code required `["vm.edit"]` only); it
quoted core method signatures with parameters that did not exist
(`bulkToggleIsolation(vmIds, enabled, userId, roles, proxmox?)` against
the real `(vmIds, enabled, proxmox?, opts?)`); it described behaviour the
code never implemented ("reports the post-write visibility state via
`visibleTo()`"); it quoted wrong file sizes and test counts; and it claimed
"branch is current with origin/main (no divergence)" when the branch was 13
commits behind and CONFLICTED with main. A reviewer trusts the
description and stops looking; a description that lies about permissions
is worse than no description at all.

### 13. Keep one branch's session log out of another branch's diff

**RULE.** Before you push, read `git diff main...HEAD --stat` and check
every file for content that does not belong to this PR.

**WHY.** PR #8 added ~87 lines to `AGENTS-VIHAAN.md` that were the
session log of a DIFFERENT feature branch (PR #4), carried in by a commit
titled "docs: session log for ground-truth drift (merge stash from
bulk-vm-ops)". A stash pop or a merge from another branch is the usual
cause. Session logs belong in the branch they describe.

```bash
git diff main...HEAD --stat
git diff main...HEAD -- AGENTS-VIHAAN.md
```

### Pre-flight checklist

Run through this before you open a PR:

1. **Mass ops** — set semantics? Does every bulk action take an explicit
   target (`enabled` / `vmClass`), so a retry and a mixed selection do the
   same thing? Does the response report the PERSISTED value?
2. **Widened validator** — did you enumerate what the downstream system
   treats specially (`any`, `ALL`, `$ALLOWLIST`, a `/0` prefix)? Is there a
   denylist and a test pinning the REJECTED cases? Did the "IPv4 only"
   doc get updated?
3. **Partial write** — does an interruption leave the system in its
   PREVIOUS working state? Is the strict setting applied LAST, after the
   permissive one? Does a failed item still show up in the audit trail?
4. **Drift scope** — is every dimension that did not run marked unrefined,
   per (vm, dimension)? Does the log message say what the code does?
5. **Destructive path** — is the typed confirmation enforced SERVER-side?
   Is the permission the blast radius (`vm.delete` + `guac.manage`)?
6. **Soft delete** — does your new path replicate the canonical delete
   path's cleanup (creds, access rows, power periods, Guacamole)?
7. **New background feature** — does it default OFF (unset means off) AND
   ship a UI toggle? Does it have a per-route rate limit? Can the ticker
   AND the manual endpoint both reach the in-flight guard?
8. **Shared helper** — did you grep every caller and decide whether each
   caller's behaviour changes? Does the invariant hold on EVERY write
   path? Is the behaviour change in the PR description?
9. **Authorization** — does the access gate run BEFORE the existence
   lookup, and do "not found" and "not allowed" answer identically?
10. **Bulk helper** — is it really one pass with one write per item, and
    does the caller pass the whole array?
11. **PR description** — written LAST from the diff? Every number
    verifiable from the branch? Does it match what the code does?
12. **Diff hygiene** — `git diff main...HEAD --stat` read; no stray session
    log, no other branch's file.

## Running the development web server

The ProxVM web application can be started for local development. Choose
the method that works best for your environment (note: PowerShell execution
policy blocks `npm.ps1`, so always use `npm.cmd`/`npx.cmd`):

### Method 1: Using the npm script (recommended)
```bash
npm run dev:web
```
This starts the Vite development server for the web app at
`http://localhost:5173` (or another port if 5173 is in use).

### Method 2: Direct vite command
```bash
npx vite
# Or, if npx is blocked by execution policy:
npx.cmd vite
```

### Method 3: Using the bin directly (when scripts are blocked)
```bash
./node_modules/.bin/vite
# If even that is blocked:
./node_modules/.bin/vite.cmd
```

### Method 4: Alternative port if 5173 is occupied
```bash
PORT=3000 npm run dev:web
# Or:
vite --port 3000
```

### What you will see
After starting the dev server, open `http://localhost:5173` in a browser.
You should see:
1. The initial "Loading ProxVM…" spinner
2. The Welcome/educational page appearing briefly for ~2.5 seconds
   — this contains a generic scholarly introduction about virtual
   infrastructure management, remote access, and system administration
3. Automatic transition to dashboard (if authenticated) or login page

### Stopping the server
Press `Ctrl+C` in the terminal where the dev server is running.

### Verification for UI changes
When implementing new features, create a screenshot of the exact change
using the development server (`npm run dev:web`), and include it in the
PR description or task report. Verification ensures the welcome page
transition, spinner display, and content rendering all appear as intended
before the change is considered complete.

For full development workflow, also run typecheck and tests:
```bash
npm run typecheck
npm run test
```
