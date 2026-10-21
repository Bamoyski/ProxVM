// ---------------------------------------------------------------------------
// drift.ts — Ground-truth drift detection & reconciliation.
//
// The app DB is ProxVM's model of reality; Proxmox, the guests, and the
// Guacamole database are reality. Background passes compare the two and
// persist findings with a lifecycle:
//
//   OPEN -> ACKNOWLEDGED -> RESOLVED (auto | manual | remediation)
//     ^__________ re-detected drift re-opens the same row (occurrences +1)
//
// Contract differences vs threats.ts (which is stateless on purpose):
// - Findings are PERSISTED. Remediation needs a stable target across
//   passes, ACKNOWLEDGED must survive recomputation, and resolved_at
//   history is the whole point. Fingerprints are deterministic; a
//   re-detected drift re-opens the same row instead of spawning dupes, so
//   nothing stuck-desyncs either.
// - Detection runs are pure per dimension (testable without Proxmox);
//   the orchestrator adapts IO to their inputs and never adapts inputs to
//   make a detector happy.
// - Remediation RE-VERIFIES the drift at action time and refuses 409-style
//   when the finding is stale or the VM has an active provisioning job:
//   acting on stale data is precisely the race this feature exists for.
// - Remediation never destroys guest state. The most destructive action
// (decommission) soft-deletes ProxVM's own DB record and its Guacamole
// connection; the Proxmox guest itself is never touched.
//
// Exemptions: any VM with a non-terminal provisioning job is skipped
// entirely (config/IP/credentials legitimately disagree mid-provisioning,
// and the job pipeline owns those fields).
//
// Hardware drift (cores/memory/net): the DB has NO model of these values,
// so detection is pass-to-pass against a stored per-VM snapshot; in-band
// edits bump the snapshot AFTER Proxmox accepts (bumpHardwareSnapshot, called
// by the vm edit route), so ProxVM's own changes never read as drift.
// ---------------------------------------------------------------------------

import type { Pool } from "pg";
import type { ProxmoxQemuResource } from "@proxvm/shared";
import { AppError } from "../util/errors.js";
import { newId } from "../util/misc.js";
import type { Logger } from "../util/logger.js";
import type { AuditEntryInput } from "./audit.js";
import type { SettingsService } from "./settings.js";
import type { AuditService } from "./audit.js";
import type { VmsRepository } from "./vms.js";
import type { JobsRepository } from "./jobs.js";
import type { CredentialsService } from "./credentials.js";
import type { GuacamoleService } from "./guacamole.js";
import type { HostKeyService } from "../ssh/host-keys.js";
import { probeSsh } from "../ssh/client.js";
import { selectUsableIpv4 } from "../provisioning/pipeline.js";
import type { ProxmoxClient } from "../proxmox/client.js";
import type { GuacamoleDbClient } from "../guacamole/db.js";
import type { GuacConnectionRow } from "./rows.js";

export const DRIFT_ENABLED_KEY = "drift.enabled";
export const DRIFT_LAST_RUN_KEY = "drift.last_run";
/** Min interval between credential probes of the same VM (rate-limit safety). */
export const CREDENTIAL_PROBE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Cap on findings resolved/created per pass surfaced in alerts (bounded work). */
const MAX_CREDENTIAL_PROBES_PER_PASS = 10;

export const DRIFT_DIMENSIONS = ["deleted", "hw", "config", "ip", "guac", "credential"] as const;
export type DriftDimension = (typeof DRIFT_DIMENSIONS)[number];

export const DRIFT_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type DriftSeverity = (typeof DRIFT_SEVERITIES)[number];

export const DRIFT_STATUSES = ["OPEN", "ACKNOWLEDGED", "RESOLVED"] as const;
export type DriftStatus = (typeof DRIFT_STATUSES)[number];

export interface DriftFindingRecord {
  id: string;
  fingerprint: string;
  dimension: DriftDimension;
  severity: DriftSeverity;
  vmId: string | null;
  connectionId: string | null;
  title: string;
  summary: string;
  detail: Record<string, unknown>;
  status: DriftStatus;
  occurrences: number;
  firstSeen: Date;
  lastSeen: Date;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  resolvedAt: Date | null;
  resolvedReason: string | null;
  remediatedAt: Date | null;
  remediatedBy: string | null;
}

export interface DriftLiveResource {
  vmid: number;
  node: string;
  name: string | null;
  status: string;
}

export interface HardwareSnapshot {
  cores: number | null;
  memoryMb: number | null;
  net: string | null;
}

