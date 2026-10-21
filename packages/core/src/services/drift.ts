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
/** Cap on SSH credential probes per pass (deferred VMs are unrefined, not resolved). */
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

/**
 * Per-VM set of the dimensions whose check did NOT complete this pass.
 *
 * WHY a map of sets and not a flat VM set: "not observed" is not "verified
 * fixed", and each dimension has its own failure mode (agent down, probe
 * cooldown, config read error). A flat per-VM set would preserve dimensions
 * whose check DID run (a config finding whose name no longer differs would
 * stay open forever) or, worse, a dimension hardcoded into the resolution
 * rule would silently auto-resolve the dimensions nobody listed.
 *
 * Key = vmId, value = the dimensions that could not be checked.
 */
export type UnrefinedMap = Map<string, Set<DriftDimension>>;

/** Mark the given dimensions as "not checked this pass" for one VM. */
export function markUnrefined(
  map: UnrefinedMap,
  vmId: string,
  ...dimensions: DriftDimension[]
): void {
  const current = map.get(vmId) ?? new Set<DriftDimension>();
  for (const dim of dimensions) current.add(dim);
  map.set(vmId, current);
}

export interface ApplyOpts {
  /** Last-seen row (Date) for idempotent upserts/in resolve stamps. */
  now: Date;
  /** VMs exempt this pass: their findings are preserved, never auto-resolved. */
  exemptVmIds?: Set<string>;
  /**
   * Dimensions whose check could not complete this pass. A finding in one of
   * these dimensions is PRESERVED, never auto-resolved: absence of evidence
   * is not evidence of a fixed state.
   */
  unrefined?: UnrefinedMap;
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
      //
      // remediated_at/remediated_by are the LAST remediation of this finding
      // and are deliberately NOT cleared on re-open: the file's contract is
      // that the resolution history survives ("resolved_at history is the
      // whole point"), so a drift that comes back must not erase the record
      // of who remediated it last time. They do NOT claim that the CURRENT
      // occurrence was remediated - the status does.
      await db.query(
        `UPDATE drift_findings SET
           severity = $2, title = $3, summary = $4, detail = $5,
           last_seen = $6,
           status = CASE WHEN status = 'RESOLVED' THEN 'OPEN' ELSE status END,
           occurrences = CASE WHEN status = 'RESOLVED' THEN occurrences + 1 ELSE occurrences END,
           resolved_at = CASE WHEN status = 'RESOLVED' THEN NULL ELSE resolved_at END,
           resolved_reason = CASE WHEN status = 'RESOLVED' THEN NULL ELSE resolved_reason END,
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
    // A finding whose dimension could not be checked this pass is PRESERVED,
    // never auto-resolved. The scope is the (vm, dimension) pair: a config
    // finding whose name no longer differs must still resolve even when the
    // credential probe for the same VM was inconclusive.
    if (row.vm_id) {
      const dims = opts.unrefined?.get(row.vm_id);
      if (dims && dims.has(row.dimension as DriftDimension)) continue;
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
  // Column-wise upsert: only fields present in the patch are written, so a
  // probe-only patch preserves the hardware baseline AND an explicit null
  // (e.g. a removed net device) actually clears the stored value. COALESCE
  // could express the first but never the second.
  const cols = ["vm_id"];
  const placeholders = ["$1"];
  const params: unknown[] = [vmId];
  const add = (col: string, value: unknown): void => {
    params.push(value);
    cols.push(col);
    placeholders.push(`$${params.length}`);
  };
  if (patch.last_probe_at !== undefined) add("last_probe_at", patch.last_probe_at);
  if (patch.last_probe_ok_at !== undefined) add("last_probe_ok_at", patch.last_probe_ok_at);
  if (patch.cores !== undefined) add("cores", patch.cores);
  if (patch.memory_mb !== undefined) add("memory_mb", patch.memory_mb);
  if (patch.net_json !== undefined) add("net_json", patch.net_json);
  if (patch.snapshotted_at !== undefined) add("snapshotted_at", patch.snapshotted_at);
  const updates = cols
    .slice(1)
    .map((col) => `${col} = EXCLUDED.${col}`)
    .concat("updated_at = NOW()");
  await db.query(
    `INSERT INTO drift_vm_state (${cols.join(", ")})
     VALUES (${placeholders.join(", ")})
     ON CONFLICT (vm_id) DO UPDATE SET ${updates.join(", ")}`,
    params,
  );
}

interface RawLiveResource {
  vmid: number;
  node: string;
  name: string | null;
  status: string;
  template: boolean;
}

/** Normalize a Proxmox cluster resource listing into the shape the detectors
 *  consume. LXC containers are dropped: ProxVM tracks QEMU guests only, and
 *  /cluster/resources?type=vm returns both kinds. */
function normalizeResources(resources: ProxmoxQemuResource[] | unknown): RawLiveResource[] {
  const rows = Array.isArray(resources) ? (resources as ProxmoxQemuResource[]) : [];
  return rows
    .filter((r) => r && typeof r.vmid === "number")
    .filter((r) => (r as { type?: string }).type !== "lxc")
    .map((r) => ({
      vmid: r.vmid,
      node: String(r.node ?? ""),
      name: typeof r.name === "string" ? r.name : null,
      status: String(r.status ?? ""),
      template: Number(r.template ?? 0) === 1,
    }));
}

/**
 * Every QEMU guest in the cluster view, TEMPLATES INCLUDED.
 *
 * WHY templates count as "exists": a guest that was converted to a Proxmox
 * template out-of-band still occupies its vmid. Excluding templates from the
 * deletion check would report such a guest as deleted, and the decommission
 * remedy would then soft-delete a live record.
 */
export function allQemuResources(resources: ProxmoxQemuResource[] | unknown): DriftLiveResource[] {
  return normalizeResources(resources).map((r) => ({
    vmid: r.vmid,
    node: r.node,
    name: r.name,
    status: r.status,
  }));
}

/** The guests that are running VMs (templates excluded) - the set a ProxVM
 *  record can be compared against for config/hardware drift. */
export function findableResources(resources: ProxmoxQemuResource[] | unknown): DriftLiveResource[] {
  return normalizeResources(resources)
    .filter((r) => !r.template)
    .map((r) => ({
      vmid: r.vmid,
      node: r.node,
      name: r.name,
      status: r.status,
    }));
}

/**
 * A cluster view is "degraded" when an implausible share of the tracked
 * fleet vanishes at once.
 *
 * WHY: GET /cluster/resources is silently PARTIAL when a node is offline or
 * the API token lacks VM.Audit on it. Treating a partial listing as "these
 * guests were deleted" turns a read-only detector into a mass-deletion
 * recommendation - and the decommission remedy re-verifies against the SAME
 * degraded source, so the re-verify passes.
 *
 * Small fleets get no statistical signal, so the guard needs BOTH an
 * absolute and a relative threshold before it fires.
 */
export function clusterViewLooksDegraded(recorded: number, deleted: number): boolean {
  if (recorded < 5) return false;
  return deleted >= 3 && deleted / recorded >= 0.2;
}

/**
 * Record the in-band hardware baseline after Proxmox accepts an edit. The
 * snapshot is Proxmox-owned reality: routes write it only after a confirmed
 * task, never instead of one.
 *
 * A partial/garbled config is REFUSED, not written: a baseline of 0 cores
 * would produce a permanent false finding, because the baseline is never
 * advanced while a finding exists, so it could never self-heal.
 * Returns whether a baseline was written.
 */
export async function bumpHardwareSnapshot(
  db: Pool,
  vmId: string,
  hw: { cores: number; memory: number; net: Array<Record<string, unknown>> | null },
): Promise<boolean> {
  const cores = Number(hw.cores);
  const memory = Number(hw.memory);
  if (!Number.isFinite(cores) || cores <= 0 || !Number.isFinite(memory) || memory <= 0) {
    return false;
  }
  await upsertVmState(db, vmId, {
    cores,
    memory_mb: memory,
    net_json: canonNet(hw.net),
    snapshotted_at: new Date(),
  });
  return true;
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
  /**
   * Persist the "this pass did not run" outcome so the board can say WHY it
   * is stale. Without it the skip reason only ever reached the caller of a
   * manual run, and a ticker pass that failed open looked like a healthy
   * board.
   *
   * A DISABLED feature is not persisted: nobody is looking at the board and
   * a settings row per pass would be pure churn. "Unconfigured" and
   * "Proxmox down" ARE persisted — the feature is on, so the operator must
   * be able to see that nothing was checked.
   */
  const skip = async (reason: "disabled" | "unconfigured" | "proxmox_down"): Promise<DriftPassResult> => {
    const result: DriftPassResult = {
      created: 0, updated: 0, resolved: 0, exempted: 0, liveChecked: false, newFingerprints: [], skipped: reason,
    };
    if (reason !== "disabled") {
      await deps.settings.set(
        DRIFT_LAST_RUN_KEY,
        JSON.stringify({
          at: now.toISOString(),
          created: 0, updated: 0, resolved: 0, exempted: 0,
          liveChecked: false,
          skipped: reason,
        }),
        { category: "system" },
      );
    }
    return result;
  };

  // Opt-in: a drift pass opens SSH connections to guests and probes stored
  // passwords, so it must be switched ON deliberately. UNSET means OFF (an
  // unset key used to mean ON, which ran the pass on every install).
  const enabled = (await deps.settings.getPlain(DRIFT_ENABLED_KEY))?.trim().toLowerCase();
  if (enabled !== "true") {
    return await skip("disabled");
  }

  let allResources: DriftLiveResource[];
  let resources: DriftLiveResource[];
  try {
    const raw = await (await deps.getProxmoxClient()).clusterResources();
    // Two views: the full guest list (templates included) answers "does this
    // guest still exist?", the non-template list answers "can I compare this
    // record against a running VM?".
    allResources = allQemuResources(raw);
    resources = findableResources(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof AppError && err.code === "CONFIGURATION_ERROR") {
      return await skip("unconfigured");
    }
    deps.logger.warn({ error: message }, "drift pass skipped: Proxmox unreachable");
    return await skip("proxmox_down");
  }

  const recorded = await deps.vms.list();
  const exemptIds = new Set(await deps.jobs.activeJobVmIds());
  const exempted = recorded.filter((vm) => exemptIds.has(vm.id)).length;
  const active = recorded.filter((vm) => !exemptIds.has(vm.id));

  const detected: Detected[] = [];
  const unrefined: UnrefinedMap = new Map();
  const probed = new Set<string>();

  detected.push(...detectConfigDrift(active, resources));

  // Deletion detection compares against the FULL guest list (templates count
  // as existing) and is guarded against a partial cluster listing: a node
  // that is offline or not visible to the API token makes GET
  // /cluster/resources silently incomplete, and treating that as "these
  // guests were deleted" would recommend destroying live records.
  const deletedFindings = detectDeletedVms(active, allResources);
  if (clusterViewLooksDegraded(active.length, deletedFindings.length)) {
    deps.logger.warn(
      { tracked: active.length, vanished: deletedFindings.length },
      "cluster view looks partial; deletion findings suppressed this pass",
    );
    // Nothing can be compared this pass: preserve every per-VM dimension.
    for (const vm of active) markUnrefined(unrefined, vm.id, "hw", "ip", "credential");
  } else {
    detected.push(...deletedFindings);
  }

  for (const vm of active) {
    const lr = resources.find((r) => r.vmid === vm.vmid);
    if (!lr) {
      // Not in the live guest view: the deletion check (above) already had
      // its say. No per-VM comparison ran, so every per-VM dimension is
      // unrefined - otherwise a still-real IP/credential finding would be
      // auto-resolved by a guest that merely vanished from a partial listing.
      markUnrefined(unrefined, vm.id, "hw", "ip", "credential");
      continue;
    }
    try {
      // Hardware snapshot comparison (any power state — qemuConfig works while stopped).
      const cfg = await (await deps.getProxmoxClient()).qemuConfig(lr.node, vm.vmid);
      const state = await getVmState(deps.db, vm.id);
      // A partial/garbled config must not become the baseline: a baseline of
      // 0 cores would produce a permanent false finding (the baseline is
      // never advanced while a finding exists, so it could never self-heal).
      const liveCores = Number(cfg.cores);
      const liveMemory = Number(cfg.memory);
      const hwUsable = Number.isFinite(liveCores) && liveCores > 0 && Number.isFinite(liveMemory) && liveMemory > 0;
      if (!hwUsable) {
        markUnrefined(unrefined, vm.id, "hw");
      } else {
        const hwFindings = detectHardwareDrift(
          vm.id,
          vm.name,
          state ? { cores: state.cores, memoryMb: state.memory_mb, net: state.net_json } : null,
          {
            cores: liveCores,
            memory: liveMemory,
            net: cfg.net ?? null,
          },
        );
        detected.push(...hwFindings);
        // Advance the baseline ONLY when the detector stayed silent. Writing the
        // live config unconditionally would overwrite the baseline it just
        // compared against, so the finding would auto-resolve on the next pass
        // without anyone adopting (or reverting) the out-of-band change — the
        // exact false-resolution loop this snapshot exists to prevent.
        if (hwFindings.length === 0) {
          await upsertVmState(deps.db, vm.id, {
            cores: liveCores,
            memory_mb: liveMemory,
            net_json: canonNet(cfg.net ?? null),
            snapshotted_at: now,
          });
        }
      }

      // IP drift (agent round-trip): only comparable for running guests; a
      // down agent (or an agent with no usable IPv4) unrefines instead of
      // resolving existing findings.
      if (vm.status === "running" && lr.status === "running") {
        const agent = await (await deps.getProxmoxClient()).guestIpAddresses(lr.node, vm.vmid);
        if (agent) {
          const liveIp = selectUsableIpv4(agent.ipv4s);
          if (liveIp) {
            detected.push(...detectIpDrift(vm, liveIp));
          } else {
            markUnrefined(unrefined, vm.id, "ip");
          }
        } else {
          markUnrefined(unrefined, vm.id, "ip");
        }
      } else {
        markUnrefined(unrefined, vm.id, "ip");
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
          markUnrefined(unrefined, vm.id, "credential");
        } else if (probed.size < MAX_CREDENTIAL_PROBES_PER_PASS) {
          probed.add(vm.id);
          const outcome = await probeCredential(deps, vm, now);
          detected.push(...outcome.findings);
          // Transport failures (and probe-cap deferrals) prove nothing about
          // the credential: preserve an existing finding instead of resolving it.
          if (!outcome.conclusive) markUnrefined(unrefined, vm.id, "credential");
        } else {
          markUnrefined(unrefined, vm.id, "credential");
        }
      } else {
        markUnrefined(unrefined, vm.id, "credential");
      }
    } catch (err) {
      deps.logger.warn(
        { vmId: vm.id, vmid: vm.vmid, error: err instanceof Error ? err.message : String(err) },
        "drift check failed for this VM; its hw/ip/credential findings are preserved this pass",
      );
      markUnrefined(unrefined, vm.id, "hw", "ip", "credential");
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
    unrefined,
  });

  const summary = {
    at: now.toISOString(),
    created: counts.created,
    updated: counts.updated,
    resolved: counts.resolved,
    exempted,
    liveChecked: true,
    // The skip reason is part of the summary: the board has to be able to say
    // "the last pass did not run" (feature off / Proxmox unreachable),
    // otherwise a stale board looks like a healthy one.
    skipped: null as string | null,
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

interface ProbeOutcome {
  findings: Detected[];
  /** False when the probe could not decide (transport error/catch): callers
   *  must preserve an existing credential finding rather than resolve it. */
  conclusive: boolean;
}

/**
 * SSH staleness probe. Marks verified on success, returns a finding on
 * AUTH_FAILED, and never persists findings itself — the orchestrator owns
 * ONE persistence point (the pass-level applyFindings call), so probe
 * output joins the pass detection set and participates in the same
 * lifecycle as every other dimension.
 */
async function probeCredential(deps: DriftPassDeps, vm: VmRecordLite, now: Date): Promise<ProbeOutcome> {
  const cred = await deps.creds.findByVm(vm.id);
  if (!cred) return { findings: [], conclusive: true };
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
      return { findings: [], conclusive: true };
    }
    if (result.status === "AUTH_FAILED") {
      await upsertVmState(deps.db, vm.id, { last_probe_at: now, last_probe_ok_at: null });
      return {
        findings: [
          {
            fingerprint: `credential:${vm.id}`,
            dimension: "credential",
            severity: "high",
            vmId: vm.id,
            title: `Credential rejected on VM "${vm.name}"`,
            summary: `SSH authentication at ${ip} was REJECTED for "${cred.username}" (not frozen/transport issue): the stored credential no longer works and remote sessions will fail. Rotate the credential, then verify.`,
            detail: { mechanism: "ssh", host: ip, probeDetail: result.detail.slice(0, 200) },
          },
        ],
        conclusive: true,
      };
    }
    // CONNECTION_FAILED is transport, not credential drift: cooldown, no
    // finding — but also no evidence the stored credential still works.
    await upsertVmState(deps.db, vm.id, { last_probe_at: now, last_probe_ok_at: null });
    return { findings: [], conclusive: false };
  } catch (err) {
    deps.logger.warn(
      { vmId: vm.id, error: err instanceof Error ? err.message : String(err) },
      "credential drift probe failed; treated as transport issue",
    );
    await upsertVmState(deps.db, vm.id, { last_probe_at: now, last_probe_ok_at: null }).catch(() => undefined);
    return { findings: [], conclusive: false };
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
): Promise<{
  at: string;
  created: number;
  updated: number;
  resolved: number;
  exempted: number;
  liveChecked: boolean;
  /** Why the last pass did not run ("disabled"/"unconfigured"/"proxmox_down"),
   *  or null when it ran. Persisted so the board can flag a stale pass. */
  skipped: string | null;
} | null> {
  const raw = await settings.getJson<Record<string, unknown>>(DRIFT_LAST_RUN_KEY);
  if (!raw || typeof raw.at !== "string") return null;
  return {
    at: raw.at,
    created: Number(raw.created ?? 0),
    updated: Number(raw.updated ?? 0),
    resolved: Number(raw.resolved ?? 0),
    exempted: Number(raw.exempted ?? 0),
    liveChecked: raw.liveChecked === true,
    skipped: typeof raw.skipped === "string" ? raw.skipped : null,
  };
}

// --- Reconciliation (remediation) -------------------------------------------

export interface DriftActionDeps {
  db: Pool;
  vms: Pick<
    VmsRepository,
    "findById" | "requireById" | "softDelete" | "updateName" | "updateNode" | "updateIp" | "revokeAllAccess" | "list"
  >;
  jobs: Pick<JobsRepository, "activeJobsForVm">;
  guac: Pick<GuacamoleService, "listConnectionRecords" | "updateConnectionHostname" | "deleteVmResources" | "deleteConnectionRecord">;
  /** Vault cleanup: a soft delete does NOT cascade, so the stored password
   *  of a decommissioned VM would otherwise stay encrypted in the DB. */
  creds: Pick<CredentialsService, "delete">;
  /** Metering cleanup: an open power period keeps accruing usage for a VM
   *  that no longer exists (monthlyUsage counts open periods up to now). */
  closePowerPeriod: (db: Pool, vmId: string) => Promise<number>;
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
 *
 * Two safety rules beyond the plain re-verification:
 * 1. The re-verification uses the FULL guest list (templates included). A
 *    guest converted to a Proxmox template still occupies its vmid, so
 *    "absent from the template-filtered list" would be a false deletion.
 * 2. A cluster view that looks partial (a node offline or invisible to the
 *    API token makes /cluster/resources silently incomplete) refuses the
 *    whole operation. Re-verifying against the SAME degraded source proves
 *    nothing, and the blast radius is a live record plus its console
 *    connections.
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
  const client = await deps.getProxmoxClient();
  const allGuests = allQemuResources(await client.clusterResources());
  if (allGuests.some((r) => r.vmid === vm.vmid)) {
    // The guest reappeared (or was converted to a template, which still
    // occupies the vmid): auto-resolve on the next pass. Acting now could
    // nuke a legitimate record.
    throw AppError.conflict("A guest with this vmid exists again; the finding is stale (auto-resolves on the next pass)");
  }
  // A partial cluster view would make EVERY missing guest look deleted, so
  // the same evidence that produced the finding must not be enough to act
  // on it. Refuse while the view looks incomplete.
  const tracked = await deps.vms.list();
  const vanished = tracked.filter((t) => !allGuests.some((r) => r.vmid === t.vmid)).length;
  if (clusterViewLooksDegraded(tracked.length, vanished)) {
    throw AppError.conflict(
      `The Proxmox cluster view looks incomplete (${vanished} of ${tracked.length} tracked guests are missing); ` +
        "decommission is refused until the cluster view is whole again",
    );
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
  // Soft delete is an UPDATE, so the FK cascades never fire. Replicate the
  // cleanup the canonical DELETE /vms/:id path performs, otherwise the
  // decommissioned VM keeps its access grants, its stored password and an
  // open metering period.
  await deps.creds.delete(vm.id);
  await deps.closePowerPeriod(deps.db, vm.id);
  await deps.vms.softDelete(vm.id);
  const revokedGrants = await deps.vms.revokeAllAccess(vm.id);
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
      revokedGrants,
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
      if (!liveName) {
        throw AppError.conflict("Proxmox reports no name for this guest; there is nothing to adopt");
      }
      // Case-only differences are not drift (Proxmox lowercases names), so
      // resolve without degrading the recorded display name. Any other
      // difference — including the recorded name being a substring of the
      // live one — is adopted verbatim.
      if (liveName.toLowerCase() !== vm.name.toLowerCase()) {
        await deps.vms.updateName(vm.id, liveName);
      }
    } else if (field === "node") {
      if (lr.node !== vm.node) await deps.vms.updateNode(vm.id, lr.node);
    } else {
      throw AppError.validation(`Unknown config drift field "${field}"`);
    }
  } else {
    // hw: record Proxmox's current hardware as the new baseline. A partial
    // config is refused rather than adopted - adopting zeros would poison
    // the baseline and produce a permanent false finding.
    const cfg = await client.qemuConfig(lr.node, vm.vmid);
    const wrote = await bumpHardwareSnapshot(deps.db, vm.id, {
      cores: Number(cfg.cores ?? 0),
      memory: Number(cfg.memory ?? 0),
      net: cfg.net ?? null,
    });
    if (!wrote) {
      throw AppError.conflict(
        "Proxmox reported an incomplete hardware configuration for this guest; refusing to record it as the baseline",
      );
    }
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
  // A static address is an operator assignment, not a DHCP lease. The ip
  // detector never raises findings for static VMs, but an OPEN finding from
  // before the address was made static would still be actionable here, and
  // the re-sync would overwrite the operator's assignment with the guest's
  // DHCP address (and trip the static-IP unique index on the way).
  if (vm.ipStatic) {
    throw AppError.conflict(
      "This VM has a statically assigned address; re-syncing would overwrite the operator's assignment",
    );
  }
  const client = await deps.getProxmoxClient();
  // Prefer the live node: the record's node may itself be stale after an
  // out-of-band migration, and the agent call must target where the guest
  // actually runs. Fall back to the recorded node when the cluster view is
  // unavailable (the agent call then fails and surfaces a clean external error).
  let liveNode = vm.node;
  try {
    const resources = findableResources(await client.clusterResources());
    liveNode = resources.find((r) => r.vmid === vm.vmid)?.node ?? vm.node;
  } catch {
    // Cluster view unavailable: keep the recorded node and let the agent call
    // decide, so the caller still gets one clear external-service error.
  }
  const agent = await client.guestIpAddresses(liveNode, vm.vmid);
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
