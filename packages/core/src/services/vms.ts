// ---------------------------------------------------------------------------
// VmsRepository: VM registry + access/visibility rules for every VM route.
// - Soft delete (deleted_at) hides rows; UNIQUE(vmid, node) still holds, so
//   listVmidsByNode includes deleted rows to avoid reassigning a VMID.
// - Direct, group, and creator-ownership grants union: creators implicitly
//   own their VMs so privacy flags work without pre-configured grant rows.
// - All grant checks honor expires_at (NULL = forever); hasAccessOrOwns is
//   the only ownership-aware check, hasAccess is grants-only.
// - Privacy-flagged VMs deny even ADMIN/OPERATOR without a concrete grant
//   or ownership; missing VMs deny via `allowed` so callers can 404/403.
// ---------------------------------------------------------------------------
import type { Pool } from "pg";
import type { VmRecord, VmStatus } from "@proxvm/shared";
import { AppError } from "../util/errors.js";
import { isUuid, newId } from "../util/misc.js";
import type { VmRow } from "./rows.js";
import type { ProxmoxClient } from "../proxmox/client.js";
import { applyIsolation, removeIsolation } from "./firewall.js";
import { applyStartOnBoot } from "./start-on-boot.js";

/** Input for registering a VM row; status defaults to pending. */
export interface CreateVmInput {
  vmid: number;
  node: string;
  name: string;
  status?: VmStatus;
  osType?: "linux" | "windows";
  ipAddress?: string;
  createdByUserId?: string;
  templateId?: string;
}

/** VM registry + grant/visibility enforcement (see header for model). */
export class VmsRepository {
  constructor(private readonly db: Pool) {}

