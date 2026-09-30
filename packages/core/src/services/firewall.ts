import type { Pool } from "pg";
import { AppError } from "../util/errors.js";
import type { ProxmoxClient } from "../proxmox/client.js";

/**
 * Per-VM network isolation via the Proxmox VE firewall ("default deny").
 *
 * Model: the guest's firewall is switched on with DROP policies both ways,
 * and only explicitly configured traffic is ACCEPTed on top. Established
 * return traffic always passes (conntrack), so Guacamole-initiated RDP/SSH
 * keeps working while the guest itself cannot open anything new.
 *
 * Safety rules (load-bearing, do not relax without review):
 * - Opt-in per VM only. Nothing here ever touches datacenter/node/host config.
 * - applyIsolation refuses when the cluster firewall is disabled, because VM
 *   rules are then silently ignored and the operator would believe a lie.
 * - Only rules carrying PROXVM_RULE_COMMENT are ever deleted by ProxVM.
 *   Anything else on the guest (template-inherited, hand-made) is left alone.
 */

export const PROXVM_RULE_COMMENT = "proxvm-isolation";

export interface IsolationRule {
  action: "ACCEPT" | "DROP" | "REJECT";
  type: "in" | "out";
  proto?: string;
  dport?: string;
  sport?: string;
  source?: string;
  dest?: string;
  comment?: string;
}

export interface IsolationOptions {
  /** Host/CIDR allowed to open RDP/SSH/VNC into the guest (usually guacd). Empty = no inbound allows. */
  allowFrom?: string;
  /** Extra inbound TCP ports to open from allowFrom (default: 22,3389,5900:5910). */
  inboundPorts?: string[];
  /** DNS resolver the guest may use (UDP+TCP 53). Empty = no DNS. */
  allowDnsTo?: string;
  /** Extra custom rules appended after the generated ones. */
  extraRules?: IsolationRule[];
}

export interface IsolationStatus {
  enabled: boolean;
  policyIn: string | null;
  policyOut: string | null;
  proxvmRules: Array<{ pos: number; type: string; action: string; proto: string; dport: string; source: string }>;
  otherRuleCount: number;
}

const DEFAULT_INBOUND_PORTS = ["22", "3389", "5900:5910"];

/** Pure rule builder — unit-tested, no I/O. */
export function buildIsolationRules(opts: IsolationOptions): IsolationRule[] {
  if (opts.allowFrom) assertAddress(opts.allowFrom, "allowFrom");
  if (opts.allowDnsTo) assertAddress(opts.allowDnsTo, "allowDnsTo");
  for (const p of opts.inboundPorts ?? []) assertPortSpec(p, "inboundPorts");
  const rules: IsolationRule[] = [];
  const ports = opts.inboundPorts && opts.inboundPorts.length > 0 ? opts.inboundPorts : DEFAULT_INBOUND_PORTS;
  if (opts.allowFrom) {
    for (const dport of ports) {
      rules.push({
        action: "ACCEPT",
        type: "in",
        proto: "tcp",
        dport,
        source: opts.allowFrom,
        comment: `${PROXVM_RULE_COMMENT}: remote access from ${opts.allowFrom}`,
      });
    }
  }
  if (opts.allowDnsTo) {
    for (const proto of ["udp", "tcp"]) {
      rules.push({
        action: "ACCEPT",
        type: "out",
        proto,
        dport: "53",
        dest: opts.allowDnsTo,
        comment: `${PROXVM_RULE_COMMENT}: dns to ${opts.allowDnsTo}`,
      });
    }
  }
  for (const extra of opts.extraRules ?? []) {
    rules.push({ ...extra, comment: extra.comment ?? PROXVM_RULE_COMMENT });
  }
  return rules;
}

export function isProxvmRule(rule: { comment?: unknown }): boolean {
  return typeof rule.comment === "string" && rule.comment.startsWith(PROXVM_RULE_COMMENT);
}

function assertPortSpec(spec: string, field: string): void {
  if (!/^[\d,:]+$/.test(spec) || spec.length > 64) {
    throw AppError.validation(`${field} must be ports like 22, ranges like 5900:5910, comma-separated`);
  }
  for (const part of spec.split(",")) {
    const range = part.split(":");
    if (range.length > 2 || range.some((n) => !/^\d+$/.test(n))) {
      throw AppError.validation(`${field} must be ports like 22, ranges like 5900:5910, comma-separated`);
    }
    const nums = range.map(Number);
    if (nums.some((n) => n < 0 || n > 65535) || (nums.length === 2 && (nums[0] as number) > (nums[1] as number))) {
      throw AppError.validation(`${field} ports must be 0–65535 with range start ≤ end`);
    }
  }
}

function assertAddress(value: string, field: string): void {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/([0-9]|[12][0-9]|3[0-2]))?$/.exec(value);
  if (!match) {
    throw AppError.validation(`${field} must be an IPv4 address or CIDR (e.g. 192.168.1.22 or 10.0.0.0/24)`);
  }
  for (const octet of match.slice(1, 5)) {
    if (Number(octet) > 255) throw AppError.validation(`${field} has an octet above 255`);
  }
}