/** A single detection output, before persistence. */
export interface Detected {
  fingerprint: string;
  dimension: DriftDimension;
  severity: DriftSeverity;
  vmId: string | null;
  connectionId?: string | null;
  title: string;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface DriftPassResult {
  created: number;
  updated: number;
  resolved: number;
  exempted: number;
  liveChecked: boolean;
  newFingerprints: string[];
  skipped: "disabled" | "unconfigured" | "proxmox_down" | null;
}

// --- Pure detectors ---------------------------------------------------------

/** Out-of-band deleted VMs: app-recorded vmids absent from live qemu resources. */
export function detectDeletedVms(
  recorded: Array<Pick<VmRecordLite, "id" | "vmid" | "node" | "name">>,
  live: DriftLiveResource[],
): Detected[] {
  const liveVmidHasQemu = new Set(live.map((r) => r.vmid));
  const out: Detected[] = [];
  for (const vm of recorded) {
    if (liveVmidHasQemu.has(vm.vmid)) continue;
    out.push({
      fingerprint: `deleted:${vm.id}`,
      dimension: "deleted",
      severity: "high",
      vmId: vm.id,
      title: `VM "${vm.name}" no longer exists in Proxmox`,
      summary:
        "The record is active in ProxVM but no guest with that vmid exists anywhere in the cluster (templates excluded). The guest was deleted out-of-band. Decommission the record to drop it and its Guacamole connections.",
      detail: { vmid: vm.vmid, lastKnownNode: vm.node },
    });
  }
  return out;
}

/**
 * Name/node drift. Comparison is case-insensitive on purpose: Proxmox
 * lowercases resource names, so a case change alone is not a rename — and
 * adopting a lowercased name would degrade ProxVM's display names.
 */
export function detectConfigDrift(
  recorded: Array<Pick<VmRecordLite, "id" | "vmid" | "node" | "name">>,
  live: DriftLiveResource[],
): Detected[] {
  const byVmid = new Map(live.map((r) => [r.vmid, r]));
  const out: Detected[] = [];
  for (const vm of recorded) {
    const lr = byVmid.get(vm.vmid);
    if (!lr) continue;
    if (
      (lr.name ?? "").toLowerCase() !== vm.name.toLowerCase() &&
      vm.name.length > 0
    ) {
      out.push({
        fingerprint: `config:${vm.id}:name`,
        dimension: "config",
        severity: "low",
        vmId: vm.id,
        title: `VM "${vm.name}" was renamed out-of-band`,
        summary: `Proxmox reports the name as "${lr.name ?? "?"}" while ProxVM records "${vm.name}". Adopt to sync the record, or rename it back.`,
        detail: { field: "name", recorded: vm.name, live: lr.name ?? null },
      });
    }
    if (lr.node !== vm.node) {
      out.push({
        fingerprint: `config:${vm.id}:node`,
        dimension: "config",
        severity: "medium",
        vmId: vm.id,
        title: `VM "${vm.name}" moved to node "${lr.node}"`,
        summary: `ProxVM records node "${vm.node}"; the guest now lives on "${lr.node}". If this was a manual Proxmox migration, adopt to sync.`,
        detail: { field: "node", recorded: vm.node, live: lr.node },
      });
    }
  }
  return out;
}

/** Canonical net string: stable stringify of the qemuConfig net array. */
export function canonNet(net: Array<Record<string, unknown>> | null | undefined): string | null {
  if (!net || net.length === 0) return null;
  return JSON.stringify(net);
}

/**
 * Hardware drift: cores/memory/net0 vs the last stored snapshot. No stored
 * snapshot = first sighting, never a finding (the orchestrator establishes
 * the baseline this pass). Detail carries recorded+live for the adopt flow.
 */
export function detectHardwareDrift(
  vmId: string,
  vmName: string,
  stored: HardwareSnapshot | null,
  live: { cores: number; memory: number; net: Array<Record<string, unknown>> | null },
): Detected[] {
  if (!stored || stored.cores == null || stored.memoryMb == null) return [];
  const liveNet = canonNet(live.net);
  const out: Detected[] = [];
  const fields: Array<[string, string | number | null, string | number | null]> = [
    ["cores", stored.cores, live.cores],
    ["memoryMb", stored.memoryMb, live.memory],
    ["net", stored.net, liveNet],
  ];
  for (const [field, recorded, nowValue] of fields) {
    if (String(recorded) === String(nowValue)) continue;
    out.push({
      fingerprint: `hw:${vmId}:${field}`,
      dimension: "hw",
      severity: "medium",
      vmId,
      title: `Hardware changed on VM "${vmName}" (${field})`,
      summary: `${field} changed out-of-band: ${String(recorded)} -> ${String(nowValue)}. If the change was deliberate, adopt to record the new baseline; otherwise revert it in Proxmox.`,
      detail: { field, recorded, live: nowValue },
    });
  }
  return out;
}

/** DHCP IP changes: only compared for DHCP (non-static), recorded addresses. */
export function detectIpDrift(
  vm: { id: string; name: string; ipAddress: string | null; ipStatic: boolean },
  liveIp: string | null,
): Detected[] {
  if (!vm.ipAddress || vm.ipStatic) return [];
  if (!liveIp) return [];
  if (liveIp === vm.ipAddress) return [];
  return [
    {
      fingerprint: `ip:${vm.id}`,
      dimension: "ip",
      severity: "medium",
      vmId: vm.id,
      title: `IP changed on VM "${vm.name}"`,
      summary: `The guest agent reports ${liveIp} while ProxVM records ${vm.ipAddress}. Re-sync to update the record and Guacamole connection endpoints.`,
      detail: { recorded: vm.ipAddress, live: liveIp },
    },
  ];
}

/** Orphaned Guacamole connection records: vm_id points at a live-less VM. */
export function detectOrphanGuac(
  connections: Array<Pick<GuacConnectionRow, "id" | "vm_id" | "guac_connection_name">>,
  knownVmIds: Set<string>,
): Detected[] {
  const out: Detected[] = [];
  for (const conn of connections) {
    if (knownVmIds.has(conn.vm_id)) continue;
    out.push({
      fingerprint: `guac:${conn.id}`,
      dimension: "guac",
      severity: "low",
      vmId: conn.vm_id,
      connectionId: conn.id,
      title: `Orphaned Guacamole connection "${conn.guac_connection_name}"`,
      summary:
        "This connection record points at a VM that no longer exists in ProxVM (deleted or decommissioned). Delete it to clean up the real Guacamole database entry.",
      detail: { connectionRecordId: conn.id, guacConnectionName: conn.guac_connection_name },
    });
  }
  return out;
}

interface VmRecordLite {
  id: string;
  vmid: number;
  node: string;
  name: string;
  status: string;
  osType: string | null;
  osName: string | null;
  ipAddress: string | null;
  ipStatic: boolean;
}

// --- Persistence ------------------------------------------------------------

export interface ApplyOpts {
  /** Last-seen row (Date) for idempotent upserts/in resolve stamps. */
  now: Date;
  /** VMs exempt this pass: their findings are preserved, never auto-resolved. */
  exemptVmIds?: Set<string>;
  /** VMs whose ip/credential comparison did NOT run this pass (probe skipped,
   * agent down, stopped...): their ip/credential findings are preserved. */
  unrefinedVmIds?: Set<string>;
  /**
   * Whether findings that did not reproduce get auto-resolved this call.
   * The orchestrator's main pass leaves this on; internal callers (the
   * credential probe writes a single finding) MUST pass false or they
   * would resolve every other open finding they did not re-emit.
   */
  resolveStale?: boolean;
}

function toFindingRecord(row: Record<string, unknown>): DriftFindingRecord {
  return {
    id: String(row.id),
    fingerprint: String(row.fingerprint),
    dimension: String(row.dimension) as DriftDimension,
    severity: String(row.severity) as DriftSeverity,
    vmId: (row.vm_id as string | null) ?? null,
    connectionId: (row.connection_id as string | null) ?? null,
    title: String(row.title),
    summary: String(row.summary),
    detail: typeof row.detail === "object" && row.detail !== null ? (row.detail as Record<string, unknown>) : {},
    status: String(row.status) as DriftStatus,
    occurrences: Number(row.occurrences ?? 1),
    firstSeen: row.first_seen as Date,
    lastSeen: row.last_seen as Date,
    acknowledgedAt: (row.acknowledged_at as Date | null) ?? null,
    acknowledgedBy: (row.acknowledged_by as string | null) ?? null,
    resolvedAt: (row.resolved_at as Date | null) ?? null,
    resolvedReason: (row.resolved_reason as string | null) ?? null,
    remediatedAt: (row.remediated_at as Date | null) ?? null,
    remediatedBy: (row.remediated_by as string | null) ?? null,
  };
}

/**
 * Persist detection output: upsert findings by fingerprint, auto-resolve
 * active findings that did not reproduce (except preserved VMs), and count.
 * Pure lifecycle logic over the DB — separated from IO so tests can drive
 * every transition directly.
 */
export async function applyFindings(
  db: Pool,
  detected: Detected[],
  opts: ApplyOpts,
): Promise<{ created: number; updated: number; resolved: number; newFingerprints: string[] }> {
  const nowIso = opts.now.toISOString();
  let created = 0;
  let updated = 0;
  const newFingerprints: string[] = [];

  for (const d of detected) {
    const existing = await db.query<{ id: string; status: string }>(
      "SELECT id, status FROM drift_findings WHERE fingerprint = $1",
      [d.fingerprint],
    );
    const prior = existing.rows[0];
    if (!prior) {
      await db.query(
        `INSERT INTO drift_findings (id, fingerprint, dimension, severity, vm_id, connection_id,
           title, summary, detail, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'OPEN')`,
        [
          newId(),
          d.fingerprint,
          d.dimension,
          d.severity,
          d.vmId,
          d.connectionId ?? null,
          d.title,
          d.summary,
          JSON.stringify(d.detail ?? {}),
        ],
      );
      created += 1;
      newFingerprints.push(d.fingerprint);
    } else {
      // Still reproducing: bump evidence, refresh detail. A RESOLVED row
      // re-opens (re-occurrence); OPEN/ACKNOWLEDGED keep their state so an
      // acknowledged drift stays acknowledged while it persists.
      await db.query(
        `UPDATE drift_findings SET
           severity = $2, title = $3, summary = $4, detail = $5,
           last_seen = CASE WHEN status = 'RESOLVED' THEN $6 ELSE last_seen END,
           status = CASE WHEN status = 'RESOLVED' THEN 'OPEN' ELSE status END,
           occurrences = CASE WHEN status = 'RESOLVED' THEN occurrences + 1 ELSE occurrences END,
           resolved_at = CASE WHEN status = 'RESOLVED' THEN NULL ELSE resolved_at END,
           resolved_reason = CASE WHEN status = 'RESOLVED' THEN NULL ELSE resolved_reason END,
           remediated_at = CASE WHEN status = 'RESOLVED' THEN NULL ELSE remediated_at END,
           remediated_by = CASE WHEN status = 'RESOLVED' THEN NULL ELSE remediated_by END,
           updated_at = $6
         WHERE fingerprint = $1`,
        [d.fingerprint, d.severity, d.title, d.summary, JSON.stringify(d.detail ?? {}), nowIso],
      );
      updated += 1;
    }
  }

  // Auto-resolve: an active finding that did not reproduce this pass and is
  // not preserved (exempt VM, or ip/credential VM whose check could not run)
  // is considered fixed. Internal single-finding callers disable this step.
  if (opts.resolveStale === false) {
    return { created, updated, resolved: 0, newFingerprints };
  }
  const produced = new Set(detected.map((d) => d.fingerprint));
  const active = await db.query<{ fingerprint: string; vm_id: string | null; dimension: string }>(
    "SELECT fingerprint, vm_id, dimension FROM drift_findings WHERE status IN ('OPEN','ACKNOWLEDGED')",
  );
  const toResolve: string[] = [];
  for (const row of active.rows) {
    if (produced.has(row.fingerprint)) continue;
    if (row.vm_id && opts.exemptVmIds?.has(row.vm_id)) continue;
    // ip/credential findings survive a pass whose check could not run
    // (agent down, stopped guest, probe cooldown): absence of evidence is
    // not evidence of fixed state.
    if (
      row.vm_id &&
      (row.dimension === "ip" || row.dimension === "credential") &&
      opts.unrefinedVmIds?.has(row.vm_id)
    ) {
      continue;
    }
    toResolve.push(row.fingerprint);
  }
  let resolved = 0;
  if (toResolve.length) {
    // IN with generated placeholders instead of ANY($1::text[]): pg-mem's
    // array binding silently matches nothing inside UPDATE ... ANY, which
    // would starve auto-resolution in this test harness.
    const placeholders = toResolve.map((_, i) => `$${i + 1}`).join(",");
    const result = await db.query(
      `UPDATE drift_findings SET status = 'RESOLVED', resolved_at = $${toResolve.length + 1}, resolved_reason = 'auto', updated_at = $${toResolve.length + 1}
        WHERE fingerprint IN (${placeholders}) AND status IN ('OPEN','ACKNOWLEDGED')`,
      [...toResolve, nowIso],
    );
    resolved = result.rowCount ?? 0;
  }

  return { created, updated, resolved, newFingerprints };
}

async function getActive(db: Pool, fingerprint: string): Promise<DriftFindingRecord> {
  const result = await db.query<Record<string, unknown>>(
    "SELECT * FROM drift_findings WHERE fingerprint = $1 AND status IN ('OPEN','ACKNOWLEDGED')",
    [fingerprint],
  );
  const row = result.rows[0];
  if (!row) throw AppError.notFound("Drift finding not found or already resolved");
  return toFindingRecord(row);
}

// --- Orchestrator -----------------------------------------------------------

export interface VmStateRow {
  vm_id: string;
  last_probe_at: Date | null;
  last_probe_ok_at: Date | null;
  cores: number | null;
  memory_mb: number | null;
  net_json: string | null;
  snapshotted_at: Date | null;
}

async function getVmState(db: Pool, vmId: string): Promise<VmStateRow | null> {
  const result = await db.query<VmStateRow>(
    "SELECT vm_id, last_probe_at, last_probe_ok_at, cores, memory_mb, net_json, snapshotted_at FROM drift_vm_state WHERE vm_id = $1",
    [vmId],
  );
  return result.rows[0] ?? null;
}

async function upsertVmState(db: Pool, vmId: string, patch: Partial<VmStateRow>): Promise<void> {
  await db.query(
    `INSERT INTO drift_vm_state (vm_id, last_probe_at, last_probe_ok_at, cores, memory_mb, net_json, snapshotted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (vm_id) DO UPDATE SET
       last_probe_at = COALESCE(EXCLUDED.last_probe_at, drift_vm_state.last_probe_at),
       last_probe_ok_at = COALESCE(EXCLUDED.last_probe_ok_at, drift_vm_state.last_probe_ok_at),
       cores = COALESCE(EXCLUDED.cores, drift_vm_state.cores),
       memory_mb = COALESCE(EXCLUDED.memory_mb, drift_vm_state.memory_mb),
       net_json = COALESCE(EXCLUDED.net_json, drift_vm_state.net_json),
       snapshotted_at = COALESCE(EXCLUDED.snapshotted_at, drift_vm_state.snapshotted_at),
       updated_at = NOW()`,
    [
      vmId,
      patch.last_probe_at ?? null,
      patch.last_probe_ok_at ?? null,
      patch.cores ?? null,
      patch.memory_mb ?? null,
      patch.net_json ?? null,
      patch.snapshotted_at ?? null,
    ],
  );
}

export function findableResources(resources: ProxmoxQemuResource[] | unknown): DriftLiveResource[] {
  const rows = Array.isArray(resources) ? (resources as ProxmoxQemuResource[]) : [];
  return rows
    .filter((r) => r && typeof r.vmid === "number" && r.template !== 1)
    .map((r) => ({
      vmid: r.vmid,
      node: String(r.node ?? ""),
      name: typeof r.name === "string" ? r.name : null,
      status: String(r.status ?? ""),
    }));
}

/**
 * Record the in-band hardware baseline after Proxmox accepts an edit. The
 * snapshot is Proxmox-owned reality: routes write it only after a confirmed
 * task, never instead of one.
 */
export async function bumpHardwareSnapshot(
  db: Pool,
  vmId: string,
  hw: { cores: number; memory: number; net: Array<Record<string, unknown>> | null },
): Promise<void> {
  await upsertVmState(db, vmId, {
    cores: hw.cores,
    memory_mb: hw.memory,
    net_json: canonNet(hw.net),
    snapshotted_at: new Date(),
  });
}

export interface DriftPassDeps {
  db: Pool;
  settings: Pick<SettingsService, "getPlain" | "getJson" | "set">;
  vms: Pick<VmsRepository, "list">;
  jobs: Pick<JobsRepository, "activeJobVmIds">;
  guac: Pick<GuacamoleService, "listAllConnectionRecords">;
  creds: Pick<CredentialsService, "findByVm" | "markVerified">;
  hostKeys: Pick<HostKeyService, "policy">;
  decrypt: (stored: string) => string;
  getProxmoxClient: () => Promise<ProxmoxClient>;
  logger: Logger;
  /** Injectable probe for tests; defaults to the real SSH probe. */
  probeSshFn?: typeof probeSsh;
}

/**
 * One pass. Fails open (skipped states, per-VM warn-logs) — telemetry must
 * never take the API down. Never modifies anything outside drift tables and
 * the settings markers; remediation is a separate, explicit path.
 */
export async function runDriftPass(deps: DriftPassDeps, now = new Date()): Promise<DriftPassResult> {
  const enabled = (await deps.settings.getPlain(DRIFT_ENABLED_KEY))?.trim().toLowerCase();
  if (enabled === "false") {
    return { created: 0, updated: 0, resolved: 0, exempted: 0, liveChecked: false, newFingerprints: [], skipped: "disabled" };
  }

  let resources: DriftLiveResource[];
  try {
    resources = findableResources(await (await deps.getProxmoxClient()).clusterResources());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof AppError && err.code === "CONFIGURATION_ERROR") {
      return { created: 0, updated: 0, resolved: 0, exempted: 0, liveChecked: false, newFingerprints: [], skipped: "unconfigured" };
    }
    deps.logger.warn({ error: message }, "drift pass skipped: Proxmox unreachable");
    return { created: 0, updated: 0, resolved: 0, exempted: 0, liveChecked: false, newFingerprints: [], skipped: "proxmox_down" };
  }

