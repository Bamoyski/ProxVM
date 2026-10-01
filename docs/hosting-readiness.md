# Hosting readiness — overnight audit (2026-09-30)

Verdict first: **no blocking defects found.** The sections below are what was
checked, what passed, and the small list of things to do before taking money.

## What was audited

- Full suites green at start and end: core 129→134, api 114→122 (+1 pre-existing skip).
- Live `api`/`worker` logs: quiet (only settings changes + logins in 24h).
- Migrations: files 001–012 all applied exactly once on the live DB, in order.
- Route auth: all 15 route files walked — every endpoint carries a guard
  (`requirePermission`/`requireAuth`/preHandler) except deliberately public
  ones (login/register/health/setup-status/share-redeem/domains-public).
- SQL: all dynamic queries parameterized; the single backtick query is the
  static `schema_migrations` bootstrap.
- Background work: all three tickers (schedules, health, metering) and both
  cleanups (sessions, audit retention) wrap every step in try/catch, unref
  timers, and clear on shutdown. No unhandled-rejection paths.
- Crypto: session/CSRF/share tokens all `randomBytes(32)`; no `eval`,
  no `innerHTML`, no secrets in `localStorage` (theme + layout prefs only).
- Queue: single attempt, bounded retention (500 complete / 1000 failed) —
  retries are explicit human actions, so no retry storms.
- Exports: audit CSV capped at 50k rows with offset paging.
- Frontend: no hook-order violations; permission gating mirrors the backend
  (UX only, backend authoritative — spot-checked).

## Findings (all minor)

1. **Clock skew across boxes.** Earlier debugging showed the Guacamole DB host
   hours behind the app host (correlated identical events). Current check
   shows host = api = postgres in agreement. Fix: enable NTP everywhere
   (app host, Guacamole/DB host, all guests) and re-verify; session/crypto
   timestamps assume sane clocks.
2. **Audit retention defaults to keep-forever.** Correct conservative default,
   but a hosting platform accumulates audit rows indefinitely. Recommendation:
   set `audit.retention_days` (Settings → Application, e.g. 365) once billing
   starts. Deliberately NOT changed automatically — deleting customer data by
   surprise is worse than disk usage.
3. **pg-mem gaps (tests only, not production):** `gen_random_uuid()`,
   self-referencing `CHECK` on `ADD COLUMN`, `char_length(text)`,
   `LEAST/GREATEST` on timestamptz, date-vs-timestamptz comparison. Migration
   012 was shaped around all five (app-generated IDs, app-side validation,
   `VARCHAR` bounds, TS-side month math). Rule going forward: keep new
   migrations to the constructs in 001–012 and tests stay honest.
4. **USER role cannot provision** (no `vm.create`): by design, but it means
   the quota gate only ever fires for OPERATOR+ today. Documented in quotas.

## Before taking money

- [ ] Human security review of auth/session/crypto paths (AI-generated code
      carrying the production warning until then — that warning is load-bearing).
- [ ] NTP on all boxes (app host, Guacamole/DB host, all guests); alerting on clock drift.
- [ ] Set `audit.retention_days` (billing history vs. disk tradeoff, your call).
- [ ] Backups: Postgres point-in-time + `.proxvm/config.json` (master key!)
      tested restore. Losing the master key = losing every vault credential.
- [ ] Uptime monitoring on `/api/health/live` from outside the LAN.
- [ ] Rate-limit review for the new ticket endpoint under adversarial use
      (currently 20/hour per IP — fine, revisit if abused).
- [ ] Incident runbook: break-glass doc exists (`docs/break-glass.md`) —
      rehearse it once.
