import { z } from "zod";
import {
  CRED_STATUS,
  JOB_STATUS,
  JOB_STEPS,
  NETWORK_MODE,
  OS_TYPES,
  PROTOCOLS,
  PROVISIONING_METHODS,
  ROLES,
  STEP_STATE,
  VM_STATUS,
} from "./enums.js";

export const redact = (value: string): string =>
  value ? `[REDACTED:${value.length}]` : "[REDACTED]";

export const userId = z.string().uuid();
export const vmId = z.string().uuid();

const passwordComplexity = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/[0-9]/, "Password must contain a number")
  .regex(/[^A-Za-z0-9]/, "Password must contain a special character");

export const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(512),
});

export const createUserSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, "Username may contain letters, numbers, dots, dashes, underscores"),
  email: z.string().email().optional().or(z.literal("").transform(() => undefined)),
  password: passwordComplexity,
  role: z.enum(ROLES).default("USER"),
  givenName: z.string().max(128).optional(),
});

export const roleSchema = z.enum(ROLES);

// Self-service account request. Same identity/password rules as admin
// creation; approval (by an administrator) is a separate, authenticated step.
export const registrationSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, "Username may contain letters, numbers, dots, dashes, underscores"),
  email: z.string().email().optional().or(z.literal("").transform(() => undefined)),
  password: passwordComplexity,
});

// Client-side checklist mirror of passwordComplexity (backend authoritative).
// Kept as data so the signup form can render each rule with live feedback.
export const PASSWORD_RULES: Array<{ id: string; label: string; test: RegExp | null; minLength: number | null }> = [
  { id: "length", label: "At least 12 characters", test: null, minLength: 12 },
  { id: "lower", label: "A lowercase letter (a–z)", test: /[a-z]/, minLength: null },
  { id: "upper", label: "An uppercase letter (A–Z)", test: /[A-Z]/, minLength: null },
  { id: "number", label: "A number (0–9)", test: /[0-9]/, minLength: null },
  { id: "symbol", label: "A special character (!@#…)", test: /[^A-Za-z0-9]/, minLength: null },
];

export const setupAdminSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, "Username may contain letters, numbers, dots, dashes, underscores"),
  email: z.string().email().optional(),
  password: passwordComplexity,
  sessionDurationHours: z.number().int().min(1).max(720).default(12),
  sessionIdleTimeoutMinutes: z.number().int().min(5).max(720).default(120),
  cookieSecure: z.boolean().default(true),
});

export const proxmoxConfigSchema = z.object({
  url: z
    .string()
    .min(1)
    .url()
    .transform((u) => u.replace(/\/+$/, "")),
  tokenId: z.string().min(1).max(256),
  tokenSecret: z.string().min(8).max(512),
  verifySsl: z.boolean().default(true),
  defaultNode: z.string().max(128).optional(),
  defaultStorage: z.string().max(128).optional(),
  defaultNetwork: z.string().max(128).optional(),
});

export const guacamoleDbEngines = ["postgresql", "mariadb", "mysql"] as const;
export type GuacamoleDbEngineOption = (typeof guacamoleDbEngines)[number];

export const guacamoleConfigSchema = z.object({
  url: z
    .string()
    .min(1)
    .url()
    .transform((u) => u.replace(/\/+$/, "")),
  publicUrl: z.string().url().optional().default(""),
  dbHost: z.string().min(1).max(256),
  dbPort: z.number().int().min(1).max(65535).default(5432),
  dbName: z.string().min(1).max(128),
  dbUser: z.string().min(1).max(128),
  dbPassword: z.string().min(1).max(512),
  dbSsl: z.boolean().default(false),
  dbEngine: z.enum(guacamoleDbEngines).default("postgresql"),
});

export const databaseConfigSchema = z.object({
  host: z.string().min(1).max(256),
  port: z.number().int().min(1).max(65535).default(5432),
  name: z.string().min(1).max(128),
  user: z.string().min(1).max(128),
  password: z.string().min(1).max(512),
  ssl: z.boolean().default(false),
});

export const redisConfigSchema = z.object({
  host: z.string().min(1).max(256).default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(6379),
  password: z.string().max(512).optional(),
  db: z.number().int().min(0).max(15).default(0),
});

export const localConfigSchema = z.object({
  version: z.literal(1),
  app: z.object({
    baseUrl: z.string().url().optional(),
    cookieSecure: z.boolean(),
    sessionDurationHours: z.number().int().min(1).max(720),
    sessionIdleTimeoutMinutes: z.number().int().min(5).max(720),
    allowRegistrationOpen: z.boolean().default(false),
  }),
  database: databaseConfigSchema,
  redis: redisConfigSchema,
  secrets: z.object({
    sessionSigningKey: z.string().min(32),
    masterKeyId: z.string().min(1).default("v1"),
    masterKey: z.string().min(32),
  }),
});

export type LocalConfig = z.infer<typeof localConfigSchema>;

export const vmTemplateSchema = z.object({
  name: z.string().min(1).max(128),
  proxmoxVmid: z.number().int().min(100).max(999999999),
  node: z.string().min(1).max(128),
  osType: z.enum(OS_TYPES),
  provisioningMethod: z.enum(PROVISIONING_METHODS),
  cloudInitSupport: z.boolean(),
  guestAgentRequired: z.boolean(),
  defaultCpu: z.number().int().min(1).max(512).default(2),
  defaultRamMb: z.number().int().min(256).max(1048576).default(2048),
  defaultDiskGb: z.number().min(1).max(16384).default(20),
  supportedProtocols: z.array(z.enum(PROTOCOLS)).min(1),
});

