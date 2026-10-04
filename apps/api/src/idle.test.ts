import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import {
  createCore,
  makeLogger,
  hashPassword,
  type CoreContext,
  type LocalConfig,
} from "@proxvm/core";
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
    masterKey: "e".repeat(64),
  },
};

interface Session {
  cookie: string;
  csrf: string;
}

async function login(
  app: Awaited<ReturnType<typeof buildApp>>,
  username: string,
  password: string,
): Promise<Session> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === "proxvm_session");
  return {
    cookie: `${cookie?.name}=${cookie?.value}`,
    csrf: (res.json() as { csrfToken: string }).csrfToken,
  };
}

describe("VM class toggle", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: Session;
  let user: Session;
  let vmId: string;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    const ctx: CoreContext = await createCore(localConfig, {
      db: pool,
      redis: new RedisMockCtor() as never,
      logger: makeLogger("test"),
    });
    await ctx.users.create({
      username: "admin",
      passwordHash: await hashPassword("Admin-Password-1!"),
      roles: ["ADMIN"],
    });
    await ctx.users.create({
      username: "bob",
      passwordHash: await hashPassword("Bob-Password-1!"),
      roles: ["USER"],
    });
    vmId = (await ctx.vms.create({ vmid: 300, node: "node1", name: "idle-me" })).id;
    app = await buildApp({ setupMode: false, ctx });
    admin = await login(app, "admin", "Admin-Password-1!");
    user = await login(app, "bob", "Bob-Password-1!");
  });

  afterAll(async () => {
    await app.close();
  });

  const authA = () => ({ cookie: admin.cookie, "x-csrf-token": admin.csrf });
  const authU = () => ({ cookie: user.cookie, "x-csrf-token": user.csrf });

  it("defaults to server, toggles with vm.edit, rejects others", async () => {
    const denied = await app.inject({
      method: "PATCH",
      url: `/api/vms/${vmId}/class`,
      headers: authU(),
      payload: { vmClass: "user" },
    });
    expect(denied.statusCode).toBe(403);
    const bad = await app.inject({
      method: "PATCH",
      url: `/api/vms/${vmId}/class`,
      headers: authA(),
      payload: { vmClass: "hypervisor" },
    });
    expect(bad.statusCode).toBe(400);
    const set = await app.inject({
      method: "PATCH",
      url: `/api/vms/${vmId}/class`,
      headers: authA(),
      payload: { vmClass: "user" },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ ok: true, vmClass: "user" });
    const detail = await app.inject({ method: "GET", url: `/api/vms/${vmId}`, headers: authA() });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { vm: { vmClass: string } }).vm.vmClass).toBe("user");
  });
});