  async create(input: CreateVmInput): Promise<VmRecord> {
    const result = await this.db.query<VmRow>(
      `INSERT INTO vms (id, vmid, node, name, status, os_type, ip_address, created_by_user_id, template_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        newId(),
        input.vmid,
        input.node,
        input.name,
        input.status ?? "pending",
        input.osType ?? null,
        input.ipAddress ?? null,
        input.createdByUserId ?? null,
        input.templateId ?? null,
      ],
    );
    return toVmRecord(result.rows[0] as VmRow);
  }

  async findOrCreate(input: CreateVmInput): Promise<VmRecord> {
    const existing = await this.findByIdKey(input.vmid, input.node);
    if (existing) return existing;
    return this.create(input);
  }

  // -- Reads: live rows only (deleted_at hides; VMID guard is separate) --
  async findById(id: string): Promise<VmRecord | null> {
    if (!isUuid(id)) return null;
    const result = await this.db.query<VmRow>(
      "SELECT * FROM vms WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    return result.rows[0] ? toVmRecord(result.rows[0]) : null;
  }

  async requireById(id: string): Promise<VmRecord> {
    const vm = await this.findById(id);
    if (!vm) throw AppError.notFound("VM not found");
    return vm;
  }

  /** All VMIDs tracked on a node, including soft-deleted rows (which still
   *  occupy the UNIQUE(vmid, node) constraint). Used to avoid reassigning a
   *  VMID that would violate the constraint on insert. */
  async listVmidsByNode(node: string): Promise<number[]> {
    const result = await this.db.query<{ vmid: number }>(
      "SELECT vmid FROM vms WHERE node = $1",
      [node],
    );
    return result.rows.map((r) => Number(r.vmid));
  }

  async findByIdKey(vmid: number, node: string): Promise<VmRecord | null> {
    const result = await this.db.query<VmRow>(
      "SELECT * FROM vms WHERE vmid = $1 AND node = $2 AND deleted_at IS NULL",
      [vmid, node],
    );
    return result.rows[0] ? toVmRecord(result.rows[0]) : null;
  }

  async list(appManagedOnly = false): Promise<VmRecord[]> {
    const result = await this.db.query<VmRow>(
      `SELECT * FROM vms WHERE deleted_at IS NULL
       ${appManagedOnly ? "AND created_by_user_id IS NOT NULL" : ""}
       ORDER BY created_at DESC`,
    );
    return result.rows.map(toVmRecord);
  }

  async listAssignedToUser(userId: string): Promise<VmRecord[]> {
    // Creators always see their own VMs (implicit ownership): this is what
    // makes privacy flags usable without pre-configured grant rows, and it
    // also fixes owners losing list visibility when their only row expires.
    const result = await this.db.query<VmRow>(
      `SELECT DISTINCT v.* FROM vms v
        LEFT JOIN vm_access va ON va.vm_id = v.id
          AND va.user_id = $1
          AND (va.expires_at IS NULL OR va.expires_at > NOW())
        LEFT JOIN group_vm_access gva ON gva.vm_id = v.id
          AND (gva.expires_at IS NULL OR gva.expires_at > NOW())
        LEFT JOIN group_members gm ON gm.group_id = gva.group_id
          AND gm.user_id = $1
          AND (gm.expires_at IS NULL OR gm.expires_at > NOW())
        WHERE v.deleted_at IS NULL AND (va.user_id IS NOT NULL OR gm.user_id IS NOT NULL OR v.created_by_user_id = $1)
        ORDER BY v.created_at DESC`,
      [userId],
    );
    return result.rows.map(toVmRecord);
  }

  async listAllForUser(userId: string, isPrivileged: boolean): Promise<VmRecord[]> {
    if (isPrivileged) return this.list();
    return this.listAssignedToUser(userId);
  }

  async updateStatus(id: string, status: VmStatus): Promise<void> {
    await this.db.query("UPDATE vms SET status = $2, updated_at = NOW() WHERE id = $1", [id, status]);
  }

  async updateIp(id: string, ip: string | null, opts?: { static?: boolean }): Promise<void> {
    await this.db.query("UPDATE vms SET ip_address = $2, ip_static = $3, updated_at = NOW() WHERE id = $1", [
      id,
      ip,
      opts?.static ?? false,
    ]);
  }

  async updateOsInfo(id: string, osName: string | null): Promise<void> {
    await this.db.query("UPDATE vms SET os_name = $2, updated_at = NOW() WHERE id = $1", [id, osName]);
  }

  async updateName(id: string, name: string): Promise<void> {
    await this.db.query("UPDATE vms SET name = $2, updated_at = NOW() WHERE id = $1", [id, name]);
  }

  async updateNode(id: string, node: string): Promise<void> {
    await this.db.query("UPDATE vms SET node = $2, updated_at = NOW() WHERE id = $1", [id, node]);
  }

  async softDelete(id: string): Promise<void> {
    await this.db.query("UPDATE vms SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1", [id]);
  }

  // -- Access grants: upsert vs replace, revocation, visibility --------
  async setAccess(
    vmId: string,
    userId: string,
    createdBy?: string | null,
    opts?: { protocols?: string[] | null; expiresAt?: Date | string | null },
  ): Promise<void> {
    const protocols = opts?.protocols === undefined ? undefined : opts.protocols;
    const expiresAt = opts?.expiresAt === undefined ? undefined : opts.expiresAt;
    await this.db.query(
      `INSERT INTO vm_access (vm_id, user_id, protocols, expires_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (vm_id, user_id) DO UPDATE SET
          protocols = COALESCE(EXCLUDED.protocols, vm_access.protocols),
          expires_at = COALESCE(EXCLUDED.expires_at, vm_access.expires_at)`,
      [vmId, userId, protocols ?? null, expiresAt ? new Date(expiresAt) : null],
    );
    if (createdBy) {
      await this.db.query(
        `UPDATE vm_access SET created_by = COALESCE(created_by, $3)
          WHERE vm_id = $1 AND user_id = $2`,
        [vmId, userId, createdBy],
      );
    }
  }

  /** Replace the access row wholesale (used when protocols/expiry are edited). */
  async replaceAccess(
    vmId: string,
    userId: string,
    opts: { protocols?: string[] | null; expiresAt?: Date | string | null; createdBy?: string | null },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO vm_access (vm_id, user_id, protocols, expires_at, created_by)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (vm_id, user_id) DO UPDATE SET
          protocols = EXCLUDED.protocols,
          expires_at = EXCLUDED.expires_at,
          created_by = COALESCE(vm_access.created_by, EXCLUDED.created_by)`,
      [
        vmId,
        userId,
        opts.protocols ?? null,
        opts.expiresAt ? new Date(opts.expiresAt) : null,
        opts.createdBy ?? null,
      ],
    );
  }

  async revokeAccess(vmId: string, userId: string): Promise<void> {
    await this.db.query("DELETE FROM vm_access WHERE vm_id = $1 AND user_id = $2", [vmId, userId]);
  }

  async revokeAllAccess(vmId: string): Promise<number> {
    const direct = await this.db.query("DELETE FROM vm_access WHERE vm_id = $1", [vmId]);
    const grouped = await this.db.query("DELETE FROM group_vm_access WHERE vm_id = $1", [vmId]);
    return (direct.rowCount ?? 0) + (grouped.rowCount ?? 0);
  }

  async listAccessEntries(vmId: string): Promise<
    Array<{
      userId: string;
      createdAt: Date;
      createdBy: string | null;
      protocols: string[] | null;
      expiresAt: Date | null;
      source: "direct" | "group";
      groupId?: string | null;
      groupName?: string | null;
    }>
  > {
    const direct = await this.db.query<{
      user_id: string;
      created_at: Date;
      created_by: string | null;
      protocols: string[] | null;
      expires_at: Date | null;
    }>(
      `SELECT user_id, created_at, created_by, protocols, expires_at
        FROM vm_access WHERE vm_id = $1 ORDER BY created_at ASC`,
      [vmId],
    );
    const grouped = await this.db.query<{
      user_id: string;
      created_at: Date;
      group_id: string;
      group_name: string;
      protocols: string[] | null;
      expires_at: Date | null;
    }>(
      `SELECT gm.user_id, gva.created_at, gva.group_id, g.name AS group_name,
          gva.protocols, gva.expires_at
        FROM group_vm_access gva
        JOIN groups g ON g.id = gva.group_id
        JOIN group_members gm ON gm.group_id = gva.group_id
          AND (gm.expires_at IS NULL OR gm.expires_at > NOW())
        WHERE gva.vm_id = $1
          AND (gva.expires_at IS NULL OR gva.expires_at > NOW())
        ORDER BY gva.created_at ASC`,
      [vmId],
    );
    return [
      ...direct.rows.map((r) => ({
        userId: r.user_id,
        createdAt: r.created_at,
        createdBy: r.created_by,
        protocols: r.protocols,
        expiresAt: r.expires_at,
        source: "direct" as const,
      })),
      ...grouped.rows.map((r) => ({
        userId: r.user_id,
        createdAt: r.created_at,
        createdBy: null,
        protocols: r.protocols,
        expiresAt: r.expires_at,
        source: "group" as const,
        groupId: r.group_id,
        groupName: r.group_name,
      })),
    ];
  }

  async listAccessUserIds(vmId: string): Promise<string[]> {
    const direct = await this.db.query<{ user_id: string }>(
      `SELECT user_id FROM vm_access WHERE vm_id = $1
        AND (expires_at IS NULL OR expires_at > NOW())`,
      [vmId],
    );
    const grouped = await this.db.query<{ user_id: string }>(
      `SELECT gm.user_id FROM group_vm_access gva
        JOIN group_members gm ON gm.group_id = gva.group_id
          AND (gm.expires_at IS NULL OR gm.expires_at > NOW())
        WHERE gva.vm_id = $1
          AND (gva.expires_at IS NULL OR gva.expires_at > NOW())`,
      [vmId],
    );
    return [...new Set([...direct.rows, ...grouped.rows].map((r) => r.user_id))];
  }

  async hasAccess(vmId: string, userId: string): Promise<boolean> {
    if (!isUuid(vmId) || !isUuid(userId)) return false;
    const direct = await this.db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM vm_access
        WHERE vm_id = $1 AND user_id = $2
        AND (expires_at IS NULL OR expires_at > NOW())`,
      [vmId, userId],
    );
    if (Number(direct.rows[0]?.c ?? "0") > 0) return true;
    const grouped = await this.db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM group_vm_access gva
        JOIN group_members gm ON gm.group_id = gva.group_id
          AND gm.user_id = $2
          AND (gm.expires_at IS NULL OR gm.expires_at > NOW())
        WHERE gva.vm_id = $1
          AND (gva.expires_at IS NULL OR gva.expires_at > NOW())`,
      [vmId, userId],
    );
    return Number(grouped.rows[0]?.c ?? "0") > 0;
  }

