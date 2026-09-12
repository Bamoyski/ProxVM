import { describe, expect, it } from "vitest";

const hasConfig = !!process.env.PROXVM_INTEGRATION;

describe.skipIf(!hasConfig)("Proxmox integration (REAL)", () => {
  it("connects to the real Proxmox API and lists nodes", async () => {
    const { ProxmoxClient } = await import("@proxvm/core");
    const client = new ProxmoxClient({
      url: process.env.PROXMOX_URL!,
      tokenId: process.env.PROXMOX_TOKEN_ID!,
      tokenSecret: process.env.PROXMOX_TOKEN_SECRET!,
      verifySsl: process.env.PROXMOX_VERIFY_SSL === "true",
    });
    const version = await client.version();
    expect(version.version).toBeTruthy();
    const nodes = await client.nodes();
    expect(Array.isArray(nodes)).toBe(true);
    const templates = await client.templates();
    expect(Array.isArray(templates)).toBe(true);
  });
});
