import type {
  BasicProvisionRequest,
  Protocol,
  ProvisionVmRequest,
  TemplateRecord,
  UserWithRoles,
} from "@proxvm/shared";
import { provisionVmSchema } from "@proxvm/shared";
import { AppError } from "../util/errors.js";
import type { SettingsService } from "../services/settings.js";
import type { TemplatesService } from "../services/templates.js";
import type { UsersService } from "../services/users.js";
import type { ProxmoxClient } from "../proxmox/client.js";

// Centralized Basic-mode provisioning defaults. Both the web UI (via
// GET /api/provisioning/defaults) and the provision route (partial request
// -> full validated request) resolve through here, so there is exactly one
// place where defaults live. The pipeline itself is untouched: it receives
// the same full ProvisionVmRequest either way and keeps validating
// node/storage/bridge live against Proxmox.
//
// Precedence everywhere: explicit request value -> ProxVM configured
// setting -> template value -> built-in fallback.

export const FALLBACK_BRIDGE = "vmbr0";
export const FALLBACK_STORAGE = "local-lvm";
export const FALLBACK_GUEST_USER = "deploy";

export interface ProvisionDeps {
  settings: SettingsService;
  templates: TemplatesService;
  users: UsersService;
  getProxmoxClient?: () => Promise<ProxmoxClient>;
}

export interface ResolvedProvisionDefaults {
  node: string | null;
  storage: string | null;
  bridge: string;
  cpu: number;
  ramMb: number;
  diskGb: number;
  guestUser: string;
  mode: "dhcp" | "static";
  protocols: Protocol[];
  osType: TemplateRecord["osType"];
  verified: boolean;
  warnings: string[];
}

/**
 * Resolve a (possibly partial) Basic provisioning request into a full,
 * schema-validated ProvisionVmRequest. Throws 4xx AppErrors for invalid
 * input, including protocols not supported by the template and unknown
 * assigned users. Authorization (including vm.edit for assignment) is
 * enforced by the caller, which can consult DB-backed grants.
 */
export async function resolveProvisionRequest(
  deps: ProvisionDeps,
  input: BasicProvisionRequest,
): Promise<ProvisionVmRequest> {
  const template = await deps.templates.requireById(input.templateId);
  deps.templates.ensureProvisionable(template);
  const settings = await deps.settings.proxmox();

  if (input.protocols?.length) {
    const supported = new Set(template.supportedProtocols);
    const unsupported = input.protocols.filter((p) => !supported.has(p));
    if (unsupported.length) {
      throw AppError.validation(
        `Template "${template.name}" does not support protocol(s): ${unsupported.join(", ")}. Supported: ${template.supportedProtocols.join(", ") || "none"}.`,
      );
    }
  }

  // NOTE: vm.edit authorization for assignment lives in the route (DB-aware,
  // custom roles included), not here: this resolver only knows legacy roles.
  const assignToUserIds = input.assignToUserIds ?? [];
  for (const userId of assignToUserIds) {
    const target = await deps.users.findById(userId);
    if (!target) throw AppError.validation(`Assigned user does not exist: ${userId}`);
  }

  const storage = input.storage?.trim()
    ? input.storage
    : (settings?.defaultStorage?.trim() ? settings.defaultStorage : null);
  if (!storage) {
    throw AppError.validation("storage is required (no default storage configured)");
  }

  // Fail fast: the pipeline would otherwise clone the VM first and only fail
  // at cloud-init configuration, leaving an orphaned Proxmox VM behind.
  const mode = input.network?.mode ?? "dhcp";
  if (mode === "static" && (!input.network?.ip || !input.network?.gateway)) {
    throw AppError.validation("Static networking requires both ip and gateway");
  }

  const resolved = {
    name: input.name,
    templateId: input.templateId,
    proxmoxTemplateVmid: input.proxmoxTemplateVmid,
    node: input.node ?? settings?.defaultNode ?? template.node,
    vmid: input.vmid,
    cpu: input.cpu ?? template.defaultCpu,
    ramMb: input.ramMb ?? template.defaultRamMb,
    diskGb: input.diskGb ?? template.defaultDiskGb,
    storage,
    network: {
      bridge: input.network?.bridge ?? settings?.defaultNetwork ?? FALLBACK_BRIDGE,
      vlan: input.network?.vlan,
      mode: input.network?.mode ?? ("dhcp" as const),
      ip: input.network?.ip,
      cidr: input.network?.cidr,
      gateway: input.network?.gateway,
      dns: input.network?.dns,
    },
    osType: input.osType ?? template.osType,
    protocols: input.protocols,
    guestUser: input.guestUser ?? FALLBACK_GUEST_USER,
    password: input.password,
    sshKey: input.sshKey,
    startAfterProvision: input.startAfterProvision ?? true,
    linkedClone: input.linkedClone ?? true,
    assignToUserIds,
  };
  // Authoritative final validation: the resolved request must satisfy the
  // exact same schema as an explicit Advanced request.
  return provisionVmSchema.parse(resolved);
}

