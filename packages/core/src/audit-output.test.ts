import { describe, expect, it, beforeAll } from "vitest";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import RedisMock from "ioredis-mock";
import { createCore, csvCell, escapeLike, type CoreContext, type LocalConfig } from "./index.js";

const masterKey = "a".repeat(64);

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

const silentLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as never;

describe("audit output encoding", () => {
  let ctx: CoreContext;

  beforeAll(async () => {
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    ctx = await createCore(localConfig, { db: pool, redis: new RedisMock() as never, logger: silentLogger });
  });

  it("neutralizes spreadsheet formula prefixes", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+cmd")).toBe("'+cmd");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@user")).toBe("'@user");
    expect(csvCell("normal text")).toBe("normal text");
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe("");
  });

  it("redacts secret-like detail keys regardless of casing", async () => {
    await ctx.audit.record({
      event: "SETTINGS_CHANGED",
      detail: {
        newPassword: "hunter2",
        api_key: "AKIA...",
        apiKey: "AKIA2...",
        sshKey: "ssh-ed25519 AAAA",
        passphrase: "s3cret",
        privateKey: "PEM...",
        username: "bob",
      },
    });
    const rows = await ctx.db.query<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM audit_logs WHERE event = 'SETTINGS_CHANGED'",
    );
    const detail = rows.rows[0]!.detail as Record<string, unknown>;
    expect(detail.newPassword).toBe("[REDACTED]");
    expect(detail.api_key).toBe("[REDACTED]");
    expect(detail.apiKey).toBe("[REDACTED]");
    expect(detail.sshKey).toBe("[REDACTED]");
    expect(detail.passphrase).toBe("[REDACTED]");
    expect(detail.privateKey).toBe("[REDACTED]");
    expect(detail.username).toBe("bob");
  });

  it("escapes LIKE wildcards in filter text", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b\\c")).toBe("a\\_b\\\\c");
    expect(escapeLike("plain")).toBe("plain");
  });
});
