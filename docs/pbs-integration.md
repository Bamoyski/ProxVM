# Proxmox Backup Server integration (live)

PBS is configured and reachable in this infrastructure
(`GET /api/pbs/status` → `{configured: true, reachable: true}`).
This document describes what is wired up and what remains.

## What exists today

- `packages/core/src/pbs/client.ts` — `ProxmoxBackupClient` against the
  PBS API2 surface: `version()`, `listDatastores()`,
  `listBackupGroups()`, and a `startBackup()` that deliberately throws 501
  until backup execution is built. Auth is
  `PBSAPIToken=user@realm!token:secret` (colon separator — PVE-style `=`
  yields `invalid token name`). TLS verification is honored per-request via
  the `verifySsl` option (defaults true; `pbs.verify_ssl=false` allows
  self-signed homelab certs). Unit-tested against mocked HTTP
  (see `pbs-client.test.ts`), plus live verification against PBS 4.2.
- `SettingsService.pbs()` — reads `pbs.url` (required), `pbs.token_id`,
  `pbs.token_secret` (encrypted at rest like all secrets), `pbs.verify_ssl`
  (default true), `pbs.datastore`.
- `CoreContext.getPbsClient()` — returns a client or `null` when
  unconfigured. Every caller must handle null (PBS is optional).
- `GET /api/pbs/status` (admin) — `{configured, reachable, version|null}`.
  The single live call it ever makes is `version()`.

## PBS-side requirements (learned live)

1. Create datastore, user, and API token; the token needs its OWN ACL
   entry on the datastore (e.g. `DatastoreAdmin` + `DatastoreAudit`).
2. The owning user needs rights on the datastore too: effective token
   permissions are the intersection of token and user ACLs. A fully
   privileged token under a rightless user sees nothing (empty datastore
   list, 403 on groups).
3. Self-signed PBS certs need `pbs.verify_ssl=false`, or terminate behind
   trusted TLS / a reverse proxy.

## What is live (backup build-out)

- `pbs_backup_schedules` + `pbs_backups` tables (migration 017): timetables
  plus a crash-safe run state machine (PENDING → RUNNING → OK|FAILED).
- Execution runs through Proxmox VE `vzdump` (`ProxmoxClient.createBackup`,
  modes snapshot|suspend|stop); the PBS client handles reads (snapshots),
  retention pruning (`pruneSnapshots` + `pbsTaskStatus`), and its old
  `startBackup()` stub now explicitly redirects to the PVE path.
- The minute ticker (`runBackupPass` in `startHomelabTickers`) queues due
  schedules, starts pending runs (task creation only, never waits), and
  finalizes running ones by polling — with creator re-authorization
  (revoked creators' schedules/runs are skipped, never executed) and full
  audit (`BACKUP_SCHEDULE_CREATED/UPDATED/DELETED`, `BACKUP_STARTED`,
  `BACKUP_FINISHED`, `BACKUP_SKIPPED`, `BACKUP_PRUNED`).
- API (`routes/backups.ts`, `vm.manage`/`vm.read` + per-VM visibility):
  schedule CRUD, async trigger-now and prune-now (202 + run id, 10/hour
  rate limits, per-VM pile-up cap of 3), run history, PBS snapshots
  (projected safe fields only).
- Mass operations: `POST /backups/schedules/bulk` (one timetable across up
  to 50 VMs, per-VM results), `POST /backups/run-bulk` (queue one run per
  VM, 5/hour), and `GET /backups/overview` (one row per visible VM with
  schedule coverage, latest run, and latest snapshot from a single PBS
  groups call).
- Web UI: Backups page (fleet overview with multi-select, presets like
  "Nightly keep 7", bulk schedule/run actions, per-VM runs and snapshots),
  gated on `vm.manage` like Schedules.

## Still to build

1. Restore flows (deliberately deferred: overwriting a live VM from backup
   is destructive and needs its own design review; snapshots are browsable
   read-only today).
2. PBS verify-job management and S3/offsite targets.
3. Settings UI for PBS creds (still direct settings-row inserts).

## Deliberately not done yet

- No restore paths: overwriting a live VM from backup is destructive, so
  snapshots stay browsable read-only until restore gets its own design
  review.
- No fingerprint pinning for self-signed PBS certs (currently trust-on-
  first-use via `verify_ssl=false`, same posture as the PVE client).
