import type { Queryable } from "../db/pool.js";
import { AppError } from "../util/errors.js";

export const UNCHANGED_SENTINEL = "__UNCHANGED__";

export interface StoredProxmoxSettings {
  url: string;
  tokenId: string;
  tokenSecret: string;
  verifySsl: boolean;
  defaultNode: string | null;
  defaultStorage: string | null;
  defaultNetwork: string | null;
}

export interface StoredGuacamoleSettings {
  engine: "postgresql" | "mariadb" | "mysql";
  url: string;
  publicUrl: string | null;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  dbSsl: boolean;
}

export interface SettingsServiceDeps {
  db: Queryable;
  masterKey: string;
  keyId: string;
  encrypt: (plaintext: string) => string;
  decrypt: (stored: string) => string;
}

export class SettingsService {
  constructor(
    private readonly db: Queryable,
    private readonly encrypt: (plaintext: string) => string,
    private readonly decrypt: (stored: string) => string,
  ) {}

  async get(key: string): Promise<{ value: string; encrypted: boolean } | null> {
    const result = await this.db.query<{ value: string; encrypted: boolean }>(
      "SELECT value, encrypted FROM settings WHERE key = $1",
      [key],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { value: row.encrypted ? this.decrypt(row.value) : row.value, encrypted: row.encrypted };
  }

  async getPlain(key: string): Promise<string | null> {
    const entry = await this.get(key);
    return entry ? entry.value : null;
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.getPlain(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, opts: { encrypted?: boolean; category?: string } = {}): Promise<void> {
    const encrypted = opts.encrypted ?? isSecretKey(key);
    const stored = encrypted ? this.encrypt(value) : value;
    await this.db.query(
      `INSERT INTO settings (key, value, encrypted, category, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, encrypted = EXCLUDED.encrypted,
         category = EXCLUDED.category, updated_at = NOW()`,
      [key, stored, encrypted, opts.category ?? "app"],
    );
  }

  async setSecretWithSentinel(key: string, value: string): Promise<void> {
    if (value === UNCHANGED_SENTINEL) {
      const existing = await this.get(key);
      if (!existing) {
        throw new AppError("VALIDATION_ERROR", `No existing value for ${key}`, 400);
      }
      return;
    }
    await this.set(key, value, { encrypted: true });
  }

  async proxmox(): Promise<StoredProxmoxSettings | null> {
    const url = await this.getPlain("proxmox.url");
    if (!url) return null;
    const tokenSecret = await this.getPlain("proxmox.token_secret");
    if (tokenSecret === null) return null;
    return {
      url,
      tokenId: (await this.getPlain("proxmox.token_id")) ?? "",
      tokenSecret,
      verifySsl: (await this.getPlain("proxmox.verify_ssl")) !== "false",
      defaultNode: await this.getPlain("proxmox.default_node"),
      defaultStorage: await this.getPlain("proxmox.default_storage"),
      defaultNetwork: await this.getPlain("proxmox.default_network"),
    };
  }

  async guacamole(): Promise<StoredGuacamoleSettings | null> {
    const url = await this.getPlain("guacamole.url");
    if (!url) return null;
    const dbPassword = await this.getPlain("guacamole.db_password");
    if (dbPassword === null) return null;
    const engineRaw = (await this.getPlain("guacamole.db_engine")) ?? "postgresql";
    const engine = engineRaw === "mariadb" || engineRaw === "mysql" ? engineRaw : "postgresql";
    return {
      engine,
      url,
      publicUrl: await this.getPlain("guacamole.public_url"),
      dbHost: (await this.getPlain("guacamole.db_host")) ?? "",
      dbPort: Number((await this.getPlain("guacamole.db_port")) ?? "5432"),
      dbName: (await this.getPlain("guacamole.db_name")) ?? "",
      dbUser: (await this.getPlain("guacamole.db_user")) ?? "",
      dbPassword,
      dbSsl: (await this.getPlain("guacamole.db_ssl")) === "true",
    };
  }
}

const SECRET_KEY_SUFFIXES = [
  "token_secret",
  "token_secret".replace("_", "."),
  "db_password",
  "master_key",
  "session_key",
  "password",
  ".secret",
];

function isSecretKey(key: string): boolean {
  return SECRET_KEY_SUFFIXES.some((s) => key.endsWith(s));
}