import { describe, expect, it } from "vitest";
import { ProxmoxBackupClient, ProxmoxBackupApiError } from "./index.js";

function mockFetch(handler: (url: string, init?: RequestInit) => unknown): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    const result = handler(String(url), init);
    return new Response(JSON.stringify(result), { status: 200 });
  }) as unknown as typeof fetch;
}

function clientWith(fetchImpl: typeof fetch): ProxmoxBackupClient {
  return new ProxmoxBackupClient({
    url: "https://192.0.2.10:8007",
    tokenId: "admin@pbs!test",
    tokenSecret: "secret",
    fetchImpl,
  });
}

describe("ProxmoxBackupClient baseline", () => {
  it("requires url and token", () => {
    expect(() => new ProxmoxBackupClient({ url: "", tokenId: "a", tokenSecret: "b" })).toThrow(/url is required/);
    expect(() => new ProxmoxBackupClient({ url: "https://x", tokenId: "", tokenSecret: "" })).toThrow(/token/);
  });

  it("authenticates with PBSAPIToken and reads version/datastores", async () => {
    const seen: Array<{ url: string; auth?: string }> = [];
    const client = clientWith(
      mockFetch((url, init) => {
        seen.push({ url, auth: (init?.headers as Record<string, string>)?.Authorization });
        if (url.endsWith("/version")) return { data: { version: "3.2.0" } };
        if (url.endsWith("/config/datastore")) {
          return { data: [{ name: "backup-pool", path: "/mnt/backups" }] };
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    await expect(client.version()).resolves.toMatchObject({ version: "3.2.0" });
    const stores = await client.listDatastores();
    expect(stores).toEqual([{ name: "backup-pool", path: "/mnt/backups" }]);
    expect(seen[0]!.auth).toMatch(/^PBSAPIToken=admin@pbs!test=secret$/);
    expect(seen[0]!.url).toContain("https://192.0.2.10:8007/api2/json/version");
  });

  it("lists backup groups with optional filters", async () => {
    const client = clientWith(
      mockFetch((url) => {
        if (url.includes("/groups?")) return { data: [{ "backup-id": "vm/100" }] };
        if (url.includes("/groups")) return { data: [] };
        throw new Error(`unexpected ${url}`);
      }),
    );
    await expect(client.listBackupGroups("backup-pool")).resolves.toEqual([]);
    const filtered = await client.listBackupGroups("backup-pool", { type: "vm", backupId: "vm/100" });
    expect(filtered).toHaveLength(1);
  });

  it("Backup execution is explicitly unwired (501, no live calls)", async () => {
    const client = clientWith(mockFetch(() => ({ data: {} })));
    await expect(client.startBackup({ datastore: "x", node: "n", vmid: 100 })).rejects.toMatchObject({
      name: "ProxmoxBackupApiError",
      statusCode: 501,
    });
  });

  it("wraps transport failures without leaking the token", async () => {
    const client = new ProxmoxBackupClient({
      url: "https://192.0.2.10:8007",
      tokenId: "admin@pbs!test",
      tokenSecret: "super-secret-token",
      fetchImpl: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const err = (await client.version().catch((e) => e)) as ProxmoxBackupApiError;
    expect(err).toBeInstanceOf(ProxmoxBackupApiError);
    expect(String(err.detail)).not.toContain("super-secret-token");
  });
});