  const recorded = await deps.vms.list();
  const exemptIds = new Set(await deps.jobs.activeJobVmIds());
  const exempted = recorded.filter((vm) => exemptIds.has(vm.id)).length;
  const active = recorded.filter((vm) => !exemptIds.has(vm.id));

  const detected: Detected[] = [];
  const unrefined = new Set<string>();
  const probed = new Set<string>();

  if (resources.length >= 0) {
    detected.push(...detectConfigDrift(active, resources));
    detected.push(...detectDeletedVms(active, resources));
  }

  for (const vm of active) {
    const lr = resources.find((r) => r.vmid === vm.vmid);
    if (!lr) continue; // deleted finding already emitted
    try {
      // Hardware snapshot comparison (any power state — qemuConfig works while stopped).
      const cfg = await (await deps.getProxmoxClient()).qemuConfig(lr.node, vm.vmid);
      const state = await getVmState(deps.db, vm.id);
      detected.push(
        ...detectHardwareDrift(vm.id, vm.name, state ? { cores: state.cores, memoryMb: state.memory_mb, net: state.net_json } : null, {
          cores: Number(cfg.cores ?? 0),
          memory: Number(cfg.memory ?? 0),
          net: cfg.net ?? null,
        }),
      );
      await upsertVmState(deps.db, vm.id, {
        cores: Number(cfg.cores ?? 0),
        memory_mb: Number(cfg.memory ?? 0),
        net_json: canonNet(cfg.net ?? null),
        snapshotted_at: now,
      });

      // IP drift (agent round-trip): only comparable for running guests; a
      // down agent unrefines instead of resolving existing findings.
      if (vm.status === "running" && lr.status === "running") {
        const agent = await (await deps.getProxmoxClient()).guestIpAddresses(lr.node, vm.vmid);
        if (agent) {
          detected.push(
            ...detectIpDrift(vm, selectUsableIpv4(agent.ipv4s)),
          );
        } else {
          unrefined.add(vm.id);
        }
      } else {
        unrefined.add(vm.id);
      }

      // Credential staleness (SSH only for v1; Windows RDP port probing can
      // only prove the port is open, which says nothing about credentials).
      if (
        vm.status === "running" &&
        lr.status === "running" &&
        vm.osType === "linux" &&
        vm.ipAddress
      ) {
        const stateRow = await getVmState(deps.db, vm.id);
        const lastProbe = stateRow?.last_probe_at?.getTime() ?? 0;
        if (now.getTime() - lastProbe < CREDENTIAL_PROBE_COOLDOWN_MS) {
          unrefined.add(vm.id);
        } else if (probed.size < MAX_CREDENTIAL_PROBES_PER_PASS) {
          probed.add(vm.id);
          detected.push(...(await probeCredential(deps, vm, now)));
        }
      } else {
        unrefined.add(vm.id);
      }
    } catch (err) {
      deps.logger.warn(
        { vmId: vm.id, vmid: vm.vmid, error: err instanceof Error ? err.message : String(err) },
        "drift check failed for VM; its findings are preserved this pass",
      );
      unrefined.add(vm.id);
    }
  }

