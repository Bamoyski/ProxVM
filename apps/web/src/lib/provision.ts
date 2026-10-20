/**
 * Provisioning payload builders — extracted so the exact wire shape is
 * covered by tests (payload parity with the legacy wizard is a hard
 * requirement; see docs/UI_REWRITE_ARCHITECTURE.md).
 *
 * Both modes POST /vms/provision and receive 202 {jobId}. Undefined values
 * are omitted from the JSON body entirely (JSON.stringify drops them), which
 * is what the backend expects: absent = "resolve from configured defaults".
 */

export interface BasicProvisionForm {
  name: string;
  templateId: string;
  cpu: number;
  ramMb: number;
  diskGb: number;
  bridge: string;
  protocols: string[];
  password?: string;
}

export interface AdvancedProvisionForm {
  name: string;
  templateId: string;
  node: string;
  vmid: string;
  cpu: number;
  ramMb: number;
  diskGb: number;
  storage: string;
  bridge: string;
  vlan: string;
  mode: string;
  ip: string;
  cidr: string;
  gateway: string;
  dns: string;
  guestUser: string;
  linkedClone: boolean;
  protocols: string[];
}

export interface ProvisionPayloadOptions {
  /** Template fallback (node/osType) when the form leaves them blank. */
  templateNode?: string | undefined;
  templateOsType?: string | undefined;
  password?: string | undefined;
  assignToUserIds?: string[];
}

/** Basic mode: intentionally partial — node/storage/guestUser are resolved
 *  server-side from configured defaults; only chosen values are sent. */
export function buildBasicPayload(
  form: BasicProvisionForm,
  opts: ProvisionPayloadOptions = {},
): Record<string, unknown> {
  return {
    name: form.name,
    templateId: form.templateId,
    cpu: form.cpu,
    ramMb: form.ramMb,
    diskGb: form.diskGb,
    network: { bridge: form.bridge || undefined, mode: "dhcp" },
    protocols: form.protocols.length ? form.protocols : undefined,
    password: opts.password,
    assignToUserIds: opts.assignToUserIds,
  };
}

/** Advanced mode: every field the operator typed is forwarded; blanks become
 *  undefined so the server falls back to its own defaults. */
export function buildAdvancedPayload(
  form: AdvancedProvisionForm,
  opts: ProvisionPayloadOptions = {},
): Record<string, unknown> {
  return {
    name: form.name,
    templateId: form.templateId,
    node: form.node || opts.templateNode,
    vmid: form.vmid ? Number(form.vmid) : undefined,
    cpu: form.cpu,
    ramMb: form.ramMb,
    diskGb: form.diskGb,
    storage: form.storage,
    network: {
      bridge: form.bridge,
      vlan: form.vlan ? Number(form.vlan) : undefined,
      mode: form.mode,
      ip: form.mode === "static" ? form.ip : undefined,
      cidr: form.mode === "static" ? Number(form.cidr) : undefined,
      gateway: form.mode === "static" ? form.gateway : undefined,
      dns: form.dns ? form.dns.split(/[\s,]+/).filter(Boolean) : undefined,
    },
    osType: opts.templateOsType,
    protocols: form.protocols.length ? form.protocols : undefined,
    guestUser: form.guestUser,
    password: opts.password,
    linkedClone: form.linkedClone,
    assignToUserIds: opts.assignToUserIds,
  };
}