/**
 * Resolve the defaults to prefill the Basic form, verifying node, storage
 * and bridge against the live Proxmox cluster when reachable. Never exposes
 * secrets — only resource names. Falls back gracefully when Proxmox is
 * unreachable (verified=false); the pipeline still validates live later.
 */
export async function resolveProvisionDefaults(
  deps: ProvisionDeps,
  opts: { templateId?: string; node?: string },
): Promise<ResolvedProvisionDefaults> {
  const warnings: string[] = [];
  const template = opts.templateId ? await deps.templates.requireById(opts.templateId) : null;
  const settings = await deps.settings.proxmox();

  let node: string | null = null;
  const wantStorage = settings?.defaultStorage?.trim() || null;
  const wantBridge = settings?.defaultNetwork?.trim() || FALLBACK_BRIDGE;
  let storage: string | null = wantStorage;
  let bridge = wantBridge;
  let verified = false;

  try {
    if (!deps.getProxmoxClient) throw new Error("No Proxmox client available");
    const proxmox = await deps.getProxmoxClient();
    const nodes = await proxmox.nodes();
    const nodeNames = nodes.map((n) => n.node);
    const pickNode =
      (opts.node && nodeNames.includes(opts.node) && opts.node) ||
      (settings?.defaultNode && nodeNames.includes(settings.defaultNode) && settings.defaultNode) ||
      (template && nodeNames.includes(template.node) && template.node) ||
      nodeNames[0] ||
      null;
    if (!pickNode) {
      warnings.push("No Proxmox nodes found in the cluster.");
    } else {
      node = pickNode;
      if (opts.node && opts.node !== pickNode) warnings.push(`Node "${opts.node}" not found; using "${pickNode}".`);
      const storages = await proxmox.storages(pickNode);
      const images = storages.filter((s) => String(s.content ?? "").includes("images"));
      const hasStorage = (name: string | null) => !!name && images.some((s) => String(s.storage) === name);
      if (!hasStorage(storage)) {
        storage = hasStorage(FALLBACK_STORAGE)
          ? FALLBACK_STORAGE
          : (images[0] ? String(images[0].storage) : null);
        if (!storage) {
          warnings.push(`No image-capable storage found on node "${pickNode}".`);
        } else if (storage !== wantStorage) {
          warnings.push(
            wantStorage
              ? `Storage "${wantStorage}" not found on node "${pickNode}" or cannot hold images; using "${storage}".`
              : `No default storage configured; using "${storage}" on node "${pickNode}".`,
          );
        }
      }
      const networks = await proxmox.networks(pickNode);
      const ifaces = networks.map((n) => String(n.iface));
      if (!ifaces.includes(bridge)) {
        bridge = ifaces.includes(FALLBACK_BRIDGE) ? FALLBACK_BRIDGE : (ifaces[0] ?? FALLBACK_BRIDGE);
        if (!ifaces.includes(bridge)) {
          warnings.push(`No network bridges found on node "${pickNode}".`);
        } else if (bridge !== wantBridge) {
          warnings.push(`Bridge "${wantBridge}" not found on node "${pickNode}"; using "${bridge}".`);
        }
      }
      verified = true;
    }
  } catch (err) {
    warnings.push(`Proxmox unreachable; showing configured defaults: ${err instanceof Error ? err.message : String(err)}`);
    node = opts.node ?? settings?.defaultNode ?? template?.node ?? null;
    if (!storage) storage = FALLBACK_STORAGE;
  }

  return {
    node,
    storage,
    bridge,
    cpu: template?.defaultCpu ?? 2,
    ramMb: template?.defaultRamMb ?? 2048,
    diskGb: template?.defaultDiskGb ?? 20,
    guestUser: FALLBACK_GUEST_USER,
    mode: "dhcp",
    protocols: template ? [...template.supportedProtocols] : [],
    osType: template?.osType ?? "linux",
    verified,
    warnings,
  };
}