  // Orphaned Guacamole records: vm_id pointing at a VM that is gone from the
  // (non-deleted) VM list. Provisioning-exempt VMs still exist, so no false
  // positives — no exemption needed.
  const knownVmIds = new Set(recorded.map((vm) => vm.id));
  detected.push(
    ...detectOrphanGuac(await deps.guac.listAllConnectionRecords(), knownVmIds),
  );

  const counts = await applyFindings(deps.db, detected, {
    now,
    exemptVmIds: exemptIds,
    unrefinedVmIds: unrefined,
  });

  const summary = {
    at: now.toISOString(),
    created: counts.created,
    updated: counts.updated,
    resolved: counts.resolved,
    exempted,
    liveChecked: true,
  };
  await deps.settings.set(DRIFT_LAST_RUN_KEY, JSON.stringify(summary), { category: "system" });

  return {
    created: counts.created,
    updated: counts.updated,
    resolved: counts.resolved,
    exempted,
    liveChecked: true,
    newFingerprints: counts.newFingerprints,
    skipped: null,
  };
}

/**
 * SSH staleness probe. Marks verified on success, returns a finding on
 * AUTH_FAILED, and never persists findings itself — the orchestrator owns
 * ONE persistence point (the pass-level applyFindings call), so probe
 * output joins the pass detection set and participates in the same
 * lifecycle as every other dimension.
 */
