# Proxmox Backup Server integration (baseline structure)

No PBS exists in this infrastructure yet. This document describes the
scaffolding that is already in place so bringing PBS up is configuration +
scheduling, not architecture.

## What exists today

- `packages/core/src/pbs/client.ts` — `ProxmoxBackupClient` shaped against
  the public PBS API2 surface: `version()`, `listDatastores()`,
  `listBackupGroups()`, and a `startBackup()` that deliberately throws 501
  until the live phase. Auth is `PBSAPIToken=user@realm!token=secret`.
  Unit-tested against mocked HTTP only (see `pbs-client.test.ts`).
- `SettingsService.pbs()` — reads `pbs.url` (required), `pbs.token_id`,
  `pbs.token_secret`, `pbs.datastore` (encrypted at rest like all secrets).
- `CoreContext.getPbsClient()` — returns a client or `null` when
  unconfigured. Every caller must handle null (PBS is optional).
- `GET /api/pbs/status` (admin) — `{configured, reachable, version|null}`.
  The single live call it ever makes is `version()`.

## Bringing PBS up (when the box exists)

1. Install PBS, create a datastore, mint an API token with Datastore
   read/write on it.
2. Save URL + token (+ default datastore) — Settings UI for PBS creds does
   not exist yet; insert settings rows directly or build the (small) UI.
3. `GET /api/pbs/status` should flip to `{configured: true, reachable: true}`.
4. Build backup scheduling on top: per-VM schedule (reuse the `vm_schedules`
   machinery or a new `pbs_schedules` table), worker-side execution calling
   PVE guest backup toward the PBS datastore, UPID tracking, `startBackup()`
   implemented for real, verify + prune flows, and retention UI.

## Deliberately not done yet

- No backup execution, no scheduling, no restore paths.
- No fingerprint pinning (self-signed PBS certs): terminate behind trusted
  TLS or a reverse proxy; the client accepts the parity flag but the default
  fetch path cannot skip verification per-request.
- No PBS UI anywhere (main app or Overwatch) beyond the status endpoint.
