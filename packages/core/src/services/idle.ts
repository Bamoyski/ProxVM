import type { Pool } from "pg";
import { AppError } from "../util/errors.js";
import type { ProxmoxClient } from "../proxmox/client.js";
import type { GuacamoleDbClient } from "../guacamole/db.js";
import type { SettingsService } from "./settings.js";
import type { VmsRepository } from "./vms.js";
import type { GuacamoleService } from "./guacamole.js";
import type { AuditService } from "./audit.js";
import type { Logger } from "../util/logger.js";

/**
 * Idle auto-shutdown for user-class VMs ("service" machines are never
 * touched). A VM is shut down only when ALL of these hold at once:
 * powered on, zero active Guacamole sessions, average guest CPU at or below
 * threshold over the window, and no session activity for idleMinutes.
 * Anything unknown (no CPU data, Guacamole unreachable) fails SAFE toward
 * leaving the machine running. VMs with no session history at all are also
 * skipped — a freshly provisioned box nobody opened yet is not "abandoned".
 */

export interface IdlePolicy {
  enabled: boolean;
  idleMinutes: number;
  cpuThreshold: number;
}

export async function getIdlePolicy(settings: Pick<SettingsService, "get">): Promise<IdlePolicy> {
  const [enabled, minutes, cpu] = await Promise.all([
    settings.get("power.idle_shutdown_enabled"),
    settings.get("power.idle_minutes"),
    settings.get("power.cpu_threshold"),
  ]);
  const idleMinutes = Math.min(Math.max(Number(minutes?.value ?? "120") || 120, 5), 10080);
  const cpuThreshold = Math.min(Math.max(Number(cpu?.value ?? "0.05") || 0.05, 0), 1);
  return {
    enabled: (enabled?.value ?? "false").toLowerCase() === "true",
    idleMinutes,
    cpuThreshold,
  };
}

export interface IdleSignals {
  powerOn: boolean;
  activeSessions: number;
  /** Average CPU fraction (0–1+) over the window, or null when unreadable. */
  avgCpu: number | null;
  /** Latest session end across the VM's connections, or null if never used. */
  lastActivityMs: number | null;
}

export function shouldAutoShutdown(
  signals: IdleSignals,
  policy: { idleMinutes: number; cpuThreshold: number },
  nowMs: number,
): { shutdown: boolean; reason: string } {
  if (!signals.powerOn) return { shutdown: false, reason: "already stopped" };
  if (signals.activeSessions > 0) return { shutdown: false, reason: `${signals.activeSessions} session(s) active` };
  if (signals.avgCpu === null) return { shutdown: false, reason: "cpu unreadable" };
  if (signals.avgCpu > policy.cpuThreshold) {
    return { shutdown: false, reason: `cpu ${(signals.avgCpu * 100).toFixed(1)}% above threshold` };
  }
  if (signals.lastActivityMs === null) return { shutdown: false, reason: "never used (no session history)" };
  const idleMs = nowMs - signals.lastActivityMs;
  if (idleMs < policy.idleMinutes * 60 * 1000) {
    return { shutdown: false, reason: `active ${Math.round(idleMs / 60000)}m ago` };
  }
  const hours = (idleMs / 3600000).toFixed(1);
  return { shutdown: true, reason: `idle ${hours}h, cpu ${(signals.avgCpu * 100).toFixed(1)}%` };
}

export interface IdleDeps {
  db: Pool;
  vms: VmsRepository;
  guac: GuacamoleService;
  getProxmoxClient: () => Promise<ProxmoxClient>;
  getGuacDb: () => Promise<GuacamoleDbClient>;
  audit: Pick<AuditService, "record">;
  logger: Logger;
}