  async setPrivacyFlag(id: string, enabled: boolean): Promise<void> {
    await this.db.query("UPDATE vms SET privacy_flag = $2, updated_at = NOW() WHERE id = $1", [id, enabled]);
  }

  async setVmClass(id: string, vmClass: "server" | "user"): Promise<void> {
    if (vmClass !== "server" && vmClass !== "user") {
      throw AppError.validation('vmClass must be "server" or "user"');
    }
    await this.db.query("UPDATE vms SET vm_class = $2, updated_at = NOW() WHERE id = $1", [id, vmClass]);
  }

  async setStartOnBoot(id: string, enabled: boolean): Promise<void> {
    await this.db.query("UPDATE vms SET start_on_boot = $2, updated_at = NOW() WHERE id = $1", [id, enabled]);
  }

  // ---------------------------------------------------------------------------
  // Bulk policy toggles. Shared orchestrators behind /vms/bulk-action.
  // Authorization (entry permission + per-VM resolveVmAccess) and audit
  // logging are the caller's contract; these helpers fan out to the per-VM
  // writers so one failure never aborts the rest. Proxmox-facing helpers
  // (isolation, start-on-boot) take the client so Proxmox and the ProxVM
  // database never disagree; without a client they only record desired state.
  // ---------------------------------------------------------------------------