/** Validates a hand-written rule body; every custom rule is stamped so only ProxVM's own are ever deleted. */
export function assertFirewallRuleInput(body: unknown): {
  action: "ACCEPT" | "DROP" | "REJECT";
  type: "in" | "out";
  proto?: string;
  dport?: string;
  sport?: string;
  source?: string;
  dest?: string;
  comment: string;
} {
  const b = body as Record<string, unknown>;
  const action = b.action;
  if (action !== "ACCEPT" && action !== "DROP" && action !== "REJECT") {
    throw AppError.validation("action must be ACCEPT, DROP, or REJECT");
  }
  const type = b.type;
  if (type !== "in" && type !== "out") {
    throw AppError.validation("type must be in or out");
  }
  const out: {
    action: "ACCEPT" | "DROP" | "REJECT";
    type: "in" | "out";
    proto?: string;
    dport?: string;
    sport?: string;
    source?: string;
    dest?: string;
    comment: string;
  } = { action, type, comment: PROXVM_RULE_COMMENT };
  if (b.proto !== undefined) {
    if (b.proto !== "tcp" && b.proto !== "udp" && b.proto !== "icmp") {
      throw AppError.validation("proto must be tcp, udp, or icmp");
    }
    out.proto = b.proto;
  }
  if (typeof b.dport === "string" && b.dport) {
    assertPortSpec(b.dport, "dport");
    out.dport = b.dport;
  }
  if (typeof b.sport === "string" && b.sport) {
    assertPortSpec(b.sport, "sport");
    out.sport = b.sport;
  }
  if (typeof b.source === "string" && b.source) {
    assertAddress(b.source, "source");
    out.source = b.source;
  }
  if (typeof b.dest === "string" && b.dest) {
    assertAddress(b.dest, "dest");
    out.dest = b.dest;
  }
  if (typeof b.comment === "string" && b.comment.trim()) {
    out.comment = `${PROXVM_RULE_COMMENT}: ${b.comment.trim().slice(0, 80)}`;
  }
  return out;
}

async function clusterFirewallEnabled(proxmox: ProxmoxClient): Promise<boolean> {
  const opts = await proxmox.clusterFirewallOptions();
  const enable = (opts as Record<string, unknown>).enable;
  return enable === 1 || enable === "1" || enable === true;
}

export async function getIsolationStatus(
  proxmox: ProxmoxClient,
  node: string,
  vmid: number,
): Promise<IsolationStatus> {
  const [options, rules] = await Promise.all([
    proxmox.guestFirewallOptions(node, vmid),
    proxmox.guestFirewallRules(node, vmid),
  ]);
  const o = options as Record<string, unknown>;
  const proxvmRules: IsolationStatus["proxvmRules"] = [];
  let otherRuleCount = 0;
  for (const r of rules) {
    const rec = r as Record<string, unknown>;
    if (isProxvmRule(rec)) {
      proxvmRules.push({
        pos: Number(rec.pos ?? -1),
        type: String(rec.type ?? ""),
        action: String(rec.action ?? ""),
        proto: String(rec.proto ?? ""),
        dport: String(rec.dport ?? ""),
        source: String(rec.source ?? rec.dest ?? ""),
      });
    } else {
      otherRuleCount += 1;
    }
  }
  return {
    enabled: o.enable === 1 || o.enable === "1" || o.enable === true,
    policyIn: typeof o.policy_in === "string" ? o.policy_in : null,
    policyOut: typeof o.policy_out === "string" ? o.policy_out : null,
    proxvmRules,
    otherRuleCount,
  };
}

export async function applyIsolation(
  db: Pool,
  proxmox: ProxmoxClient,
  vmId: string,
  node: string,
  vmid: number,
  opts: IsolationOptions,
): Promise<{ rulesCreated: number }> {
  if (!(await clusterFirewallEnabled(proxmox))) {
    throw AppError.validation(
      "Proxmox cluster firewall is disabled, so guest rules would be silently ignored. " +
        "Enable it once (Datacenter → Firewall → Options) and retry — ProxVM will not touch datacenter config itself.",
    );
  }
  const rules = buildIsolationRules(opts);
  await proxmox.setGuestFirewallOptions(node, vmid, { enable: true, policy_in: "DROP", policy_out: "DROP" });
  // Remove our own stale rules first so re-applying stays idempotent.
  const existing = await proxmox.guestFirewallRules(node, vmid);
  const stale = existing
    .filter((r) => isProxvmRule(r as Record<string, unknown>))
    .map((r) => Number((r as Record<string, unknown>).pos))
    .filter((pos) => Number.isInteger(pos) && pos >= 0)
    .sort((a, b) => b - a);
  for (const pos of stale) {
    await proxmox.deleteGuestFirewallRule(node, vmid, pos);
  }
  for (const rule of rules) {
    await proxmox.createGuestFirewallRule(node, vmid, {
      action: rule.action,
      type: rule.type,
      proto: rule.proto,
      dport: rule.dport,
      sport: rule.sport,
      source: rule.source,
      dest: rule.dest,
      comment: rule.comment,
    });
  }
  await db.query("UPDATE vms SET firewall_isolated = TRUE, updated_at = NOW() WHERE id = $1", [vmId]);
  return { rulesCreated: rules.length };
}

export async function removeIsolation(
  db: Pool,
  proxmox: ProxmoxClient,
  vmId: string,
  node: string,
  vmid: number,
): Promise<{ rulesRemoved: number }> {
  const existing = await proxmox.guestFirewallRules(node, vmid);
  const ours = existing
    .filter((r) => isProxvmRule(r as Record<string, unknown>))
    .map((r) => Number((r as Record<string, unknown>).pos))
    .filter((pos) => Number.isInteger(pos) && pos >= 0)
    .sort((a, b) => b - a);
  for (const pos of ours) {
    await proxmox.deleteGuestFirewallRule(node, vmid, pos);
  }
  // Back to wide open; only our rules were touched, hand-made ones survive.
  await proxmox.setGuestFirewallOptions(node, vmid, { policy_in: "ACCEPT", policy_out: "ACCEPT" });
  await db.query("UPDATE vms SET firewall_isolated = FALSE, updated_at = NOW() WHERE id = $1", [vmId]);
  return { rulesRemoved: ours.length };
}
