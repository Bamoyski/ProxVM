import { describe, expect, it } from "vitest";
import { parseCidrList, validateProvisionPolicy } from "./provisioning/policy.js";

function deps(opts: { settings?: Record<string, string>; ipsTaken?: string[] } = {}) {
  return {
    settings: {
      get: async (key: string) => (opts.settings?.[key] !== undefined ? { value: opts.settings[key]!, encrypted: false } : null),
    },
    db: {
      query: async () => ({ rows: (opts.ipsTaken ?? []).map((id) => ({ id })), rowCount: opts.ipsTaken?.length ?? 0 }),
    },
  } as never;
}

const base = { cpu: 2, ramMb: 2048, diskGb: 32, network: { mode: "dhcp" } };

describe("provisioning policy", () => {
  it("passes when nothing is configured", async () => {
    await expect(validateProvisionPolicy(deps(), base, { isAdmin: false })).resolves.toBeUndefined();
  });

  it("admins are exempt from ceilings", async () => {
    const d = deps({ settings: { "provision.max_cpu": "2" } });
    await expect(
      validateProvisionPolicy(d, { ...base, cpu: 64 }, { isAdmin: true }),
    ).resolves.toBeUndefined();
    await expect(validateProvisionPolicy(d, { ...base, cpu: 64 }, { isAdmin: false })).rejects.toThrow(/maximum \(2\)/);
    await expect(validateProvisionPolicy(d, { ...base, cpu: 2 }, { isAdmin: false })).resolves.toBeUndefined();
  });

  it("enforces ram and disk ceilings", async () => {
    const d = deps({ settings: { "provision.max_ram_mb": "4096", "provision.max_disk_gb": "100" } });
    await expect(validateProvisionPolicy(d, { ...base, ramMb: 8192 }, { isAdmin: false })).rejects.toThrow(/maximum/);
    await expect(validateProvisionPolicy(d, { ...base, diskGb: 101 }, { isAdmin: false })).rejects.toThrow(/maximum/);
  });

  it("rejects static assignment when no subnets are allowed", async () => {
    const d = deps();
    await expect(
      validateProvisionPolicy(
        d,
        { ...base, network: { mode: "static", ip: "192.168.1.50", gateway: "192.168.1.1" } },
        { isAdmin: false },
      ),
    ).rejects.toThrow(/disabled/);
  });

  it("accepts in-allowlist addresses, rejects the rest", async () => {
    const d = deps({ settings: { "network.static_allowed_cidrs": "192.168.1.0/24" } });
    const good = { ...base, network: { mode: "static", ip: "192.168.1.50", gateway: "192.168.1.1" } };
    await expect(validateProvisionPolicy(d, good, { isAdmin: false })).resolves.toBeUndefined();
    const outside = { ...base, network: { mode: "static", ip: "10.0.0.5", gateway: "10.0.0.1" } };
    await expect(validateProvisionPolicy(d, outside, { isAdmin: false })).rejects.toThrow(/outside the allowed subnets/);
  });

  it("rejects network, broadcast, gateway-equal, and duplicate addresses", async () => {
    const d = deps({ settings: { "network.static_allowed_cidrs": "192.168.1.0/24" } });
    const net = { ...base, network: { mode: "static", ip: "192.168.1.0", gateway: "192.168.1.1" } };
    await expect(validateProvisionPolicy(d, net, { isAdmin: false })).rejects.toThrow(/network or broadcast/);
    const bcast = { ...base, network: { mode: "static", ip: "192.168.1.255", gateway: "192.168.1.1" } };
    await expect(validateProvisionPolicy(d, bcast, { isAdmin: false })).rejects.toThrow(/network or broadcast/);
    const gw = { ...base, network: { mode: "static", ip: "192.168.1.1", gateway: "192.168.1.1" } };
    await expect(validateProvisionPolicy(d, gw, { isAdmin: false })).rejects.toThrow(/must not equal the gateway/);
    const dup = deps({ settings: { "network.static_allowed_cidrs": "192.168.1.0/24" }, ipsTaken: ["other-vm"] });
    const taken = { ...base, network: { mode: "static", ip: "192.168.1.50", gateway: "192.168.1.1" } };
    await expect(validateProvisionPolicy(dup, taken, { isAdmin: false })).rejects.toThrow(/already allocated/);
  });

  it("rejects malformed allowlists at save/parse time", () => {
    expect(() => parseCidrList("not-a-cidr")).toThrow(/Invalid CIDR/);
    expect(() => parseCidrList("192.168.1.0/33")).toThrow(/Invalid CIDR/);
    expect(parseCidrList("")).toEqual([]);
    expect(parseCidrList("10.0.0.5")).toHaveLength(1);
  });
});
