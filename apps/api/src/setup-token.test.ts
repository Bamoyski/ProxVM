import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import { initSetupToken, resetSetupToken } from "../src/routes/setup.js";

describe("setup one-time token", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token = "";

  beforeAll(async () => {
    resetSetupToken();
    token = initSetupToken();
    app = await buildApp({ setupMode: true });
  });

  afterAll(async () => {
    await app.close();
    resetSetupToken();
  });

  it("status stays public, test endpoints require the token", async () => {
    expect((await app.inject({ method: "GET", url: "/api/setup/status" })).statusCode).toBe(200);

    const noToken = await app.inject({
      method: "POST",
      url: "/api/setup/test-database",
      payload: { host: "127.0.0.1", port: 1, user: "u", password: "p", name: "d", ssl: false },
    });
    expect(noToken.statusCode).toBe(401);

    const wrongToken = await app.inject({
      method: "POST",
      url: "/api/setup/test-database",
      headers: { "x-setup-token": "wrong" },
      payload: { host: "127.0.0.1", port: 1, user: "u", password: "p", name: "d", ssl: false },
    });
    expect(wrongToken.statusCode).toBe(401);
  });

  it("valid token passes the guard (reaches the connection check)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/test-database",
      headers: { "x-setup-token": token },
      // Nothing listens here: fast refusal proves the guard passed (no 401).
      payload: { host: "127.0.0.1", port: 1, user: "u", password: "p", name: "d", ssl: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as object).toMatchObject({ ok: false, host: "127.0.0.1" });
  });

  it("complete requires the token and releases cleanly on validation failure", async () => {
    const noToken = await app.inject({ method: "POST", url: "/api/setup/complete", payload: {} });
    expect(noToken.statusCode).toBe(401);

    // Invalid body: validation error, NOT stuck-in-progress — a retry with a
    // fixed body must still reach validation, never 409.
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/complete",
        headers: { "x-setup-token": token },
        payload: {},
      });
      expect([400, 422]).toContain(res.statusCode);
    }
  });
});
