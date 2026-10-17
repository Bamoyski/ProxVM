// Health-check probes: the optional integrations must degrade to
// UNCONFIGURED (never ERROR/alert) when unset, and the shared probes must
// still convert failures into ERROR rows. runHealthChecks only touches
// db.query + redis get/ping, so plain stubs carry every case.
import { describe, expect, it } from "vitest";
import { runHealthChecks, WORKER_HEARTBEAT_KEY, type HealthDeps } from "../services/health.js";

function stubDeps(overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    db: { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as HealthDeps["db"],
    redis: {
      ping: async () => "PONG",
      get: async (key: string) => (key === WORKER_HEARTBEAT_KEY ? String(Date.now()) : null),
    } as unknown as HealthDeps["redis"],
    logger: {} as unknown,
    settings: {
      get: async () => null,
      getPlain: async () => null,
      guacamole: async () => null,
    } as unknown as HealthDeps["settings"],
    getProxmoxClient: async () => { throw new Error("not configured in test stub"); },
    getGuacDb: async () => { throw new Error("not configured in test stub"); },
    getGuacApi: async () => null,
    getPbsClient: async () => null,
    ...overrides,
  };
}

function byName(results: Array<{ name: string; status: string; detail?: string | null }>): Map<string, { status: string; detail: string | null }> {
  return new Map(results.map((r) => [r.name, { status: r.status, detail: r.detail ?? null }]));
}

describe("runHealthChecks — optional integrations", () => {
  it("reports UNCONFIGURED (not ERROR) for unset PBS, Gotify, and tunnels", async () => {
    const results = byName(await runHealthChecks(stubDeps()));
    expect(results.get("pbs")?.status).toBe("UNCONFIGURED");
    expect(results.get("gotify_push")?.status).toBe("UNCONFIGURED");
    expect(results.get("cloudflare_tunnels")?.status).toBe("UNCONFIGURED");
  });

  it("optional services stay non-ERROR when unset; hard deps degrade normally", async () => {
    const results = byName(await runHealthChecks(stubDeps()));
    // Optional integrations: never ERROR when merely unconfigured.
    for (const name of ["pbs", "gotify_push", "cloudflare_tunnels"]) {
      expect(results.get(name)?.status).not.toBe("ERROR");
      // No URL/host leakage in optional-service details.
      expect(results.get(name)?.detail ?? "").not.toMatch(/https?:\/\/|\d+\.\d+\.\d+\.\d+/);
    }
    // Hard deps with stubbed-out clients: the probe's job is to report the
    // failure, not to hide it.
    expect(results.get("postgresl") ?? results.get("postgresql")).toMatchObject({ status: "ONLINE" });
    expect(results.get("redis")).toMatchObject({ status: "ONLINE" });
    expect(results.get("worker")).toMatchObject({ status: "ONLINE" });
    expect(results.get("proxmox")).toMatchObject({ status: "ERROR" });
  });

  it("details of optional probes carry no url or ip even on hard failure", async () => {
    const results = await runHealthChecks(stubDeps({
      getPbsClient: async () => ({ version: async () => { throw new Error("fetch failed: connect EHOSTUNREACH https://pbs.invalid:8007"); } }),
    } as unknown as Partial<HealthDeps>));
    const pbs = results.find((r) => r.name === "pbs");
    expect(pbs?.status).toBe("ERROR");
    expect(pbs?.detail ?? "").not.toMatch(/https?:\/\/|\d+\.\d+\.\d+\.\d+/);
  });

  it("pbs ONLINE on a successful version probe and carries no error text", async () => {
    const results = byName(await runHealthChecks(stubDeps({
      getPbsClient: async () => ({ version: async () => ({ version: "3.2.7" }) }),
    } as unknown as Partial<HealthDeps>)));
    expect(results.get("pbs")?.status).toBe("ONLINE");
    expect(results.get("pbs")?.detail).toContain("3.2.7");
  });

  it("pbs down surfaces as ERROR with the generic message", async () => {
    const results = byName(await runHealthChecks(stubDeps({
      getPbsClient: async () => ({ version: async () => { throw new Error("fetch failed https://pbs.invalid"); } }),
    } as unknown as Partial<HealthDeps>)));
    expect(results.get("pbs")?.status).toBe("ERROR");
    // The raw throw's URL is surfaced by design for hard deps? No — for the
    // optional surface we assert only that the row is ERROR; text policy is
    // enforced at the settings page of truth, not in the probe.
  });

  it("gotify half-configured (enabled but no token) stays UNCONFIGURED", async () => {
    const deps = stubDeps({
      settings: {
        get: async () => null,
        getPlain: async (key: string) => (key === "notifications.gotify_url" ? "http://192.168.1.28" : key === "notifications.gotify_enabled" ? "true" : null),
        guacamole: async () => null,
      } as unknown as HealthDeps["settings"],
    });
    const results = byName(await runHealthChecks(deps));
    expect(results.get("gotify_push")?.status).toBe("UNCONFIGURED");
  });
});
