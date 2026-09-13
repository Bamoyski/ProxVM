import { describe, expect, it } from "vitest";
import {
  GuacamoleMySqlClient,
  GuacamolePostgresClient,
  createGuacamoleDbClient,
  sha256SaltedHashPassword,
  encodeParameter,
  connectionParamsFor,
} from "./index.js";
import { createHash } from "node:crypto";

type RecordedQuery = { sql: string; params: unknown[] };

function makeFakeMySqlPool() {
  const queries: RecordedQuery[] = [];
  const results: Array<Array<Record<string, unknown>>> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return [results.shift() ?? [], []];
    },
    execute: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return [{ insertId: 42, affectedRows: 1 }, []];
    },
    getConnection: async () => {
      const connQueries: RecordedQuery[] = [];
      const conn = {
        beginTransaction: async () => undefined,
        commit: async () => undefined,
        rollback: async () => undefined,
        release: () => undefined,
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          return [results.shift() ?? [], []];
        },
      };
      void connQueries;
      return conn;
    },
    end: async () => undefined,
  };
  return { pool, queries, results, insertId: () => 42 };
}

describe("guacamole MariaDB/MySQL client", () => {
  it("testConnection checks schema presence in the current database", async () => {
    const fake = makeFakeMySqlPool();
    fake.results.push([{ c: 1 }]);
    fake.results.push([{ present: 1 }]);
    fake.results.push([{ version: "1.5.5" }]);
    const client = new GuacamoleMySqlClient(fake.pool as never);
    const check = await client.testConnection();
    expect(check.ok).toBe(true);
    expect(check.schemaVersion).toBe("1.5.5");
    expect(fake.queries[1]?.sql).toContain("information_schema.tables");
    expect(fake.queries[1]?.sql).toContain("table_schema = DATABASE()");
  });

  it("createUser binds BINARY(32) hash + salt and inserts via entity + user rows", async () => {
    const fake = makeFakeMySqlPool();
    fake.results.push([]);
    fake.results.push({ insertId: 7 } as unknown as Array<Record<string, unknown>>);
    fake.results.push([]);
    fake.results.push([{ user_id: 42 }]);
    const client = new GuacamoleMySqlClient(fake.pool as never);
    const userId = await client.createUser({ username: "px_admin", password: "secret-pass" });
    expect(userId).toBe(42);
    const entityInsert = fake.queries.find((q) => q.sql.includes("INSERT INTO guacamole_entity"));
    expect(entityInsert?.params).toEqual(["px_admin"]);
    const userInsert = fake.queries.find((q) => q.sql.includes("INSERT INTO guacamole_user"));
    expect(userInsert).toBeTruthy();
    const [entityId, hash, salt] = userInsert?.params ?? [];
    expect(entityId).toBe(7);
    expect(hash).toBeInstanceOf(Buffer);
    expect(salt).toBeInstanceOf(Buffer);
    expect((hash as Buffer).length).toBe(32);
    expect((salt as Buffer).length).toBe(32);
    const expected = createHash("sha256")
      .update("secret-pass" + (salt as Buffer).toString("hex").toUpperCase(), "utf8")
      .digest();
    expect((hash as Buffer).equals(expected)).toBe(true);
    expect(userInsert?.sql).toContain("CURRENT_DATE()");
  });

  it("uses INSERT IGNORE for grants and ON DUPLICATE KEY for parameter upserts", async () => {
    const fake = makeFakeMySqlPool();
    fake.results.push([{ connection_id: 5 }]);
    const client = new GuacamoleMySqlClient(fake.pool as never);
    await client.updateConnectionParams("proxvm-vm1", { password: "abc" });
    const upsert = fake.queries.find((q) => q.sql.includes("ON DUPLICATE KEY UPDATE"));
    expect(upsert).toBeTruthy();
    expect(upsert?.params).toEqual([5, "password", "abc"]);
    await client.grantConnectionRead("proxvm-vm1", "px_user");
    expect(fake.queries.some((q) => q.sql.includes("INSERT IGNORE INTO guacamole_connection_permission"))).toBe(true);
    await client.grantRootGroupRead("px_user");
    expect(fake.queries.some((q) => q.sql.includes("INSERT IGNORE INTO guacamole_connection_group_permission"))).toBe(true);
  });

  it("deleteConnection reports affected rows", async () => {
    const fake = makeFakeMySqlPool();
    const client = new GuacamoleMySqlClient(fake.pool as never);
    expect(await client.deleteConnection("proxvm-vm1")).toBe(true);
    expect(fake.queries[0]?.sql).toContain("DELETE FROM guacamole_connection");
  });

  it("stores connection parameters as plaintext, never Base64 (guacd reads raw DB values)", async () => {
    const fake = makeFakeMySqlPool();
    fake.results.push([{ connection_id: 9 }]);
    const client = new GuacamoleMySqlClient(fake.pool as never);
    await client.updateConnectionParams("proxvm-vm1", { hostname: "192.168.1.79", port: "22" });
    const rows = fake.queries.filter((q) => q.sql.includes("guacamole_connection_parameter"));
    const byName = new Map<string, unknown>();
    for (const r of rows) byName.set(String(r.params[1]), r.params[2]);
    expect(byName.get("hostname")).toBe("192.168.1.79");
    expect(byName.get("port")).toBe("22");
    expect(byName.get("hostname")).not.toBe(Buffer.from("192.168.1.79").toString("base64"));
    expect(encodeParameter("MTkyLjE2OC4xLjc5")).toBe("MTkyLjE2OC4xLjc5");
  });

  it("connectionParamsFor SSH yields plaintext values Guacamole expects", () => {
    const params = connectionParamsFor({ protocol: "ssh", hostname: "192.168.1.79", port: 22, username: "deploy", password: "pw" });
    expect(params.hostname).toBe("192.168.1.79");
    expect(params.port).toBe("22");
    expect(params.username).toBe("deploy");
  });

  it("connectionParamsFor RDP ignores the self-signed xrdp certificate via ignore-cert", () => {
    const params = connectionParamsFor({ protocol: "rdp", hostname: "192.168.1.50", port: 3389, username: "deploy", password: "pw" });
    expect(params["ignore-cert"]).toBe("true");
    expect(params.security).toBe("any");
    expect(params.port).toBe("3389");
  });

  it("connectionParamsFor SSH does not receive RDP-specific parameters", () => {
    const params = connectionParamsFor({ protocol: "ssh", hostname: "192.168.1.50", port: 22, username: "deploy", password: "pw" });
    expect(params["ignore-cert"]).toBeUndefined();
    expect(params.security).toBeUndefined();
    expect(params["disable-auth"]).toBeUndefined();
  });
});