/** Average CPU fraction over roughly the last `windowMinutes` (null when unreadable). */
export async function recentAvgCpu(
  proxmox: ProxmoxClient,
  node: string,
  vmid: number,
  windowMinutes: number,
): Promise<number | null> {
  try {
    const points = await proxmox.rrddata(node, vmid, "hour", "AVERAGE");
    if (!points.length) return null;
    const take = Math.max(1, Math.min(points.length, Math.ceil(windowMinutes / 5)));
    const recent = points.slice(-take);
    const values: number[] = [];
    for (const p of recent) {
      const cpu = (p as Record<string, unknown>).cpu;
      if (typeof cpu === "number" && Number.isFinite(cpu)) values.push(cpu);
    }
    if (!values.length) return null;
    return values.reduce((a, b) => a + b, 0) / values.length;
  } catch {
    return null;
  }
}

/**
 * One reconcile pass over user-class VMs. Returns per-VM outcomes for the
 * ticker log; shuts down (graceful ACPI) only VMs the decider clears.
 */
export async function reconcileIdleShutdown(
  deps: IdleDeps,
  policy: IdlePolicy,
  nowMs = Date.now(),
): Promise<Array<{ vmId: string; name: string; shutdown: boolean; reason: string }>> {
  const outcomes: Array<{ vmId: string; name: string; shutdown: boolean; reason: string }> = [];
  if (!policy.enabled) return outcomes;
  let proxmox: ProxmoxClient;
  try {
    proxmox = await deps.getProxmoxClient();
  } catch {
    return outcomes;
  }
  let guacDb: GuacamoleDbClient | null = null;
  try {
    guacDb = await deps.getGuacDb();
  } catch {
    guacDb = null;
  }
  const vms = await deps.vms.list();
  for (const vm of vms) {
    if (vm.vmClass !== "user") continue;
    try {
      const status = await proxmox.qemuStatus(vm.node, vm.vmid);
      const powerOn = String((status as Record<string, unknown>).status ?? "").toLowerCase() === "running";
      let activeSessions = 0;
      let lastActivityMs: number | null = null;
      if (guacDb) {
        const records = await deps.guac.listConnectionRecords(vm.id);
        for (const record of records) {
          activeSessions += await guacDb.countActiveSessions(record.guac_connection_name);
          const end = await guacDb.lastSessionEnd(record.guac_connection_name);
          if (end && (lastActivityMs === null || end.getTime() > lastActivityMs)) {
            lastActivityMs = end.getTime();
          }
        }
      }
      const avgCpu = powerOn
        ? await recentAvgCpu(proxmox, vm.node, vm.vmid, policy.idleMinutes)
        : null;
      const verdict = shouldAutoShutdown(
        { powerOn, activeSessions, avgCpu, lastActivityMs },
        policy,
        nowMs,
      );
      if (!verdict.shutdown) {
        outcomes.push({ vmId: vm.id, name: vm.name, shutdown: false, reason: verdict.reason });
        continue;
      }
      const upid = await proxmox.shutdown(vm.node, vm.vmid);
      if (upid) await proxmox.waitForTask(vm.node, upid, 120000);
      await deps.db.query("UPDATE vms SET status = 'stopped', updated_at = NOW() WHERE id = $1", [vm.id]);
      await deps.audit.record({
        event: "VM_AUTO_SHUTDOWN",
        vmId: vm.id,
        detail: { reason: verdict.reason, idleMinutes: policy.idleMinutes },
      });
      outcomes.push({ vmId: vm.id, name: vm.name, shutdown: true, reason: verdict.reason });
    } catch (err) {
      deps.logger.warn(
        { vmId: vm.id, error: err instanceof Error ? err.message : String(err) },
        "idle shutdown check failed for VM",
      );
      outcomes.push({ vmId: vm.id, name: vm.name, shutdown: false, reason: "check failed" });
    }
  }
  return outcomes;
}

export async function setVmClassValidated(
  vms: VmsRepository,
  vmId: string,
  vmClass: string,
): Promise<"server" | "user"> {
  if (vmClass !== "server" && vmClass !== "user") {
    throw AppError.validation('vmClass must be "server" or "user"');
  }
  await vms.setVmClass(vmId, vmClass);
  return vmClass;
}