async function probeCredential(deps: DriftPassDeps, vm: VmRecordLite, now: Date): Promise<Detected[]> {
  const cred = await deps.creds.findByVm(vm.id);
  if (!cred) return [];
  const ip = vm.ipAddress as string;
  try {
    const probe = deps.probeSshFn ?? probeSsh;
    const result = await probe({
      host: ip,
      port: 22,
      username: cred.username,
      password: deps.decrypt(cred.password_ciphertext),
      hostKey: await deps.hostKeys.policy({ vmId: vm.id, host: ip, port: 22 }),
    });
    if (result.status === "AUTHENTICATED") {
      await deps.creds.markVerified(vm.id);
      await upsertVmState(deps.db, vm.id, {
        last_probe_at: now,
        last_probe_ok_at: now,
      });
      return [];
    }
    if (result.status === "AUTH_FAILED") {
      await upsertVmState(deps.db, vm.id, { last_probe_at: now, last_probe_ok_at: null });
      return [
        {
          fingerprint: `credential:${vm.id}`,
          dimension: "credential",
          severity: "high",
          vmId: vm.id,
          title: `Credential rejected on VM "${vm.name}"`,
          summary: `SSH authentication at ${ip} was REJECTED for "${cred.username}" (not frozen/transport issue): the stored credential no longer works and remote sessions will fail. Rotate the credential, then verify.`,
          detail: { mechanism: "ssh", host: ip, probeDetail: result.detail.slice(0, 200) },
        },
      ];
    }
    // CONNECTION_FAILED is transport, not credential drift: cooldown, no finding.
    await upsertVmState(deps.db, vm.id, { last_probe_at: now, last_probe_ok_at: null });
    return [];
  } catch (err) {
    deps.logger.warn(
      { vmId: vm.id, error: err instanceof Error ? err.message : String(err) },
      "credential drift probe failed; treated as transport issue",
    );
    await upsertVmState(deps.db, vm.id, { last_probe_at: now, last_probe_ok_at: null }).catch(() => undefined);
    return [];
  }
}

