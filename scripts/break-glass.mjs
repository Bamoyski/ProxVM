#!/usr/bin/env node
// Emergency administrator recovery for ProxVM.
//
// Use when no administrator can log in (all passwords lost, accounts locked
// or disabled). Creates the account as ADMIN (or resets its password,
// re-enables and unlocks it) directly in the application database.
//
//   PROXVM_CONFIG_DIR=/data/.proxvm node scripts/break-glass.mjs <username>
//
// The password is read from PROXVM_BG_PASSWORD or prompted on stdin (it will
// be visible while typing — run this over an encrypted session only).
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

const ADMIN_ROLE_ID = "00000000-0000-0000-0000-000000000001";

async function readPassword() {
  if (process.env.PROXVM_BG_PASSWORD) return process.env.PROXVM_BG_PASSWORD;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question("New admin password: ", resolve));
  rl.close();
  return String(answer).trim();
}

async function main() {
  const username = process.argv[2];
  if (!username || !/^[A-Za-z0-9 _-]{1,64}$/.test(username)) {
    console.error("Usage: node scripts/break-glass.mjs <username>");
    process.exit(2);
  }
  const password = await readPassword();
  if (password.length < 12) {
    console.error("Refusing: password must be at least 12 characters.");
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
  const client = new Client({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.name,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    const id = randomUUID();
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
    await client.query("DELETE FROM user_roles WHERE user_id = $1", [userId]);
    await client.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
      userId,
      ADMIN_ROLE_ID,
    ]);
    await client.query("UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    console.log(`Administrator "${username}" is ready. Log in, then rotate any other admin credentials.`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(`break-glass failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
