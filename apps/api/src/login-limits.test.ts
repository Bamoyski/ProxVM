import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import { createCore, makeLogger, type CoreContext, type LocalConfig } from "@proxvm/core";
import { buildApp } from "../src/app.js";
import RedisMockCtor from "ioredis-mock";

const localConfig: LocalConfig = {
  version: 1,
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
    masterKey: "b".repeat(64),
  },
};

describe("login hard limits", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    const ctx: CoreContext = await createCore(localConfig, {
      db: pool,
      redis: new RedisMockCtor() as never,
      logger: makeLogger("test"),
    });
    app = await buildApp({ setupMode: false, ctx });
  });

  afterAll(async () => {
    await app.close();
  });

  it("bursts against one username end in 429, not unlimited 401s", async () => {
    // Unknown user: no lockout accounting to interfere, and the generous
    // per-IP sponge (100/min) stays out of the way — the 11th rapid attempt
    // must trip the per-username throttle instead.
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "nosuchuser099", password: "wrong-wrong-wrong" },
      });
      last = res.statusCode;
      expect([401, 429]).toContain(res.statusCode);
    }
    expect(last).toBe(429);
  });
});
