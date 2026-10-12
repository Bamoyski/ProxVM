import { describe, expect, it } from "vitest";
import {
  applyIsolation,
  assertFirewallRuleInput,
  buildIsolationRules,
  isProxvmRule,
  PRIVATE_EGRESS_RANGES,
  PROXVM_RULE_COMMENT,
} from "./index.js";

describe("isolation rule builder", () => {
  it("opens remote-access ports from one source plus optional DNS, all stamped", () => {
    const rules = buildIsolationRules({ allowFrom: "192.168.1.22", allowDnsTo: "192.168.1.1" });
    // 3 inbound + 2 dns + 2 dhcp + 5 lan drops + 1 internet accept
    expect(rules).toHaveLength(13);
    expect(rules[0]).toMatchObject({ action: "ACCEPT", type: "in", proto: "tcp", dport: "22", source: "192.168.1.22" });
    expect(rules[3]).toMatchObject({ action: "ACCEPT", type: "out", proto: "udp", dport: "53", dest: "192.168.1.1" });
    for (const r of rules) expect(r.comment ?? "").toContain(PROXVM_RULE_COMMENT);
  });
  it("allows internet but never the local network, in evaluation order", () => {
    const rules = buildIsolationRules({ allowFrom: "192.168.1.22", allowDnsTo: "192.168.1.1" });
    const out = rules.filter((r) => r.type === "out");
    const kinds = out.map((r) => r.comment ?? "");
    const dnsIdx = kinds.findIndex((c) => c.includes("dns to"));
    const dhcpIdx = kinds.findIndex((c) => c.includes("dhcp client"));
    const firstDropIdx = kinds.findIndex((r) => r.includes("no local network"));
    const internetIdx = kinds.findIndex((c) => c.includes("internet (non-local)"));
    // DNS + DHCP (both LAN-hosted) must precede the LAN DROPs, which must
    // precede the final ACCEPT-all. First match wins in Proxmox.
    expect(dnsIdx).toBeGreaterThanOrEqual(0);
    expect(dhcpIdx).toBeGreaterThanOrEqual(0);
    expect(firstDropIdx).toBeGreaterThan(Math.max(dnsIdx, dhcpIdx));
    expect(internetIdx).toBeGreaterThan(firstDropIdx);
    expect(internetIdx).toBe(out.length - 1);
    const drops = out.filter((r) => r.action === "DROP").map((r) => r.dest).sort();
    expect(drops).toEqual([...PRIVATE_EGRESS_RANGES].sort());
    const acceptAll = out[internetIdx]!;
    expect(acceptAll.action).toBe("ACCEPT");
    expect(acceptAll.proto).toBeUndefined();
    expect(acceptAll.dest).toBeUndefined();
  });
  it("defaults to internet-on: bare options still get DHCP, LAN drops, and the final accept", () => {
    const rules = buildIsolationRules({});
    expect(rules).toHaveLength(8);
    expect(rules.filter((r) => r.type === "in" && r.dport === "68")).toHaveLength(1);
    expect(rules[rules.length - 1]).toMatchObject({ action: "ACCEPT", type: "out" });
  });
  it("allowInternet:false keeps the legacy DNS-only egress", () => {
    const rules = buildIsolationRules({ allowFrom: "192.168.1.22", allowDnsTo: "192.168.1.1", allowInternet: false });
    expect(rules).toHaveLength(5);
    expect(rules.some((r) => (r.comment ?? "").includes("no local network"))).toBe(false);
    expect(rules.some((r) => (r.comment ?? "").includes("internet"))).toBe(false);
    expect(buildIsolationRules({ allowInternet: false })).toEqual([]);
  });
  it("rejects malformed addresses and ports up front", () => {
    expect(() => buildIsolationRules({ allowFrom: "not-an-ip" })).toThrow(/IPv4/);
    expect(() => buildIsolationRules({ allowFrom: "192.168.1.999" })).toThrow(/octet/);
    expect(() => buildIsolationRules({ allowFrom: "192.168.1.0/33" })).toThrow(/CIDR/);
    expect(() => buildIsolationRules({ allowFrom: "10.0.0.1", inboundPorts: ["99999"] })).toThrow(/0–65535/);
    expect(() => buildIsolationRules({ allowFrom: "10.0.0.1", inboundPorts: ["80; rm"] })).toThrow(/ports like/);
    expect(buildIsolationRules({ allowFrom: "10.0.0.0/24", inboundPorts: ["80", "5900:5910"] })).toHaveLength(10);
  });
});

