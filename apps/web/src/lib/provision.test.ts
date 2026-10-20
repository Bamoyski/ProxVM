import { describe, it, expect } from "vitest";
import { buildBasicPayload, buildAdvancedPayload, type BasicProvisionForm, type AdvancedProvisionForm } from "./provision.js";

/**
 * Payload parity with the legacy wizard. These shapes are the wire contract
 * with POST /vms/provision — the API layer must not drift. Values that are
 * blank/empty become `undefined`, which JSON.stringify omits entirely; that
 * omission is load-bearing (the server treats absent keys as "use defaults").
 */

const basicForm: BasicProvisionForm = {
  name: "web-01",
  templateId: "tpl-1",
  cpu: 2,
  ramMb: 2048,
  diskGb: 20,
  bridge: "vmbr0",
  protocols: ["ssh", "rdp"],
};

const advancedForm: AdvancedProvisionForm = {
  name: "db-01",
  templateId: "tpl-2",
  node: "pve1",
  vmid: "500",
  cpu: 4,
  ramMb: 8192,
  diskGb: 100,
  storage: "local-lvm",
  bridge: "vmbr1",
  vlan: "10",
  mode: "static",
  ip: "192.168.1.50",
  cidr: "24",
  gateway: "192.168.1.1",
  dns: "192.168.1.1, 1.1.1.1",
  guestUser: "deploy",
  linkedClone: true,
  protocols: ["ssh"],
};

/** The exact JSON the API layer sends — undefined keys dropped, as fetch does. */
function sent(body: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(body));
}

describe("buildBasicPayload", () => {
  it("sends only chosen values; network defaults to dhcp", () => {
    expect(sent(buildBasicPayload(basicForm))).toEqual({
      name: "web-01",
      templateId: "tpl-1",
      cpu: 2,
      ramMb: 2048,
      diskGb: 20,
      network: { bridge: "vmbr0", mode: "dhcp" },
      protocols: ["ssh", "rdp"],
      assignToUserIds: undefined,
    });
  });

  it("omits protocols entirely when none chosen (server default)", () => {
    const out = sent(buildBasicPayload({ ...basicForm, protocols: [] }));
    expect("protocols" in out).toBe(false);
  });

  it("omits bridge from network when blank", () => {
    const out = sent(buildBasicPayload({ ...basicForm, bridge: "" }));
    expect(out.network).toEqual({ mode: "dhcp" });
  });

  it("includes password only when provided", () => {
    expect("password" in sent(buildBasicPayload(basicForm))).toBe(false);
    const withPw = sent(buildBasicPayload(basicForm, { password: "Sup3r-Secret!" }));
    expect(withPw.password).toBe("Sup3r-Secret!");
  });

  it("never sends node/storage/vmid/guestUser — server resolves them", () => {
    const out = sent(buildBasicPayload(basicForm));
    for (const k of ["node", "storage", "vmid", "guestUser", "osType", "linkedClone"]) {
      expect(k in out, k).toBe(false);
    }
  });

  it("forwards assignToUserIds when the operator picked users", () => {
    const out = sent(buildBasicPayload(basicForm, { assignToUserIds: ["u1", "u2"] }));
    expect(out.assignToUserIds).toEqual(["u1", "u2"]);
  });
});

describe("buildAdvancedPayload", () => {
  it("forwards every typed field, numbers coerced", () => {
    expect(sent(buildAdvancedPayload(advancedForm))).toEqual({
      name: "db-01",
      templateId: "tpl-2",
      node: "pve1",
      vmid: 500,
      cpu: 4,
      ramMb: 8192,
      diskGb: 100,
      storage: "local-lvm",
      network: {
        bridge: "vmbr1",
        vlan: 10,
        mode: "static",
        ip: "192.168.1.50",
        cidr: 24,
        gateway: "192.168.1.1",
        dns: ["192.168.1.1", "1.1.1.1"],
      },
      protocols: ["ssh"],
      guestUser: "deploy",
      linkedClone: true,
      osType: undefined,
      password: undefined,
      assignToUserIds: undefined,
    });
  });

  it("static mode sends ip/cidr/gateway; dhcp omits them", () => {
    const dhcp = sent(buildAdvancedPayload({ ...advancedForm, mode: "dhcp" }));
    const net = dhcp.network as Record<string, unknown>;
    expect("ip" in net).toBe(false);
    expect("cidr" in net).toBe(false);
    expect("gateway" in net).toBe(false);
  });

  it("falls back to the template node when the field is blank", () => {
    const out = sent(buildAdvancedPayload({ ...advancedForm, node: "" }, { templateNode: "pve2" }));
    expect(out.node).toBe("pve2");
  });

  it("omits vmid when blank (server allocates the next free id)", () => {
    const out = sent(buildAdvancedPayload({ ...advancedForm, vmid: "" }));
    expect("vmid" in out).toBe(false);
  });

  it("omits vlan when blank but keeps the bridge", () => {
    const out = sent(buildAdvancedPayload({ ...advancedForm, vlan: "" }));
    expect(out.network).toMatchObject({ bridge: "vmbr1", mode: "static", ip: "192.168.1.50" });
    expect("vlan" in (out.network as Record<string, unknown>)).toBe(false);
  });

  it("splits dns on commas and whitespace, dropping blanks", () => {
    const out = sent(buildAdvancedPayload({ ...advancedForm, dns: " 1.1.1.1 , ,8.8.8.8\n9.9.9.9 " }));
    expect((out.network as Record<string, unknown>).dns).toEqual(["1.1.1.1", "8.8.8.8", "9.9.9.9"]);
  });

  it("omits dns entirely when blank", () => {
    const out = sent(buildAdvancedPayload({ ...advancedForm, dns: "" }));
    expect("dns" in (out.network as Record<string, unknown>)).toBe(false);
  });

  it("omits protocols when empty", () => {
    const out = sent(buildAdvancedPayload({ ...advancedForm, protocols: [] }));
    expect("protocols" in out).toBe(false);
  });

  it("passes template osType through when provided", () => {
    const out = sent(buildAdvancedPayload(advancedForm, { templateOsType: "linux" }));
    expect(out.osType).toBe("linux");
  });

  it("splits dns and coerces vmid/vlan/cidr to numbers, not strings", () => {
    const out = sent(buildAdvancedPayload(advancedForm));
    expect(typeof out.vmid).toBe("number");
    const net = out.network as Record<string, unknown>;
    expect(typeof net.vlan).toBe("number");
    expect(typeof net.cidr).toBe("number");
  });
});
