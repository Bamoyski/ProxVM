import { describe, expect, it } from "vitest";
import { ProxmoxApiError, ProxmoxClient } from "./proxmox/client.js";

function clientWith(fetchImpl: typeof fetch): ProxmoxClient {
  return new ProxmoxClient({
    url: "https://192.0.2.1:8006",
    tokenId: "root@pve!test",
    tokenSecret: "secret",
    verifySsl: false,
    fetchImpl,
  });
}

describe("ProxmoxClient error reporting", () => {
  it("surfaces upstream pseudo-status 595 (offline node) with structured detail instead of opaque failure", async () => {
    const client = clientWith((async () => new Response("", { status: 595 })) as unknown as typeof fetch);
    let caught: ProxmoxApiError | null = null;
    try {
      await client.storages("pve-node-01");
    } catch (err) {
      caught = err as ProxmoxApiError;
    }
    expect(caught).toBeInstanceOf(ProxmoxApiError);
    expect(caught?.statusCode).toBe(595);
    expect(caught?.message).toMatch(/non-JSON response \(HTTP 595\)/);
    expect(caught?.detail?.upstreamStatus).toBe(595);
    expect(caught?.detail?.path).toContain("/nodes/pve-node-01/storage");
  });

  it("wraps transport failures (connect/TLS/timeout) with hostname, port and cause", async () => {
    const client = clientWith((async () => {
      throw new Error("connect ECONNREFUSED 192.0.2.1:8006");
    }) as unknown as typeof fetch);
    let caught: ProxmoxApiError | null = null;
    try {
      await client.version();
    } catch (err) {
      caught = err as ProxmoxApiError;
    }
    expect(caught).toBeInstanceOf(ProxmoxApiError);
    expect(caught?.statusCode).toBe(0);
    // User-facing message must not disclose the configured host/URL;
    // structured detail keeps it for logs and privileged responses.
    expect(caught?.message ?? "").not.toMatch(/192\.0\.2\.1|https?:\/\//);
    expect(caught?.message).toMatch(/Cannot reach the Proxmox API/);
    expect(caught?.detail?.hostname).toBe("192.0.2.1");
    expect(caught?.detail?.port).toBe("8006");
    expect(String(caught?.detail?.cause)).toMatch(/ECONNREFUSED/);
  });

  it("includes the upstream PVE error message for runtime 500s (e.g. bad clone params)", async () => {
    const client = clientWith((async () =>
      new Response(JSON.stringify({ data: null, message: "parameter 'storage' not allowed for linked clones\n" }), {
        status: 500,
      })) as unknown as typeof fetch);
    let caught: ProxmoxApiError | null = null;
    try {
      await client.clone({ node: "pve-node-01", templateVmid: 126, newVmid: 201, name: "Test", storage: "local-lvm", full: false, target: "pve-node-01" });
    } catch (err) {
      caught = err as ProxmoxApiError;
    }
    expect(caught).toBeInstanceOf(ProxmoxApiError);
    expect(caught?.statusCode).toBe(500);
    expect(caught?.message).toMatch(/Proxmox API HTTP 500: parameter 'storage' not allowed for linked clones/);
    expect(caught?.detail?.path).toContain("/qemu/126/clone");
  });

  it("returns parsed data for valid JSON responses", async () => {
    const client = clientWith((async () =>
      new Response(JSON.stringify({ data: { storage: "local-lvm" } }), { status: 200 })) as unknown as typeof fetch);
    const result = await client.storages("pve-node-02");
    expect(result).toEqual({ storage: "local-lvm" });
  });
});
