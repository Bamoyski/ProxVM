// ---------------------------------------------------------------------------
// Provisioning policy: resource ceilings + static-IP allowlist enforcement
//   shared by the API (early 400) and the worker (failed job). Admins exempt
//   (quotas model); rejections throw, never silently clamp.
// Security: allowlist-gated statics block infra/foreign subnets; network/
//   broadcast addresses and duplicate IPs are refused before any clone.
// ---------------------------------------------------------------------------
import type { Pool } from "pg";
import { AppError } from "../util/errors.js";
import type { Queryable } from "../db/pool.js";
import type { SettingsService } from "../services/settings.js";

/**
 * Central provisioning policy (§14): resource ceilings and static-IP rules
 * enforced identically at request time (API route, early 400) and at
 * execution time (worker, failed job). Administrators are exempt from both,
 * exactly like VM-count quotas. Rejections always throw; nothing is
 * silently clamped.
 */

export interface ProvisionPolicyInput {
  cpu: number;
  ramMb: number;
  diskGb: number;
  network?: { mode?: string; ip?: string | null; gateway?: string | null } | null;
}

export interface ProvisionPolicyDeps {
  db: Queryable | Pool;
  settings: Pick<SettingsService, "get">;
}

function toInt(value: string | undefined, key: string): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw AppError.validation(`${key} must be a positive integer`);
  return n;
}

export async function getProvisionCeilings(deps: ProvisionPolicyDeps): Promise<{
  maxCpu: number | null;
  maxRamMb: number | null;
  maxDiskGb: number | null;
}> {
  const [cpu, ram, disk] = await Promise.all([
    deps.settings.get("provision.max_cpu"),
    deps.settings.get("provision.max_ram_mb"),
    deps.settings.get("provision.max_disk_gb"),
  ]);
  return {
    maxCpu: cpu ? toInt(cpu.value, "provision.max_cpu") : null,
    maxRamMb: ram ? toInt(ram.value, "provision.max_ram_mb") : null,
    maxDiskGb: disk ? toInt(disk.value, "provision.max_disk_gb") : null,
  };
}

function ipToInt(ip: string): number | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

export interface ParsedCidr {
  cidr: string;
  network: number;
  mask: number;
  prefix: number;
}

export function parseCidrList(raw: string | undefined): ParsedCidr[] {
  if (!raw || !raw.trim()) return [];
  const out: ParsedCidr[] = [];
  for (const piece of raw.split(",")) {
    const cidr = piece.trim();
    if (!cidr) continue;
    const [addr, prefixRaw] = cidr.split("/");
    const prefix = prefixRaw === undefined || prefixRaw === "" ? 32 : Number(prefixRaw);
    const base = addr ? ipToInt(addr) : null;
    if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
      throw AppError.validation(`Invalid CIDR "${cidr}": expected IPv4 like 192.168.1.0/24`);
    }
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    out.push({ cidr, network: (base & mask) >>> 0, mask, prefix });
  }
  return out;
}

export async function getStaticAllowlist(deps: ProvisionPolicyDeps): Promise<ParsedCidr[]> {
  const raw = await deps.settings.get("network.static_allowed_cidrs");
  return parseCidrList(raw?.value);
}

async function ipHeldByOtherVm(db: Queryable | Pool, ip: string, excludeVmId: string | null): Promise<boolean> {
  const result = await (db as Queryable).query<{ id: string }>(
    "SELECT id FROM vms WHERE ip_address = $1 AND deleted_at IS NULL AND ($2::text IS NULL OR id <> $2) LIMIT 1",
    [ip, excludeVmId],
  );
  return result.rows.length > 0;
}

export async function validateProvisionPolicy(
  deps: ProvisionPolicyDeps,
  input: ProvisionPolicyInput,
  opts: { isAdmin: boolean; excludeVmId?: string | null },
): Promise<void> {
  if (opts.isAdmin) return;
  const ceilings = await getProvisionCeilings(deps);
  if (ceilings.maxCpu !== null && input.cpu > ceilings.maxCpu) {
    throw AppError.validation(`CPU request (${input.cpu}) exceeds the configured maximum (${ceilings.maxCpu})`);
  }
  if (ceilings.maxRamMb !== null && input.ramMb > ceilings.maxRamMb) {
    throw AppError.validation(`RAM request (${input.ramMb} MB) exceeds the configured maximum (${ceilings.maxRamMb} MB)`);
  }
  if (ceilings.maxDiskGb !== null && input.diskGb > ceilings.maxDiskGb) {
    throw AppError.validation(`Disk request (${input.diskGb} GB) exceeds the configured maximum (${ceilings.maxDiskGb} GB)`);
  }
  const network = input.network;
  if (!network || network.mode !== "static") return;
  const allowlist = await getStaticAllowlist(deps);
  if (allowlist.length === 0) {
    throw AppError.validation("Static IP assignment is disabled. Ask an administrator to allow a subnet.");
  }
  const ip = (network.ip ?? "").trim();
  const gateway = (network.gateway ?? "").trim();
  const ipInt = ipToInt(ip);
  const gwInt = ipToInt(gateway);
  if (ipInt === null) throw AppError.validation("Static IP must be a valid IPv4 address");
  if (gwInt === null) throw AppError.validation("Static gateway must be a valid IPv4 address");
  if (ipInt === gwInt) throw AppError.validation("Static IP must not equal the gateway address");
  const match = allowlist.find((c) => ((ipInt & c.mask) >>> 0) === c.network && ((gwInt & c.mask) >>> 0) === c.network);
  if (!match) {
    throw AppError.validation(
      `Static IP ${ip} is outside the allowed subnets (${allowlist.map((c) => c.cidr).join(", ")})`,
    );
  }
  // Reject network and broadcast addresses of the matched subnet.
  if (match.prefix < 31 && (ipInt === match.network || ipInt === (match.network | (~match.mask >>> 0)) >>> 0)) {
    throw AppError.validation(`Static IP ${ip} is a network or broadcast address`);
  }
  if (await ipHeldByOtherVm(deps.db, ip, opts.excludeVmId ?? null)) {
    throw AppError.validation(`Static IP ${ip} is already allocated to another VM`);
  }
}

/**
 * Manual IP override (PUT /vms/:id/ip): same allowlist discipline as
 * provisioning, minus the gateway field the override form does not collect.
 * Administrators are exempt, like everywhere else in this module.
 */
export async function validateIpOverride(
  deps: ProvisionPolicyDeps,
  ip: string,
  opts: { isAdmin: boolean; excludeVmId?: string | null },
): Promise<void> {
  if (opts.isAdmin) return;
  const allowlist = await getStaticAllowlist(deps);
  if (allowlist.length === 0) {
    throw AppError.validation("Static IP assignment is disabled. Ask an administrator to allow a subnet.");
  }
  const clean = ip.trim();
  const ipInt = ipToInt(clean);
  if (ipInt === null) throw AppError.validation("IP must be a valid IPv4 address");
  const match = allowlist.find((c) => ((ipInt & c.mask) >>> 0) === c.network);
  if (!match) {
    throw AppError.validation(
      `IP ${clean} is outside the allowed subnets (${allowlist.map((c) => c.cidr).join(", ")})`,
    );
  }
  if (match.prefix < 31 && (ipInt === match.network || ipInt === (match.network | (~match.mask >>> 0)) >>> 0)) {
    throw AppError.validation(`IP ${clean} is a network or broadcast address`);
  }
  if (await ipHeldByOtherVm(deps.db, clean, opts.excludeVmId ?? null)) {
    throw AppError.validation(`IP ${clean} is already allocated to another VM`);
  }
}
