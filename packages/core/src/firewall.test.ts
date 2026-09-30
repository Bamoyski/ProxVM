import { describe, expect, it } from "vitest";
import {
  assertFirewallRuleInput,
  buildIsolationRules,
  isProxvmRule,
  PROXVM_RULE_COMMENT,
} from "./index.js";

describe("isolation rule builder", () => {
  it("opens remote-access ports from one source plus optional DNS, all stamped", () => {
    const rules = buildIsolationRules({ allowFrom: "192.168.1.22", allowDnsTo: "192.168.1.1" });
    expect(rules).toHaveLength(5);
    expect(rules[0]).toMatchObject({ action: "ACCEPT", type: "in", proto: "tcp", dport: "22", source: "192.168.1.22" });
    expect(rules[3]).toMatchObject({ action: "ACCEPT", type: "out", proto: "udp", dport: "53", dest: "192.168.1.1" });
    for (const r of rules) expect(r.comment ?? "").toContain(PROXVM_RULE_COMMENT);
  });
  it("defaults to an empty ruleset when nothing is allowed (pure deny)", () => {
    expect(buildIsolationRules({})).toEqual([]);
  });
  it("rejects malformed addresses and ports up front", () => {
    expect(() => buildIsolationRules({ allowFrom: "not-an-ip" })).toThrow(/IPv4/);
    expect(() => buildIsolationRules({ allowFrom: "192.168.1.999" })).toThrow(/octet/);
    expect(() => buildIsolationRules({ allowFrom: "192.168.1.0/33" })).toThrow(/CIDR/);
    expect(() => buildIsolationRules({ allowFrom: "10.0.0.1", inboundPorts: ["99999"] })).toThrow(/0–65535/);
    expect(() => buildIsolationRules({ allowFrom: "10.0.0.1", inboundPorts: ["80; rm"] })).toThrow(/ports like/);
    expect(buildIsolationRules({ allowFrom: "10.0.0.0/24", inboundPorts: ["80", "5900:5910"] })).toHaveLength(2);
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

describe("proxvm rule identification", () => {
  it("matches only our comment prefix", () => {
    expect(isProxvmRule({ comment: "proxvm-isolation: remote access" })).toBe(true);
    expect(isProxvmRule({ comment: "hand-made rule" })).toBe(false);
    expect(isProxvmRule({})).toBe(false);
  });
});