// --- Listing ----------------------------------------------------------------

export interface DriftFindingListOpts {
  status?: DriftStatus;
  limit?: number;
}

export async function getDriftFinding(
  db: Pool,
  findingId: string,
): Promise<DriftFindingRecord | null> {
  const result = await db.query<Record<string, unknown>>(
    "SELECT * FROM drift_findings WHERE id = $1",
    [findingId],
  );
  return result.rows[0] ? toFindingRecord(result.rows[0]) : null;
}

export async function listDriftFindings(
  db: Pool,
  opts: DriftFindingListOpts = {},
): Promise<DriftFindingRecord[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  // Default surface = active board (OPEN + ACKNOWLEDGED); an explicit status
  // widens it (RESOLVED history) or narrows it. Values are bound, never
  // string-spliced into the SQL text.
  if (opts.status && DRIFT_STATUSES.includes(opts.status)) {
    const result = await db.query<Record<string, unknown>>(
      `SELECT * FROM drift_findings WHERE status = $1
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, last_seen DESC
        LIMIT $2`,
      [opts.status, limit],
    );
    return result.rows.map(toFindingRecord);
  }
  const result = await db.query<Record<string, unknown>>(
    `SELECT * FROM drift_findings WHERE status <> 'RESOLVED'
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, last_seen DESC
      LIMIT $1`,
    [limit],
  );
  return result.rows.map(toFindingRecord);
}

export async function getDriftLastRun(
  settings: Pick<SettingsService, "getJson" | "getPlain">,
): Promise<{ at: string; created: number; updated: number; resolved: number; exempted: number; liveChecked: boolean } | null> {
  const raw = await settings.getJson<Record<string, unknown>>(DRIFT_LAST_RUN_KEY);
  if (!raw || typeof raw.at !== "string") return null;
  return {
    at: raw.at,
    created: Number(raw.created ?? 0),
    updated: Number(raw.updated ?? 0),
    resolved: Number(raw.resolved ?? 0),
    exempted: Number(raw.exempted ?? 0),
    liveChecked: raw.liveChecked === true,
  };
}

// --- Reconciliation (remediation) -------------------------------------------

export interface DriftActionDeps {
  db: Pool;
  vms: Pick<VmsRepository, "findById" | "requireById" | "softDelete" | "updateName" | "updateNode" | "updateIp">;
  jobs: Pick<JobsRepository, "activeJobsForVm">;
  guac: Pick<GuacamoleService, "listConnectionRecords" | "updateConnectionHostname" | "deleteVmResources" | "deleteConnectionRecord">;
  hostKeys: Pick<HostKeyService, "policy">;
  audit: (entry: AuditEntryInput) => Promise<void>;
  decrypt: (stored: string) => string;
  getProxmoxClient: () => Promise<ProxmoxClient>;
  getGuacDb: () => Promise<GuacamoleDbClient>;
  logger: Logger;
}

