import { describe, expect, it } from "vitest";
import { assertSafeServerUrl, fetchWithSsrfGuard, isBlockedServerDestination } from "./util/ssrf.js";

describe("server-destination SSRF guard", () => {
  it("blocks loopback in every representation", () => {
    for (const host of [
      "127.0.0.1",
      "127.1",
      "2130706433", // decimal dword for 127.0.0.1
      "0x7f.0.0.1", // hex quad
      "0177.0.0.1", // octal quad
      "localhost",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "0.0.0.0",
    ]) {
      expect(isBlockedServerDestination(host), host).toBe(true);
    }
  });

  it("blocks link-local and cloud metadata", () => {
    for (const host of [
      "169.254.169.254",
      "fe80::1",
      "metadata.google.internal",
      "x.metadata.google.internal",
      "2852039166", // decimal dword for 169.254.169.254
    ]) {
      expect(isBlockedServerDestination(host), host).toBe(true);
    }
  });

  it("blocks encoded-quad DNS suffixes pointing at blocked space", () => {
    expect(isBlockedServerDestination("127.0.0.1.nip.io")).toBe(true);
    expect(isBlockedServerDestination("169.254.169.254.sslip.io")).toBe(true);
  });

  it("permits LAN and public names (operator trust, homelab design)", () => {
    for (const host of ["192.168.1.10", "10.0.0.5", "172.16.4.2", "proxmox.lan", "93.184.216.34", "2001:db8::1"]) {
      expect(isBlockedServerDestination(host), host).toBe(false);
    }
  });

  it("assertSafeServerUrl rejects blocked URLs and non-http schemes", async () => {
    await expect(assertSafeServerUrl("http://127.0.0.1:8006/api2/json", "Proxmox URL")).rejects.toThrow();
    await expect(assertSafeServerUrl("http://localhost:8006/", "Proxmox URL")).rejects.toThrow();
    await expect(assertSafeServerUrl("http://169.254.169.254/latest/", "Proxmox URL")).rejects.toThrow();
    await expect(assertSafeServerUrl("http://[::1]:8006/", "Proxmox URL")).rejects.toThrow();
    await expect(assertSafeServerUrl("ftp://example.com/x", "Proxmox URL")).rejects.toThrow();
    await expect(assertSafeServerUrl("not a url", "Proxmox URL")).rejects.toThrow();
  });

  it("assertSafeServerUrl allows LAN URLs (legitimate homelab targets)", async () => {
    // Literal IPs skip DNS entirely; hostnames that need real DNS are not
    // exercised here (no network in unit tests).
    await expect(assertSafeServerUrl("https://192.168.1.10:8006/api2/json", "Proxmox URL")).resolves.toBe(
      "https://192.168.1.10:8006/api2/json",
    );
  });

  it("fetchWithSsrfGuard refuses redirects into blocked space", async () => {
    const ok = new Response("ok", {
      status: 200,
      headers: {},
    });
    void ok;
    // Redirect target is checked before fetching: a hop to loopback never fires.
    let fetched: string[] = [];
    const realFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (url: unknown) => {
      fetched.push(String(url));
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/x" } });
    };
    try {
      await expect(fetchWithSsrfGuard("https://192.168.1.10/start", {}, 1)).rejects.toThrow();
      expect(fetched).toEqual(["https://192.168.1.10/start"]);
    } finally {
      (globalThis as { fetch: unknown }).fetch = realFetch;
    }
  });
});
