#!/usr/bin/env node
// Emergency administrator recovery for ProxVM.
//
// Use when no administrator can log in (all passwords lost, accounts locked
// or disabled). Creates the account as ADMIN (or resets its password,
// re-enables and unlocks it) directly in the application database.
//
//   PROXVM_CONFIG_DIR=/data/.proxvm node scripts/break-glass.mjs <username>
//
// The password is read from PROXVM_BG_PASSWORD (visible in process listings —
// last resort) or prompted on stdin with echo disabled. Run this over an
// encrypted session only. Database TLS is verified unless
// PROXVM_BG_SSL_INSECURE=1 is set explicitly.
// Requires network access to the application database and the argon2/pg
// packages from the repo root node_modules. Run from the repository root.
//
// This intentionally bypasses every application control: it needs the same
// access an attacker would need (database + filesystem), so guard both.

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";

const require = createRequire(import.meta.url);
const argon2 = require("argon2");
const { Client } = require("pg");

async function readPassword() {
  if (process.env.PROXVM_BG_PASSWORD) {
    console.error("WARNING: password from PROXVM_BG_PASSWORD is visible in process listings; prefer the prompt.");
    return process.env.PROXVM_BG_PASSWORD;
  }
  if (!process.stdin.isTTY) {
    console.error("Refusing: no TTY for hidden password entry. Set PROXVM_BG_PASSWORD instead (see warning above).");
    process.exit(2);
  }
  // No-echo entry: raw mode with manual line buffering (no readline echo).
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const answer = await new Promise((resolve) => {
    let buf = "";
    const onData = (chunk) => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "\u0003") {
          process.stdin.setRawMode(false);
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    process.stdin.on("data", onData);
  });
  return String(answer).trim();
}

async function main() {
  const username = process.argv[2];
  if (!username || !/^[A-Za-z0-9 _-]{1,64}$/.test(username)) {
    console.error("Usage: node scripts/break-glass.mjs <username>");
    process.exit(2);
  }
  const password = await readPassword();
  if (password.length < 12 || password.length > 128) {
    console.error("Refusing: password must be 12–128 characters (matches the application policy).");
    process.exit(2);
  }
  const configDir = process.env.PROXVM_CONFIG_DIR ?? path.join(process.cwd(), ".proxvm");
  const config = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
  const hash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  // TLS verification stays on when the config asks for SSL; self-signed
  // servers require explicit opt-in, never silent downgrade.
  const insecure = process.env.PROXVM_BG_SSL_INSECURE === "1";
  const client = new Client({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.name,
    ssl: config.database.ssl ? (insecure ? { rejectUnauthorized: false } : { rejectUnauthorized: true }) : undefined,
  });
  await client.connect();
  try {
    const id = randomUUID();
    // Refuse to silently convert an existing non-admin user into ADMIN:
    // account takeover requires explicit acknowledgement.
    const preexisting = await client.query("SELECT id FROM users WHERE username = $1", [username]);
    if (preexisting.rows[0] && !process.argv.includes("--force-takeover")) {
      console.error(
        `Refusing: user "${username}" already exists. Re-run with --force-takeover to convert it into an administrator (this strips its current roles).`,
      );
      process.exit(2);
    }
    await client.query(
      `INSERT INTO users (id, username, password_hash, active, failed_attempts, locked_until)
       VALUES ($1, $2, $3, true, 0, NULL)
       ON CONFLICT (username) DO UPDATE SET
         password_hash = EXCLUDED.password_hash, active = true,
         failed_attempts = 0, locked_until = NULL`,
      [id, username, hash],
    );
    const row = await client.query("SELECT id FROM users WHERE username = $1", [username]);
    const userId = row.rows[0].id;
    // Resolve ADMIN by name and fail closed: a hardcoded role UUID would
    // silently grant the wrong role if seed data ever changed.
    const role = await client.query("SELECT id FROM roles WHERE name = 'ADMIN'");
    if (!role.rows[0]) {
      throw new Error("ADMIN role not found; refusing to guess a role id");
    }
    await client.query("DELETE FROM user_roles WHERE user_id = $1", [userId]);
    await client.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
      userId,
      role.rows[0].id,
    ]);
    await client.query("UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    // Leave a tamper-evident trail: direct DB writes bypass the app's audit
    // decorator, so record the recovery explicitly (best-effort — recovery
    // must not fail just because the audit table is unreachable).
    try {
      await client.query(
        `INSERT INTO audit_logs (id, event, actor_user_id, actor_username, detail)
         VALUES ($1, 'BREAK_GLASS_USED', $2, $3, $4)`,
        [randomUUID(), userId, username, JSON.stringify({ forcedTakeover: preexisting.rows[0] ? true : false })],
      );
    } catch (auditErr) {
      console.error(
        `WARNING: break-glass audit record failed (${auditErr instanceof Error ? auditErr.message : String(auditErr)}). Record this use out-of-band.`,
      );
    }
    console.log(`Administrator "${username}" is ready. Log in, then rotate any other admin credentials.`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(`break-glass failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