export interface DriftActor {
  userId: string;
  username: string;
}

async function resolveFinding(
  db: Pool,
  finding: DriftFindingRecord,
  actor: DriftActor,
  now: Date,
): Promise<void> {
  await db.query(
    `UPDATE drift_findings SET status = 'RESOLVED', resolved_at = $2, resolved_reason = 'manual',
       remediated_at = $2, remediated_by = $3, updated_at = $2
      WHERE fingerprint = $1`,
    [finding.fingerprint, now.toISOString(), actor.userId],
  );
}

/** Refuse remediation on stale findings: one live-job check, one re-verify. */
async function assertNoActiveJob(deps: DriftActionDeps, vmId: string): Promise<void> {
  const jobs = await deps.jobs.activeJobsForVm(vmId);
  if (jobs.length) {
    throw AppError.conflict(`VM has an active provisioning job; drift remediation is refused until it finishes`);
  }
}

async function activeFinding(deps: DriftActionDeps, findingId: string): Promise<DriftFindingRecord> {
  const result = await deps.db.query<Record<string, unknown>>(
    "SELECT * FROM drift_findings WHERE id = $1",
    [findingId],
  );
  const row = result.rows[0] ? toFindingRecord(result.rows[0]) : null;
  if (!row) throw AppError.notFound("Drift finding not found");
  if (row.status === "RESOLVED") throw AppError.conflict("Finding already resolved");
  return row;
}

/**
 * Decommission: the VM's guest is GONE from Proxmox. Soft-delete the ProxVM
 * record and remove its Guacamole connections. Never touches Proxmox (there
 * is nothing there). Re-verifies absence + no active job before acting.
 */
export async function decommissionDriftVm(
  deps: DriftActionDeps,
  findingId: string,
  actor: DriftActor,
  now = new Date(),
): Promise<{ resolved: true; action: "decommission" }> {
  const finding = await activeFinding(deps, findingId);
  if (finding.dimension !== "deleted" || !finding.vmId) {
    throw AppError.conflict("Decommission applies only to deleted-VM findings");
  }
  const vm = await deps.vms.findById(finding.vmId);
  if (!vm) throw AppError.notFound("VM record not found");
  await assertNoActiveJob(deps, vm.id);
  // Re-verify against live Proxmox right now — not against the finding.
  const resources = findableResources(await (await deps.getProxmoxClient()).clusterResources());
  if (resources.some((r) => r.vmid === vm.vmid)) {
    // The guest reappeared (created again under the same vmid?): auto-resolve
    // on the next pass. Acting now could nuke a legitimate record.
    throw AppError.conflict("A guest with this vmid exists again; the finding is stale (auto-resolves on the next pass)");
  }
  let guacCleanupAttempted = false;
  try {
    await deps.guac.deleteVmResources(vm.id, await deps.getGuacDb());
    guacCleanupAttempted = true;
  } catch (err) {
    // Connection destruction is best-effort: the decommission must not be
    // blocked by an unreachable Guac DB — the records become orphans that
    // the guac detector itself will surface.
    deps.logger.warn(
      { vmId: vm.id, error: err instanceof Error ? err.message : String(err) },
      "Guacamole resource cleanup failed during decommission; orphaned records will be re-detected",
    );
  }
  await deps.vms.softDelete(vm.id);
  await resolveFinding(deps.db, finding, actor, now);
  await deps.audit({
    event: "DRIFT_REMEDIATED",
    detail: {
      action: "decommission",
      findingId: finding.id,
      fingerprint: finding.fingerprint,
      vmId: vm.id,
      vmName: vm.name,
      vmid: vm.vmid,
      guacCleanupAttempted,
    },
  });
  return { resolved: true, action: "decommission" };
}

/** Config adopt: write Proxmox's name/node into the record. osName/hardware
 *  adopt via their own dimension flux; this covers name/node + hw baseline. */
export async function adoptDriftFinding(
  deps: DriftActionDeps,
  findingId: string,
  actor: DriftActor,
  now = new Date(),
): Promise<{ resolved: boolean; action: "adopt" }>{
  const finding = await activeFinding(deps, findingId);
  if (!finding.vmId) throw AppError.conflict("Finding has no VM target");
  if (finding.dimension !== "config" && finding.dimension !== "hw") {
    throw AppError.conflict("Adopt applies to config and hardware findings");
  }
  const vm = await deps.vms.requireById(finding.vmId);
  await assertNoActiveJob(deps, vm.id);
  const client = await deps.getProxmoxClient();
  const resources = findableResources(await client.clusterResources());
  const lr = resources.find((r) => r.vmid === vm.vmid);
  if (!lr) throw AppError.conflict("The guest is no longer present in Proxmox; the finding is stale");

  if (finding.dimension === "config") {
    const field = String((finding.detail as Record<string, unknown>).field ?? "");
    if (field === "name") {
      const liveName = lr.name ?? "";
      if (!liveName.toLowerCase().includes(vm.name.toLowerCase()) && liveName.toLowerCase() !== vm.name.toLowerCase()) {
        await deps.vms.updateName(vm.id, liveName);
      }
    } else if (field === "node") {
      if (lr.node !== vm.node) await deps.vms.updateNode(vm.id, lr.node);
    } else {
      throw AppError.validation(`Unknown config drift field "${field}"`);
    }
  } else {
    // hw: record Proxmox's current hardware as the new baseline.
    const cfg = await client.qemuConfig(lr.node, vm.vmid);
    await bumpHardwareSnapshot(deps.db, vm.id, {
      cores: Number(cfg.cores ?? 0),
      memory: Number(cfg.memory ?? 0),
      net: cfg.net ?? null,
    });
  }
  await resolveFinding(deps.db, finding, actor, now);
  await deps.audit({
    event: "DRIFT_REMEDIATED",
    detail: {
      action: "adopt",
      findingId: finding.id,
      fingerprint: finding.fingerprint,
      dimension: finding.dimension,
      vmId: vm.id,
      vmName: vm.name,
    },
  });
  return { resolved: true, action: "adopt" };
}

