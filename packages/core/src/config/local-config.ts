import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { localConfigSchema, redisConfigSchema, type LocalConfig } from "@proxvm/shared";
import { AppError } from "../util/errors.js";

export function defaultConfigPath(): string {
  return process.env.PROXVM_CONFIG_DIR
    ? path.join(process.env.PROXVM_CONFIG_DIR, "config.json")
    : path.join(process.cwd(), ".proxvm", "config.json");
}

export async function configExists(filePath = defaultConfigPath()): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(filePath = defaultConfigPath()): Promise<LocalConfig | null> {
  if (!(await configExists(filePath))) return null;
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = localConfigSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      `Local configuration file is invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      500,
    );
  }
  return parsed.data;
}

export async function restrictConfigFilePermissions(filePath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    throw new AppError(
      "CONFIGURATION_ERROR",
      "Failed to restrict permissions on the configuration file",
      500,
    );
  }
}

export async function saveConfig(
  config: LocalConfig,
  filePath = defaultConfigPath(),
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  await fs.rename(tmp, filePath);
  await restrictConfigFilePermissions(filePath);
}

export function generateSessionSigningKey(): string {
  return randomBytes(32).toString("hex");
}

export function generateMasterKey(): string {
  return randomBytes(32).toString("hex");
}

export interface SetupConfigInput {
  admin: {
    username: string;
    email?: string;
    password: string;
  };
  app: {
    sessionDurationHours: number;
    sessionIdleTimeoutMinutes: number;
    cookieSecure: boolean;
  };
  database: z.infer<typeof localConfigSchema>["database"];
  redis?: z.infer<typeof redisConfigSchema>;
}

export function buildLocalConfig(input: SetupConfigInput): LocalConfig {
  const redis = input.redis ?? { host: "127.0.0.1", port: 6379, db: 0 };
  return {
    version: 1,
    app: {
      cookieSecure: input.app.cookieSecure,
      sessionDurationHours: input.app.sessionDurationHours,
      sessionIdleTimeoutMinutes: input.app.sessionIdleTimeoutMinutes,
      allowRegistrationOpen: false,
    },
    database: input.database,
    redis,
    secrets: {
      sessionSigningKey: generateSessionSigningKey(),
      masterKeyId: "v1",
      masterKey: generateMasterKey(),
    },
  };
}