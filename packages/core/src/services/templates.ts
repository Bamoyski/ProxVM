// ---------------------------------------------------------------------------
// TemplatesService: Proxmox template registry behind provisioning choices.
// - Identity is (node, proxmoxVmid): register() upserts on that key so
//   re-registering refreshes metadata instead of duplicating rows.
// - ensureProvisionable is the automation gate: Linux requires cloud-init,
//   Windows requires Cloudbase-Init + cloud-init drive; anything else gets
//   a validation/501 before a job is ever queued (not mid-provision).
// - Rows are purely descriptive (defaults, protocols, agent requirements);
//   tenant isolation lives in the VM/access layers, not here.
// ---------------------------------------------------------------------------
import type { Pool } from "pg";
import type { OsType, Protocol, ProvisioningMethod, TemplateRecord } from "@proxvm/shared";
import { AppError } from "../util/errors.js";
import { isUuid, newId } from "../util/misc.js";
import type { TemplateRow } from "./rows.js";

/** Registration-time template metadata; identity is (node, proxmoxVmid). */
export interface RegisterTemplateInput {
  name: string;
  node: string;
  proxmoxVmid: number;
  osType: OsType;
  provisioningMethod: ProvisioningMethod;
  cloudInitSupport: boolean;
  guestAgentRequired: boolean;
  defaultCpu: number;
  defaultRamMb: number;
  defaultDiskGb: number;
  supportedProtocols: Protocol[];
}

/** Template registry; register() upserts on (node, proxmoxVmid). */
export class TemplatesService {
  constructor(private readonly db: Pool) {}

  async register(input: RegisterTemplateInput): Promise<TemplateRecord> {
    const existing = await this.findByProxmoxId(input.node, input.proxmoxVmid);
    if (existing) {
      const result = await this.db.query<TemplateRow>(
        `UPDATE vm_templates SET
           name = $3, os_type = $4, provisioning_method = $5, cloud_init_support = $6,
           guest_agent_required = $7, default_cpu = $8, default_ram_mb = $9,
           default_disk_gb = $10, supported_protocols = $11, updated_at = NOW()
         WHERE id = $1 AND node = $2
         RETURNING *`,
        [
          existing.id,
          input.node,
          input.name,
          input.osType,
          input.provisioningMethod,
          input.cloudInitSupport,
          input.guestAgentRequired,
          input.defaultCpu,
          input.defaultRamMb,
          input.defaultDiskGb,
          input.supportedProtocols,
        ],
      );
      return toTemplateRecord(result.rows[0] as TemplateRow);
    }
    const result = await this.db.query<TemplateRow>(
      `INSERT INTO vm_templates (id, name, node, proxmox_vmid, os_type, provisioning_method,
        cloud_init_support, guest_agent_required, default_cpu, default_ram_mb,
        default_disk_gb, supported_protocols)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        newId(),
        input.name,
        input.node,
        input.proxmoxVmid,
        input.osType,
        input.provisioningMethod,
        input.cloudInitSupport,
        input.guestAgentRequired,
        input.defaultCpu,
        input.defaultRamMb,
        input.defaultDiskGb,
        input.supportedProtocols,
      ],
    );
    return toTemplateRecord(result.rows[0] as TemplateRow);
  }

  // -- Reads: full list, (node, vmid) identity, id lookups --------------
  async list(): Promise<TemplateRecord[]> {
    const result = await this.db.query<TemplateRow>(
      "SELECT * FROM vm_templates ORDER BY name ASC",
    );
    return result.rows.map(toTemplateRecord);
  }

  async findByProxmoxId(node: string, proxmoxVmid: number): Promise<TemplateRecord | null> {
    const result = await this.db.query<TemplateRow>(
      "SELECT * FROM vm_templates WHERE node = $1 AND proxmox_vmid = $2",
      [node, proxmoxVmid],
    );
    return result.rows[0] ? toTemplateRecord(result.rows[0]) : null;
  }

  async requireById(id: string): Promise<TemplateRecord> {
    const result = await this.db.query<TemplateRow>(
      "SELECT * FROM vm_templates WHERE id = $1",
      [id],
    );
    if (!result.rows[0]) throw AppError.notFound("Template not found");
    return toTemplateRecord(result.rows[0]);
  }

  async findById(id: string): Promise<TemplateRecord | null> {
    if (!isUuid(id)) return null;
    const result = await this.db.query<TemplateRow>(
      "SELECT * FROM vm_templates WHERE id = $1",
      [id],
    );
    return result.rows[0] ? toTemplateRecord(result.rows[0]) : null;
  }

  async delete(id: string): Promise<void> {
    await this.db.query("DELETE FROM vm_templates WHERE id = $1", [id]);
  }

  /**
   * Automation gate: throws unless the template can provision unattended.
   * Linux needs cloud-init; Windows needs Cloudbase-Init on the drive.
   */
  ensureProvisionable(template: TemplateRecord): void {
    if (template.osType === "linux" && template.provisioningMethod !== "cloud-init") {
      throw AppError.validation(
        `Linux template "${template.name}" uses provisioning method "${template.provisioningMethod}". Only "cloud-init" is supported for automated Linux provisioning.`,
      );
    }
    if (template.osType === "windows") {
      if (template.provisioningMethod === "cloudbase-init" && template.cloudInitSupport) return;
      throw new AppError(
        "NOT_IMPLEMENTED",
        `Windows template "${template.name}" (provisioning: ${template.provisioningMethod}, cloud-init: ${template.cloudInitSupport ? "yes" : "no"}) does not support automated guest provisioning. Only Windows templates prepared with Cloudbase-Init on the Proxmox cloud-init drive can be provisioned automatically.`,
        501,
      );
    }
  }
}

function toTemplateRecord(row: TemplateRow): TemplateRecord {
  return {
    id: row.id,
    name: row.name,
    node: row.node,
    proxmoxVmid: row.proxmox_vmid,
    osType: row.os_type,
    provisioningMethod: row.provisioning_method,
    cloudInitSupport: row.cloud_init_support,
    guestAgentRequired: row.guest_agent_required,
    defaultCpu: row.default_cpu,
    defaultRamMb: row.default_ram_mb,
    defaultDiskGb: row.default_disk_gb,
    supportedProtocols: row.supported_protocols,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}