  /**
   * Bulk set privacy flag across selected VMs. Each item re-checks `visibleTo`
   * — privacy-flagged VMs require a concrete grant or creator-ownership for
   * anyone including admins — so a revoked grant takes effect immediately.
   */
  async bulkSetPrivacy(vmIds: string[], enabled: boolean, userId: string, roles: string[]): Promise<Array<{ vmId: string; ok: boolean; private: boolean; error?: string }>> {
    const results: Array<{ vmId: string; ok: boolean; private: boolean; error?: string }> = [];
    for (const vmId of [...new Set(vmIds)]) {
      try {
        const vm = await this.requireById(vmId);
        if (enabled !== vm.privacyFlag) {
          await this.setPrivacyFlag(vm.id, enabled);
        }
        const vis = await this.visibleTo(userId, roles, vmId);
        results.push({ vmId, ok: true, private: vis.private });
      } catch (err) {
        results.push({ vmId, ok: false, private: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return results;
  }

  /**
   * Bulk set VM class across selected VMs. Server→user is blocked while the
   * VM still has enabled schedules: user-class machines are eligible for
   * idle auto-shutdown, and scheduled power actions would fight the ticker.
   * User→server is always permitted.
   */
  async bulkSetVmClass(vmIds: string[], vmClass: "server" | "user", userId: string, roles: string[]): Promise<Array<{ vmId: string; ok: boolean; error?: string }>> {
    const results: Array<{ vmId: string; ok: boolean; error?: string }> = [];
    for (const vmId of [...new Set(vmIds)]) {
      try {
        const vm = await this.requireById(vmId);
        if (vmClass === "user" && vm.vmClass !== "user") {
          const dep = await this.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM vm_schedules WHERE vm_id = $1 AND enabled", [vmId]);
          if ((dep.rows[0]?.n ?? 0) > 0) {
            throw AppError.validation('VM class switch to "user" is blocked: the VM has enabled schedules that would conflict with idle auto-shutdown');
          }
        }
        if (vmClass !== vm.vmClass) {
          await this.setVmClass(vm.id, vmClass);
        }
        results.push({ vmId, ok: true });
      } catch (err) {
        results.push({ vmId, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return results;
  }

  /**
   * Bulk toggle network isolation across selected VMs. With a Proxmox client
   * this applies/removes the full default-deny guest-firewall ruleset via the
   * same helpers as POST /vms/:id/firewall (idempotent, count in results);
   * without one it only flips the desired-state flag.
   */
  async bulkToggleIsolation(vmIds: string[], enabled: boolean, userId: string, roles: string[], proxmox?: ProxmoxClient): Promise<Array<{ vmId: string; ok: boolean; rules?: number; error?: string }>> {
    const results: Array<{ vmId: string; ok: boolean; rules?: number; error?: string }> = [];
    for (const vmId of [...new Set(vmIds)]) {
      try {
        const vm = await this.requireById(vmId);
        if (proxmox) {
          const outcome = enabled
            ? await applyIsolation(this.db, proxmox, vm.id, vm.node, vm.vmid, { allowInternet: true })
            : await removeIsolation(this.db, proxmox, vm.id, vm.node, vm.vmid);
          const rules = "rulesCreated" in outcome ? outcome.rulesCreated : outcome.rulesRemoved;
          results.push({ vmId, ok: true, rules });
        } else {
          await this.db.query("UPDATE vms SET firewall_isolated = $2, updated_at = NOW() WHERE id = $1", [vmId, enabled]);
          results.push({ vmId, ok: true });
        }
      } catch (err) {
        results.push({ vmId, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return results;
  }

  /**
   * Bulk set start-on-boot across selected VMs. With a Proxmox client this
   * writes Proxmox-first via applyStartOnBoot (same path as the single-VM
   * endpoint) so the `onboot` flag and the DB never disagree; without one it
   * only records desired state.
   */
  async bulkSetStartOnBoot(vmIds: string[], enabled: boolean, userId: string, roles: string[], proxmox?: ProxmoxClient): Promise<Array<{ vmId: string; ok: boolean; error?: string }>> {
    const results: Array<{ vmId: string; ok: boolean; error?: string }> = [];
    for (const vmId of [...new Set(vmIds)]) {
      try {
        const vm = await this.requireById(vmId);
        if (proxmox) {
          await applyStartOnBoot(proxmox, this, vm, enabled);
        } else {
          await this.setStartOnBoot(vm.id, enabled);
        }
        results.push({ vmId, ok: true });
      } catch (err) {
        results.push({ vmId, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return results;
  }

  /**
   * Concrete grant (direct/group row, unexpired) or creator-ownership.
   * Ownership is implicit so flagging a VM never requires pre-configuring
   * grant rows: whoever provisioned it always counts.
   */
  async hasAccessOrOwns(vmId: string, userId: string): Promise<boolean> {
    if (await this.hasAccess(vmId, userId)) return true;
    const vm = await this.findById(vmId);
    return !!vm && vm.createdByUserId === userId;
  }

  /**
   * Flag-aware visibility shared by every VM-scoped route. The legacy
   * ADMIN/OPERATOR bypass applies ONLY to non-private VMs; a privacy-flagged
   * VM requires a concrete grant — or creator-ownership — from anyone,
   * including administrators. Missing VMs deny (callers 404/403 as before
   * based on `allowed`).
   */
  async visibleTo(
    userId: string,
    roles: string[],
    vmId: string,
  ): Promise<{ allowed: boolean; private: boolean }> {
    const privileged = roles.includes("ADMIN") || roles.includes("OPERATOR");
    const vm = await this.findById(vmId);
    if (!vm) return { allowed: privileged, private: false };
    if (vm.privacyFlag) {
      return { allowed: await this.hasAccessOrOwns(vmId, userId), private: true };
    }
    if (privileged) return { allowed: true, private: false };
    return { allowed: await this.hasAccess(vmId, userId), private: false };
  }
}

/**
 * Re-listing a grantee must not silently widen their existing scope: scoped
 * protocols and expiries survive, new grants take the requested scope as-is.
 * Pure so the rule is unit-testable without Guacamole.
 */
export function mergeGrantScope(
  existing: { protocols: string[] | null; expiresAt: Date | null } | null,
  requested: { protocols: string[] | null; expiresAt: Date | string | null },
): { protocols: string[] | null; expiresAt: Date | null } {
  if (!existing) {
    return {
      protocols: requested.protocols,
      expiresAt: requested.expiresAt ? new Date(requested.expiresAt) : null,
    };
  }
  return { protocols: existing.protocols, expiresAt: existing.expiresAt };
}

function toVmRecord(row: VmRow): VmRecord {
  return {
    id: row.id,
    vmid: row.vmid,
    node: row.node,
    name: row.name,
    status: row.status,
    osType: row.os_type,
    osName: row.os_name,
    ipAddress: row.ip_address,
    templateId: row.template_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    privacyFlag: row.privacy_flag ?? false,
    firewallIsolated: row.firewall_isolated ?? false,
    vmClass: row.vm_class === "user" ? "user" : "server",
    startOnBoot: row.start_on_boot ?? false,
    ipStatic: row.ip_static ?? false,
  };
}