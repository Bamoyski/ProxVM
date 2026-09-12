import { describe, expect, it, beforeAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import { runMigrations, makeLogger, hashPassword, createCore, type CoreContext, type LocalConfig } from "@proxvm/core";
import { buildApp } from "../src/app.js";
import RedisMockCtor from "ioredis-mock";

const masterKey = "c".repeat(64);

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
    masterKey,
  },
};

describe("vms list serialization (os/ip regression)", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sid: string;
  let csrf: string;
  let vmId: string;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, {
      db: pool,
      redis: new RedisMockCtor() as never,
      logger: makeLogger("test"),
    });
    await ctx.users.create({
      username: "admin",
      passwordHash: await hashPassword("Admin-Password-1!"),
      roles: ["ADMIN"],
    });
    const vm = await ctx.vms.create({
      vmid: 128,
      node: "pve-node-01",
      name: "debian-e2e-01",
      status: "running",
      osType: "linux",
      ipAddress: "192.168.1.79",
    });
    vmId = vm.id;
    await ctx.vms.updateOsInfo(vm.id, "Debian GNU/Linux 13 (trixie)");
    app = await buildApp({ setupMode: false, ctx });

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "Admin-Password-1!" },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === "proxvm_session");
    sid = `${cookie?.name}=${cookie?.value}`;
    csrf = (login.json() as { csrfToken: string }).csrfToken;
  });

  it("list endpoint returns persisted os_name and ip for tracked VMs", async () => {
    const res = await app.inject({ method: "GET", url: "/api/vms", headers: { cookie: sid } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { vms: Array<Record<string, unknown>> };
    const row = body.vms.find((v) => v.id === vmId);
    expect(row).toBeTruthy();
    expect(row?.os).toBe("Debian GNU/Linux 13 (trixie)");
    expect(row?.osName).toBe("Debian GNU/Linux 13 (trixie)");
    expect(row?.ip).toBe("192.168.1.79");
  });

  it("list endpoint falls back to friendly os type when os_name is null", async () => {
    await ctx.db.query("UPDATE vms SET os_name = NULL WHERE id = $1", [vmId]);
    const res = await app.inject({ method: "GET", url: "/api/vms", headers: { cookie: sid } });
    const body = JSON.parse(res.body) as { vms: Array<Record<string, unknown>> };
    const row = body.vms.find((v) => v.id === vmId);
    expect(row?.os).toBe("Linux");
    await ctx.db.query("UPDATE vms SET os_name = 'Debian GNU/Linux 13 (trixie)' WHERE id = $1", [vmId]);
  });

  it("detail endpoint returns the same os/ip as the list endpoint", async () => {
    const list = await app.inject({ method: "GET", url: "/api/vms", headers: { cookie: sid } });
    const listRow = (JSON.parse(list.body) as { vms: Array<Record<string, unknown>> }).vms.find((v) => v.id === vmId);
    const detail = await app.inject({ method: "GET", url: `/api/vms/${vmId}`, headers: { cookie: sid } });
    expect(detail.statusCode).toBe(200);
    const vm = (JSON.parse(detail.body) as { vm: Record<string, unknown> }).vm;
    expect(vm.os).toBe(listRow?.os);
    expect(vm.ip).toBe(listRow?.ip);
  });

  it("guacamole launch without configured guacamole returns 400, not 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/guacamole/launch`,
      headers: { cookie: sid, "x-csrf-token": csrf },
      payload: {},
    });
    expect([400, 404, 403]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(500);
  });
});