describe("hand-written rule validation", () => {
  it("accepts a well-formed rule and stamps it", () => {
    expect(
      assertFirewallRuleInput({ action: "ACCEPT", type: "in", proto: "tcp", dport: "8080", source: "10.0.0.5" }),
    ).toMatchObject({ action: "ACCEPT", type: "in", dport: "8080", comment: PROXVM_RULE_COMMENT });
  });
  it("rejects bad enums, ports, and addresses", () => {
    expect(() => assertFirewallRuleInput({ action: "ALLOW", type: "in" })).toThrow(/ACCEPT, DROP/);
    expect(() => assertFirewallRuleInput({ action: "ACCEPT", type: "sideways" })).toThrow(/in or out/);
    expect(() => assertFirewallRuleInput({ action: "ACCEPT", type: "in", proto: "gre" })).toThrow(/tcp, udp/);
    expect(() => assertFirewallRuleInput({ action: "ACCEPT", type: "in", dport: "0:99999" })).toThrow(/0–65535/);
    expect(() => assertFirewallRuleInput({ action: "ACCEPT", type: "in", source: "example.com" })).toThrow(/IPv4/);
    expect(() => assertFirewallRuleInput(null)).toThrow();
  });
});

describe("applyIsolation rule order", () => {
  it("writes explicit ascending positions so first-match-wins follows builder order", async () => {
    const created: Array<Record<string, unknown>> = [];
    const proxmox = {
      clusterFirewallOptions: async () => ({ enable: 1 }),
      setGuestFirewallOptions: async () => ({}),
      guestFirewallRules: async () => [],
      deleteGuestFirewallRule: async () => ({}),
      createGuestFirewallRule: async (_node: string, _vmid: number, rule: Record<string, unknown>) => {
        created.push(rule);
        return {};
      },
    };
    const db = { query: async () => ({ rows: [] }) };
    const { applyIsolation: apply } = await import("./index.js");
    const res = await apply(
      db as never,
      proxmox as never,
      "vm-id",
      "node",
      100,
      { allowFrom: "192.168.1.22", allowDnsTo: "192.168.1.1" },
    );
    expect(res.rulesCreated).toBe(created.length);
    // Every rule is created LAST-first with explicit pos 0, because Proxmox
    // prepends each insert (probed live). The finished chain therefore reads
    // in builder order. Guard both the reverse creation sequence and the pin.
    const built = buildIsolationRules({ allowFrom: "192.168.1.22", allowDnsTo: "192.168.1.1" });
    expect(created.map((r) => r.comment)).toEqual([...built].reverse().map((r) => r.comment));
    for (const r of created) expect(r.pos).toBe(0);
    const actions = created.map((r) => `${r.action}:${r.type}:${(r.dest as string) ?? (r.dport as string) ?? "any"}`);
    // Creation runs last-first, so the finished chain (top-down) is the
    // mirror image: first created is the final ACCEPT-all, last created is
    // the first inbound rule, and LAN DROPs sit between DNS/DHCP and the end.
    expect(actions[0]).toBe("ACCEPT:out:any");
    expect(actions[actions.length - 1]).toBe("ACCEPT:in:22");
    const lanDrops = actions.filter((a) => a.startsWith("DROP:out:10.") || a.startsWith("DROP:out:172.") || a.startsWith("DROP:out:192.") || a.startsWith("DROP:out:169.") || a.startsWith("DROP:out:127."));
    expect(lanDrops).toHaveLength(PRIVATE_EGRESS_RANGES.length);
  });
});

describe("proxvm rule identification", () => {
  it("matches only our comment prefix", () => {
    expect(isProxvmRule({ comment: "proxvm-isolation: remote access" })).toBe(true);
    expect(isProxvmRule({ comment: "hand-made rule" })).toBe(false);
    expect(isProxvmRule({})).toBe(false);
  });
});