export const provisionVmSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "Invalid VM name"),
  templateId: z.string().uuid().optional(),
  proxmoxTemplateVmid: z.number().int().optional(),
  node: z.string().max(128).optional(),
  vmid: z.number().int().min(100).max(999999999).optional(),
  cpu: z.number().int().min(1).max(512),
  ramMb: z.number().int().min(256).max(1048576),
  diskGb: z.number().min(1).max(16384),
  storage: z.string().max(128),
  network: z.object({
    bridge: z.string().min(1).max(128),
    vlan: z.number().int().min(0).max(4094).optional(),
    mode: z.enum(NETWORK_MODE),
    ip: z.string().ip({ version: "v4" }).optional(),
    cidr: z.number().int().min(0).max(32).optional(),
    gateway: z.string().ip({ version: "v4" }).optional(),
    dns: z.array(z.string().ip({ version: "v4" })).max(4).optional(),
  }),
  osType: z.enum(OS_TYPES),
  // Access protocols to expose via Guacamole. When omitted, the template's
  // supportedProtocols are used (falling back to the OS default).
  protocols: z.array(z.enum(PROTOCOLS)).min(1).max(3).optional(),
  guestUser: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z_][a-z0-9_-]*$/i, "Invalid guest username"),
  password: passwordComplexity.describe("Guest password"),
  sshKey: z.string().max(16384).optional(),
  startAfterProvision: z.boolean().default(true),
  linkedClone: z.boolean().default(true),
  assignToUserIds: z.array(z.string().uuid()).default([]),
});

export type ProvisionVmRequest = z.infer<typeof provisionVmSchema>;

// Simplified Basic-mode provisioning input. Every field except name,
// templateId and password is optional: the backend resolves configured
// defaults (node/storage/bridge from Proxmox settings, resources and
// protocols from the template) and then validates the result against the
// full provisionVmSchema. Advanced clients may send the full schema, which
// is a valid Basic input (all of its required fields are accepted here).
export const basicProvisionSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "Invalid VM name"),
  templateId: z.string().uuid(),
  proxmoxTemplateVmid: z.number().int().optional(),
  node: z.string().max(128).optional(),
  vmid: z.number().int().min(100).max(999999999).optional(),
  cpu: z.number().int().min(1).max(512).optional(),
  ramMb: z.number().int().min(256).max(1048576).optional(),
  diskGb: z.number().min(1).max(16384).optional(),
  storage: z.string().max(128).optional(),
  network: z
    .object({
      bridge: z.string().min(1).max(128).optional(),
      vlan: z.number().int().min(0).max(4094).optional(),
      mode: z.enum(NETWORK_MODE).default("dhcp"),
      ip: z.string().ip({ version: "v4" }).optional(),
      cidr: z.number().int().min(0).max(32).optional(),
      gateway: z.string().ip({ version: "v4" }).optional(),
      dns: z.array(z.string().ip({ version: "v4" })).max(4).optional(),
    })
    .optional(),
  osType: z.enum(OS_TYPES).optional(),
  protocols: z.array(z.enum(PROTOCOLS)).min(1).max(3).optional(),
  guestUser: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z_][a-z0-9_-]*$/i, "Invalid guest username")
    .optional(),
  password: passwordComplexity.describe("Guest password"),
  sshKey: z.string().max(16384).optional(),
  startAfterProvision: z.boolean().default(true),
  linkedClone: z.boolean().default(true),
  assignToUserIds: z.array(z.string().uuid()).default([]),
});

export type BasicProvisionRequest = z.infer<typeof basicProvisionSchema>;

export const vmEditSchema = z.object({
  cpu: z.number().int().min(1).max(512).optional(),
  ramMb: z.number().int().min(256).max(1048576).optional(),
  assignToUserIds: z.array(z.string().uuid()).optional(),
});

export const credentialRotateSchema = z.object({
  newPassword: passwordComplexity.optional(),
  username: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z_][a-z0-9_-]*$/i)
    .optional(),
  verify: z.boolean().default(true),
});

export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  event: z.string().optional(),
  vmId: z.string().uuid().optional(),
});

export const jobsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(JOB_STATUS).optional(),
});

export const healthCheckResult = z.object({
  name: z.string(),
  status: z.enum(["ONLINE", "OFFLINE", "ERROR"]),
  latencyMs: z.number().nullable(),
  lastChecked: z.string(),
  detail: z.string().nullable().optional(),
});

export type HealthCheckResult = z.infer<typeof healthCheckResult>;

export const jobStatusSchema = z.enum(JOB_STATUS);
export const jobStepSchema = z.enum(JOB_STEPS);
export const stepStateSchema = z.enum(STEP_STATE);
export const vmStatusSchema = z.enum(VM_STATUS);
export const credStatusSchema = z.enum(CRED_STATUS);
export const protocolSchema = z.enum(PROTOCOLS);
export const osTypeSchema = z.enum(OS_TYPES);
export const provisioningMethodSchema = z.enum(PROVISIONING_METHODS);
export const networkModeSchema = z.enum(NETWORK_MODE);