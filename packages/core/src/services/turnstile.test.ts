// Self-serve config resolution + Turnstile verification. Pure unit tests:
// settings are stubbed, fetch is stubbed globally — no network, no DB.
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSelfServeConfig, verifyTurnstileToken } from "../services/turnstile.js";
import type { SettingsService } from "../services/settings.js";

function stubSettings(values: Record<string, string | null>): SettingsService {
  return {
    get: async (key: string) => (values[key] ? { value: values[key]!, encrypted: false } : null),
    getPlain: async (key: string) => values[key] ?? null,
  } as unknown as SettingsService;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PROXVM_TURNSTILE_SITE_KEY;
  delete process.env.PROXVM_TURNSTILE_SECRET;
});

describe("getSelfServeConfig", () => {
  it("falls back to approval on absent or garbage mode values", async () => {
    expect((await getSelfServeConfig(stubSettings({}))).mode).toBe("approval");
    expect((await getSelfServeConfig(stubSettings({ "selfserve.mode": "turbo" }))).mode).toBe("approval");
  });

  it("honors closed and approval verbatim", async () => {
    expect((await getSelfServeConfig(stubSettings({ "selfserve.mode": "closed" }))).mode).toBe("closed");
    expect((await getSelfServeConfig(stubSettings({ "selfserve.mode": "approval" }))).mode).toBe("approval");
  });

  it("auto without a Turnstile secret degrades to approval (stored mode kept)", async () => {
    const cfg = await getSelfServeConfig(stubSettings({ "selfserve.mode": "auto" }));
    expect(cfg.storedMode).toBe("auto");
    expect(cfg.mode).toBe("approval");
  });

  it("auto WITH a secret stays auto and exposes keys (env wins over db)", async () => {
    process.env.PROXVM_TURNSTILE_SITE_KEY = "env-site";
    process.env.PROXVM_TURNSTILE_SECRET = "env-secret";
    const cfg = await getSelfServeConfig(
      stubSettings({ "selfserve.mode": "auto", "selfserve.turnstile_site_key": "db-site", "selfserve.turnstile_secret": "db-secret" }),
    );
    expect(cfg.mode).toBe("auto");
    expect(cfg.turnstileSiteKey).toBe("env-site");
    expect(cfg.turnstileSecret).toBe("env-secret");
  });
});

describe("verifyTurnstileToken", () => {
  it("accepts only an explicit success:true from siteverify", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })),
    );
    expect(await verifyTurnstileToken("s", "tok")).toBe(true);
  });

  it("rejects success:false, non-200s, and network failures (fail closed)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), { status: 200 })));
    expect(await verifyTurnstileToken("s", "tok")).toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    expect(await verifyTurnstileToken("s", "tok")).toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await verifyTurnstileToken("s", "tok")).toBe(false);
  });

  it("sends secret, response token, and remoteip as the form body; never the secret anywhere else", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await verifyTurnstileToken("the-secret", "the-token", "203.0.113.9");
    const args = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(args[0]).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const body = (args[1].body as URLSearchParams).toString();
    expect(body).toContain("secret=the-secret");
    expect(body).toContain("response=the-token");
    expect(body).toContain("remoteip=203.0.113.9");
  });
});
