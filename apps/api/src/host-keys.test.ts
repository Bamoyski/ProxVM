import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import { createCore, hashPassword, makeLogger, type CoreContext, type LocalConfig } from "@proxvm/core";
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
  secrets: { sessionSigningKey: "s".repeat(64), masterKeyId: "v1", masterKey: "e".repeat(64) },
};

interface Session {
  cookie: string;
  csrf: string;
}

const FP_A = "a".repeat(64);
const FP_C = "c".repeat(64);

async function login(
  app: Awaited<ReturnType<typeof buildApp>>,
  username: string,
  password: string,
): Promise<Session> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === "proxvm_session");
  return { cookie: `${cookie?.name}=${cookie?.value}`, csrf: (res.json() as { csrfToken: string }).csrfToken };
}

const auth = (s: Session) => ({ cookie: s.cookie, "x-csrf-token": s.csrf });

describe("SSH host-key admin API", () => {
  let ctx: CoreContext;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let admin: Session;
  let operator: Session;
  let stranger: Session;
  let vmId: string;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, { db: pool, redis: new RedisMockCtor() as never, logger: makeLogger("test") });

    await ctx.users.create({ username: "admin", passwordHash: await hashPassword("Admin-Password-1!"), roles: ["ADMIN"] });
    await ctx.users.create({ username: "op", passwordHash: await hashPassword("Operator-Pass-1!"), roles: ["OPERATOR"] });
    await ctx.users.create({ username: "stranger", passwordHash: await hashPassword("Stranger-Pass-1!"), roles: ["USER"] });

    const vm = await ctx.vms.create({
      vmid: 720,
      node: "node1",
      name: "hostkey-api-vm",
      status: "running",
      osType: "linux",
      ipAddress: "198.51.100.7",
    });
    vmId = vm.id;

    app = await buildApp({ setupMode: false, ctx });
    admin = await login(app, "admin", "Admin-Password-1!");
    operator = await login(app, "op", "Operator-Pass-1!");
    stranger = await login(app, "stranger", "Stranger-Pass-1!");
  });

  afterAll(async () => {
    await app.close();
  });

  it("admin sees no pins before any connection; a USER without VM access gets 403", async () => {
    const empty = await app.inject({ method: "GET", url: `/api/vms/${vmId}/host-keys`, headers: { cookie: admin.cookie } });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ hostKeys: [] });

    const denied = await app.inject({ method: "GET", url: `/api/vms/${vmId}/host-keys`, headers: { cookie: stranger.cookie } });
    expect(denied.statusCode).toBe(403);
  });

  it("lists a pin enrolled by a connection", async () => {
    await ctx.hostKeys.policy({ vmId, host: "198.51.100.7", port: 22 }).confirm(FP_A, "ssh-ed25519");
    const res = await app.inject({ method: "GET", url: `/api/vms/${vmId}/host-keys`, headers: { cookie: admin.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { hostKeys: Array<{ endpoint: string; fingerprint: string }> };
    expect(body.hostKeys).toEqual([
      expect.objectContaining({ endpoint: "198.51.100.7:22", fingerprint: FP_A }),
    ]);
  });

  it("requires admin for rotate/unpin", async () => {
    const rotate = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/host-keys/rotate`,
      headers: auth(operator),
      payload: { fingerprint: FP_C },
    });
    expect(rotate.statusCode).toBe(403);

    const unpin = await app.inject({ method: "POST", url: `/api/vms/${vmId}/host-keys/unpin`, headers: auth(operator), payload: {} });
    expect(unpin.statusCode).toBe(403);
  });

  it("enforces CSRF on mutations", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/host-keys/rotate`,
      headers: { cookie: admin.cookie },
      payload: { fingerprint: FP_C },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a malformed fingerprint with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/host-keys/rotate`,
      headers: auth(admin),
      payload: { fingerprint: "not-a-fingerprint" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s rotating an endpoint that has no pin yet", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/host-keys/rotate`,
      headers: auth(admin),
      payload: { host: "198.51.100.99", fingerprint: FP_C },
    });
    expect(res.statusCode).toBe(404);
  });

  it("lets an admin re-verify a changed fingerprint (audited) and then unpin", async () => {
    const rotate = await app.inject({
      method: "POST",
      url: `/api/vms/${vmId}/host-keys/rotate`,
      headers: auth(admin),
      payload: { fingerprint: FP_C },
    });
    expect(rotate.statusCode).toBe(200);
    expect((rotate.json() as { fingerprint: string }).fingerprint).toBe(FP_C);

    const afterRotate = await app.inject({ method: "GET", url: `/api/vms/${vmId}/host-keys`, headers: { cookie: admin.cookie } });
    expect((afterRotate.json() as { hostKeys: Array<{ fingerprint: string }> }).hostKeys[0]?.fingerprint).toBe(FP_C);

    const unpin = await app.inject({ method: "POST", url: `/api/vms/${vmId}/host-keys/unpin`, headers: auth(admin), payload: {} });
    expect(unpin.statusCode).toBe(200);
    expect(unpin.json()).toEqual({ removed: true });

    const cleared = await app.inject({ method: "GET", url: `/api/vms/${vmId}/host-keys`, headers: { cookie: admin.cookie } });
    expect(cleared.json()).toEqual({ hostKeys: [] });

    const rotated = await ctx.audit.list({ event: "SSH_HOST_KEY_ROTATED" });
    const unpinned = await ctx.audit.list({ event: "SSH_HOST_KEY_UNPINNED" });
    expect(rotated[0]?.actorUsername).toBe("admin");
    expect(unpinned[0]?.actorUsername).toBe("admin");
  });
});
