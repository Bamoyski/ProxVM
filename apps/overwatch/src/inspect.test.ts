import { describe, expect, it } from "vitest";
import { isReadOnlyStatement, parseBearerToken, stripDockerStream } from "./inspect.js";

describe("read-only SQL gate", () => {
  it("allows reads, blocks writes and tricks", () => {
    for (const q of [
      "SELECT * FROM users",
      "  select 1",
      "WITH x AS (SELECT 1) SELECT * FROM x",
      "EXPLAIN SELECT 1",
      "SHOW server_version",
      "VALUES (1), (2)",
      "TABLE users",
    ]) {
      expect(isReadOnlyStatement(q)).toBe(true);
    }
    for (const q of [
      "DELETE FROM users",
      "DROP TABLE users",
      "UPDATE users SET active=false",
      "INSERT INTO users VALUES (1)",
      "  -- comment\nDELETE FROM users",
      "(SELECT 1)",
      "",
    ]) {
      expect(isReadOnlyStatement(q)).toBe(false);
    }
    // Multi-statement smuggling passes the regex on purpose: the READ ONLY
    // transaction below is the enforcement, and it rejects the write there.
    expect(isReadOnlyStatement("SELECT 1; DROP TABLE users")).toBe(true);
  });
});

describe("bearer parsing", () => {
  it("extracts single tokens, rejects junk", () => {
    expect(parseBearerToken("Bearer abc123")).toBe("abc123");
    expect(parseBearerToken("bearer ABC")).toBe("ABC");
    expect(parseBearerToken(undefined)).toBe("");
    expect(parseBearerToken("Basic abc")).toBe("");
    expect(parseBearerToken("Bearer ")).toBe("");
    expect(parseBearerToken(["Bearer one", "Bearer two"])).toBe("one");
  });
});

describe("docker demux stripping", () => {
  it("passes plain logs through", () => {
    expect(stripDockerStream(Buffer.from("line one\nline two\n", "utf8"))).toBe("line one\nline two\n");
    expect(stripDockerStream(Buffer.from("short", "utf8"))).toBe("short");
  });
  it("strips multiplexed frames", () => {
    const frame = (type: number, text: string): Buffer => {
      const payload = Buffer.from(text, "utf8");
      const header = Buffer.alloc(8);
      header[0] = type;
      header.writeUInt32BE(payload.length, 4);
      return Buffer.concat([header, payload]);
    };
    const buf = Buffer.concat([frame(1, "out-one\n"), frame(2, "err-one\n")]);
    expect(stripDockerStream(buf)).toBe("out-one\nerr-one\n");
  });
  it("drops truncated tails instead of throwing", () => {
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(9999, 4);
    expect(() => stripDockerStream(Buffer.concat([header, Buffer.from("ab", "utf8")]))).not.toThrow();
  });
});