/** IP re-sync: guest agent -> usable IPv4 -> update record + Guac endpoints. */
export async function resyncDriftIp(
  deps: DriftActionDeps,
  findingId: string,
  actor: DriftActor,
  now = new Date(),
): Promise<{ resolved: boolean; action: "resync_ip"; ip: string | null }>{
  const finding = await activeFinding(deps, findingId);
  if (finding.dimension !== "ip" || !finding.vmId) {
    throw AppError.conflict("IP re-sync applies only to IP findings");
  }
  const vm = await deps.vms.requireById(finding.vmId);
  await assertNoActiveJob(deps, vm.id);
  const client = await deps.getProxmoxClient();
  const agent = await client.guestIpAddresses(vm.node, vm.vmid);
  if (!agent) {
    throw AppError.external("Guest", "Guest agent is not reachable; cannot re-sync the IP (stopping nothing, changing nothing)");
  }
  const ip = selectUsableIpv4(agent.ipv4s);
  if (!ip) {
    throw AppError.external("Guest", "The guest agent reported no usable IPv4 address; nothing to re-sync");
  }
  if (ip === vm.ipAddress) {
    // Auto-healed between passes: resolving without writing is correct.
    await resolveFinding(deps.db, finding, actor, now);
    await deps.audit({
      event: "DRIFT_REMEDIATED",
      detail: { action: "resync_ip", findingId: finding.id, vmId: vm.id, note: "already_correct", vmName: vm.name },
    });
    return { resolved: true, action: "resync_ip", ip };
  }
  await deps.vms.updateIp(vm.id, ip, { static: vm.ipStatic });
  let endpointsUpdated = 0;
  const connRecords = await deps.guac.listConnectionRecords(vm.id);
  if (connRecords.length) {
    endpointsUpdated = await deps.guac.updateConnectionHostname(vm.id, ip, await deps.getGuacDb());
  }
  await resolveFinding(deps.db, finding, actor, now);
  await deps.audit({
    event: "DRIFT_REMEDIATED",
    detail: {
      action: "resync_ip",
      findingId: finding.id,
      vmId: vm.id,
      vmName: vm.name,
      from: vm.ipAddress,
      to: ip,
      guacEndpointsUpdated: endpointsUpdated,
    },
  });
  return { resolved: true, action: "resync_ip", ip };
}

/**
 * Delete an orphaned Guacamole connection record (app row + real connection).
 * If the VM has come back to life, the finding is stale: refuse + let the
 * next pass resolve it.
 */
export async function deleteOrphanDriftConnection(
  deps: DriftActionDeps,
  findingId: string,
  actor: DriftActor,
  now = new Date(),
): Promise<{ resolved: boolean; action: "delete_orphan_connection" }>{
  const finding = await activeFinding(deps, findingId);
  if (finding.dimension !== "guac" || !finding.connectionId) {
    throw AppError.conflict("Orphan deletion applies only to Guacamole orphan findings");
  }
  if (finding.vmId) {
    const vm = await deps.vms.findById(finding.vmId);
    if (vm) {
      // findById only returns live (non-soft-deleted) records, so a hit here
      // means the VM came back: the finding is stale.
      throw AppError.conflict("The VM record is live again; this orphan finding is stale (auto-resolves on the next pass)");
    }
  }
  const deleted = await deps.guac.deleteConnectionRecord(finding.connectionId, await deps.getGuacDb());
  if (!deleted) {
    throw AppError.notFound("Connection record already removed (auto-resolves on the next pass)");
  }
  await resolveFinding(deps.db, finding, actor, now);
  await deps.audit({
    event: "DRIFT_REMEDIATED",
    detail: {
      action: "delete_orphan_connection",
      findingId: finding.id,
      connectionRecordId: finding.connectionId,
      vmId: finding.vmId,
    },
  });
  return { resolved: true, action: "delete_orphan_connection" };
}

/** Acknowledge a finding: known-and-tolerated, re-opens if it re-occurs. */
export async function acknowledgeDriftFinding(
  deps: DriftActionDeps,
  findingId: string,
  actor: DriftActor,
  now = new Date(),
): Promise<{ status: "ACKNOWLEDGED" }> {
  const finding = await activeFinding(deps, findingId);
  if (finding.status === "ACKNOWLEDGED") return { status: "ACKNOWLEDGED" };
  await deps.db.query(
    `UPDATE drift_findings SET status = 'ACKNOWLEDGED', acknowledged_at = $2, acknowledged_by = $3, updated_at = $2
      WHERE id = $1`,
    [finding.id, now.toISOString(), actor.userId],
  );
  await deps.audit({
    event: "DRIFT_FINDING_ACKNOWLEDGED",
    detail: {
      findingId: finding.id,
      fingerprint: finding.fingerprint,
      dimension: finding.dimension,
      vmId: finding.vmId,
    },
  });
  return { status: "ACKNOWLEDGED" };
}
