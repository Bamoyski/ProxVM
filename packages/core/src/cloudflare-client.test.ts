import { describe, expect, it } from "vitest";
import { CloudflareClient, CloudflareApiError } from "./index.js";

function mockFetch(handler: (url: string, init?: RequestInit) => unknown): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    const result = handler(String(url), init);
    return new Response(JSON.stringify(result), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("CloudflareClient", () => {
  it("verifies tokens and lists zones/records", async () => {
    const seen: string[] = [];
    const client = new CloudflareClient({
      token: "test-token",
      fetchImpl: mockFetch((url) => {
        seen.push(url);
        if (url.endsWith("/user/tokens/verify")) return { success: true, result: { id: "abc", status: "active" } };
        if (url.includes("/zones/zone1/dns_records")) {
          return { success: true, result: [{ id: "r1", type: "A", name: "app.example.com", content: "1.2.3.4", proxied: true, ttl: 1 }] };
        }
        if (url.endsWith("/zones/zone1")) return { success: true, result: { id: "zone1", name: "example.com", status: "active" } };
        throw new Error(`unexpected ${url}`);
      }),
    });
    await expect(client.verifyToken()).resolves.toMatchObject({ status: "active" });
    await expect(client.getZone("zone1")).resolves.toMatchObject({ name: "example.com" });
    const records = await client.listDnsRecords("zone1");
    expect(records).toHaveLength(1);
    expect(records[0]!.name).toBe("app.example.com");
    expect(seen[0]).toContain("https://api.cloudflare.com/client/v4/");
  });

  it("creates then patches records", async () => {
    const calls: Array<{ method?: string; body?: unknown }> = [];
    const client = new CloudflareClient({
      token: "test-token",
      fetchImpl: mockFetch((url, init) => {
        calls.push({ method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith("/dns_records") && init?.method === "POST") {
          return { success: true, result: { id: "new", type: "A", name: "x.example.com", content: "1.2.3.4", proxied: true, ttl: 1 } };
        }
        return { success: true, result: { id: "new", type: "A", name: "x.example.com", content: "5.6.7.8", proxied: true, ttl: 1 } };
      }),
    });
    await client.createDnsRecord("zone1", { type: "A", name: "x.example.com", content: "1.2.3.4" });
    expect(calls[0]!.body).toMatchObject({ type: "A", proxied: true });
    await client.updateDnsRecord("zone1", "new", { content: "5.6.7.8" });
    expect(calls[1]!.method).toBe("PATCH");
  });

  it("surfaces API errors without leaking the token", async () => {
    const client = new CloudflareClient({
      token: "super-secret-token",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ success: false, errors: [{ message: "Invalid token" }] }), { status: 401 })) as unknown as typeof fetch,
    });
    const err: unknown = await client.verifyToken().catch((e) => e);
    expect(err).toBeInstanceOf(CloudflareApiError);
    if (!(err instanceof CloudflareApiError)) throw new Error("expected CloudflareApiError");
    expect(err.statusCode).toBe(401);
    expect(String(err.message)).not.toContain("super-secret-token");
  });

  it("requires a token", () => {
    expect(() => new CloudflareClient({ token: "" })).toThrow(/token is required/);
  });
});
