import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMockCtor from "ioredis-mock";
import { buildApp } from "../src/app.js";
import { createCore, hashPassword, makeLogger, ProxmoxApiError, type CoreContext } from "@proxvm/core";

const masterKey = "a".repeat(64);

const localConfig = {
  version: 1 as const,
  app: {
    cookieSecure: false,
    sessionDurationHours: 12,
    sessionIdleTimeoutMinutes: 120,
    allowRegistrationOpen: false,
  },
  database: { host: "localhost", port: 5432, name: "proxvm", user: "u", password: "p", ssl: false },
  redis: { host: "127.0.0.1", port: 6379, db: 0 },
  secrets: {
    sessionSigningKey: "s".repeat(64),
    masterKeyId: "v1",
    masterKey,
  },
};

describe("proxmox routes report upstream errors", () => {
  let ctx: CoreContext;
  let cleanup: () => Promise<void>;
  let cookieHeader: string;
  let csrfToken: string;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    const logger = makeLogger("test");
    ctx = await createCore(localConfig, { db: pool, redis: new RedisMockCtor() as never, logger });
    cleanup = async () => {
      await pool.end().catch(() => undefined);
    };
    await ctx.users.create({
      username: "pveadmin",
      passwordHash: await hashPassword("Admin-Password-1!"),
      roles: ["ADMIN"],
    });
    const app = await buildApp({ setupMode: false, ctx });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "pveadmin", password: "Admin-Password-1!" },
    });
    const body = login.json();
    csrfToken = body.csrfToken;
    const setCookie = login.cookies.find((c) => c.name === "proxvm_session");
    cookieHeader = `${setCookie?.name}=${setCookie?.value}`;
    await app.close();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("returns 502 PROXMOX_ERROR with upstream detail when the node is offline (HTTP 595)", async () => {
    const failingCtx = {
      ...ctx,
      getProxmoxClient: async () => {
        throw new ProxmoxApiError(
          "Proxmox API returned a non-JSON response (HTTP 595): (empty body)",
          595,
          null,
          { upstreamStatus: 595, baseUrl: "https://192.0.2.1:8006", path: "/nodes/pve-node-01/storage", method: "GET" },
        );
      },
    } as CoreContext;
    const app = await buildApp({ setupMode: false, ctx: failingCtx });
    const res = await app.inject({
      method: "GET",
        url: "/api/proxmox/storage?node=pve-node-01",
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe("PROXMOX_ERROR");
    expect(res.json().message).toMatch(/HTTP 595/);
    expect(res.json().detail.upstreamStatus).toBe(595);
    await app.close();
  });

  it("does not swallow validation errors for missing node parameter", async () => {
    const app = await buildApp({ setupMode: false, ctx });
    const res = await app.inject({
      method: "GET",
      url: "/api/proxmox/storage",
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects node values that could escape the upstream API path", async () => {
    const app = await buildApp({ setupMode: false, ctx });
    for (const node of ["foo/../cluster", "..%2F..%2Fcluster", "node;rm"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/proxmox/storage?node=${node}`,
        headers: { cookie: cookieHeader },
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });
});