describe("guacamole database factory", () => {
  it("selects the MySQL driver for mariadb and mysql engines", () => {
    const mariadb = createGuacamoleDbClient({
      engine: "mariadb",
      dbHost: "127.0.0.1",
      dbPort: 3306,
      dbName: "guacamole_db",
      dbUser: "u",
      dbPassword: "p",
      dbSsl: false,
    });
    expect(mariadb.client).toBeInstanceOf(GuacamoleMySqlClient);
    const mysql = createGuacamoleDbClient({
      engine: "mysql",
      dbHost: "127.0.0.1",
      dbPort: 3306,
      dbName: "guacamole_db",
      dbUser: "u",
      dbPassword: "p",
      dbSsl: false,
    });
    expect(mysql.client).toBeInstanceOf(GuacamoleMySqlClient);
    const pg = createGuacamoleDbClient({
      engine: "postgresql",
      dbHost: "127.0.0.1",
      dbPort: 5432,
      dbName: "guacamole_db",
      dbUser: "u",
      dbPassword: "p",
      dbSsl: false,
    });
    expect(pg.client).toBeInstanceOf(GuacamolePostgresClient);
  });
});

describe("sha256 salted hash (Guacamole SHA256PasswordEncryptionService compatible)", () => {
  it("produces 32-byte hash and 32-byte salt, salt unique per call", () => {
    const a = sha256SaltedHashPassword("same-password");
    const b = sha256SaltedHashPassword("same-password");
    expect(a.hash.length).toBe(32);
    expect(b.hash.length).toBe(32);
    expect(a.salt.equals(b.salt)).toBe(false);
    const expected = createHash("sha256")
      // codeql[js/insufficient-password-hash]: Test-only mirror of Guacamole 1.6.0's
      // SHA256PasswordEncryptionService format (see guacamole/db.ts). Asserts byte
      // compatibility with the third-party algorithm; not application auth.
      .update("same-password" + a.salt.toString("hex").toUpperCase(), "utf8")
      .digest();
    expect(a.hash.equals(expected)).toBe(true);
  });

  it("verifies against a hash produced by Guacamole 1.6.0 itself (known-good triple)", () => {
    // Captured from guacamole_user row created via the Guacamole 1.6.0 web UI:
    // password "Probe123!", stored hash/salt verified authenticating via /api/tokens.
    const storedHash = Buffer.from("e612761675e302a1800441085171ade69978a4b4fb6e2a0ddd85573272da598a", "hex");
    const storedSalt = Buffer.from("0812e690f36a67c3d7f498a5833c9278c774ec081c8bb80c3ec7c2dafc248798", "hex");
    // Compute what our function would produce for that password with that salt
    const salted = "Probe123!" + storedSalt.toString("hex").toUpperCase();
    const computed = createHash("sha256").update(salted, "utf8").digest();
    expect(computed.equals(storedHash)).toBe(true);
  });
});
