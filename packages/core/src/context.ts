import type IORedis from "ioredis";
import type { Pool } from "pg";
import type { LocalConfig } from "@proxvm/shared";
import type { Logger } from "./util/logger.js";
import { AppError } from "./util/errors.js";
import { runMigrations } from "./db/migrate.js";
import { encryptSecret, decryptSecret } from "./crypto/cipher.js";
import { SettingsService } from "./services/settings.js";
import { AuditService } from "./services/audit.js";
import { UsersService } from "./services/users.js";
import { RegistrationService } from "./services/registration.js";
import { SessionsService } from "./services/sessions.js";
import { VmsRepository } from "./services/vms.js";
import { CredentialsService } from "./services/credentials.js";
import { TemplatesService } from "./services/templates.js";
import { JobsRepository } from "./services/jobs.js";
import { GuacamoleService } from "./services/guacamole.js";
import { runHealthChecks } from "./services/health.js";
import { rotateVmCredential, type RotationOptions, type RotationActor, type RotationResult } from "./services/rotation.js";
import { HostKeyService } from "./ssh/host-keys.js";
import { ProxmoxClient } from "./proxmox/client.js";
import { createGuacamoleDbClient, type GuacamoleDbClient } from "./guacamole/db.js";
import { GuacamoleApiClient } from "./guacamole/api.js";
import { CloudflareClient } from "./cloudflare/client.js";
import { ProxmoxBackupClient } from "./pbs/client.js";
import { getCloudflareConfig, verifyDomainReachability, type DomainVerification } from "./services/domains.js";
import { createPgPool } from "./db/pool.js";
import { parseDbHost } from "./util/misc.js";

export interface CoreCache {
  proxmoxClient: ProxmoxClient | null;
  proxmoxClientAt: number;
  guacDb: { client: GuacamoleDbClient; close: () => Promise<void> } | null;
  guacDbAt: number;
  guacApi: GuacamoleApiClient | null;
}

export interface CoreContext {
  localConfig: LocalConfig;
  db: Pool;
  redis: IORedis;
  logger: Logger;
  settings: SettingsService;
  audit: AuditService;
  users: UsersService;
  registration: RegistrationService;
  sessions: SessionsService;
  vms: VmsRepository;
  creds: CredentialsService;
  templates: TemplatesService;
  jobs: JobsRepository;
  guac: GuacamoleService;
  hostKeys: HostKeyService;
  encrypt: (plaintext: string) => string;
  decrypt: (stored: string) => string;
  getProxmoxClient: () => Promise<ProxmoxClient>;
  getGuacDb: () => Promise<GuacamoleDbClient>;
  getGuacApi: () => Promise<GuacamoleApiClient | null>;
  getCloudflareClient: () => Promise<CloudflareClient>;
  getPbsClient: () => Promise<ProxmoxBackupClient | null>;
  verifyDomain: (fqdn: string) => Promise<DomainVerification>;
  runHealthChecks: () => ReturnType<typeof runHealthChecks>;
  rotateCredential: (
    vmId: string,
    opts: RotationOptions,
    actor: RotationActor,
  ) => Promise<RotationResult>;
  invalidateCache: () => void;
  cache: CoreCache;
}

export async function createCore(
  localConfig: LocalConfig,
  opts: { db: Pool; redis: IORedis; logger: Logger },
): Promise<CoreContext> {
  const db = opts.db;
  const redis = opts.redis;
  const logger = opts.logger;

  await runMigrations(db, logger);
  const usersService = new UsersService(db);
  await usersService.ensureSeeded();

  const masterKey = localConfig.secrets.masterKey;
  const keyId = localConfig.secrets.masterKeyId;

  const encrypt = (plaintext: string): string => encryptSecret(masterKey, keyId, plaintext).ciphertext;
  const decrypt = (stored: string): string => decryptSecret(masterKey, stored).plaintext;

  const cache: CoreCache = {
    proxmoxClient: null,
    proxmoxClientAt: 0,
    guacDb: null,
    guacDbAt: 0,
    guacApi: null,
  };
  // Disabling TLS verification exposes the API token and all traffic to any
  // on-path attacker. It stays permitted for self-signed homelab certs, but
  // each affected integration warns exactly once per process so the insecure
  // posture is visible instead of silent.
  let warnedProxmoxTls = false;
  let warnedPbsTls = false;

  const settings = new SettingsService(db, encrypt, decrypt);
  const audit = new AuditService(db);
  const hostKeys = new HostKeyService({ db, audit, logger });
  const ctx: CoreContext = {
    localConfig,
    db,
    redis,
    logger,
    settings,
    audit,
    users: usersService,
    registration: new RegistrationService(db, usersService),
    sessions: new SessionsService(
      db,
      localConfig.app.sessionDurationHours,
      localConfig.app.sessionIdleTimeoutMinutes,
      localConfig.secrets.sessionSigningKey,
    ),
    vms: new VmsRepository(db),
    creds: new CredentialsService(db, encrypt),
    templates: new TemplatesService(db),
    jobs: new JobsRepository(db),
    hostKeys,
    guac: new GuacamoleService({ db, encrypt, decrypt, hostKeys }),
    encrypt,
    decrypt,
    cache,
    invalidateCache: () => {
      cache.proxmoxClient = null;
      cache.guacApi = null;
      if (cache.guacDb) {
        const stale = cache.guacDb;
        cache.guacDb = null;
        void stale.close().catch(() => undefined);
      }
    },
    getProxmoxClient: async () => {
      if (cache.proxmoxClient && Date.now() - cache.proxmoxClientAt < 60000) {
        return cache.proxmoxClient;
      }
      const s = await settings.proxmox();
      if (!s || !s.url || !s.tokenId || !s.tokenSecret) {
        throw new AppError(
          "CONFIGURATION_ERROR",
          "Proxmox is not configured. Complete setup in Settings.",
          400,
        );
      }
      if (!s.verifySsl && !warnedProxmoxTls) {
        warnedProxmoxTls = true;
        logger.warn({}, "Proxmox TLS certificate verification is DISABLED (verifySsl=false): the API token and all traffic are exposed to network attackers. Install a trusted certificate or enable verifySsl.");
      }
      cache.proxmoxClient = new ProxmoxClient({
        url: s.url,
        tokenId: s.tokenId,
        tokenSecret: s.tokenSecret,
        verifySsl: s.verifySsl,
      });
      cache.proxmoxClientAt = Date.now();
      return cache.proxmoxClient;
    },
    getGuacDb: async () => {
      if (cache.guacDb && Date.now() - cache.guacDbAt < 60000) {
        return cache.guacDb.client;
      }
      if (cache.guacDb) {
        const stale = cache.guacDb;
        cache.guacDb = null;
        void stale.close().catch(() => undefined);
      }
      const g = await settings.guacamole();
      if (!g) {
        throw new AppError(
          "CONFIGURATION_ERROR",
          "Guacamole is not configured. Complete setup in Settings.",
          400,
        );
      }
      const parsed = parseDbHost(g.dbHost);
      const created = createGuacamoleDbClient({
        engine: g.engine,
        dbHost: parsed.host,
        dbPort: parsed.port ?? g.dbPort,
        dbName: g.dbName,
        dbUser: g.dbUser,
        dbPassword: g.dbPassword,
        dbSsl: g.dbSsl,
      });
      cache.guacDb = { client: created.client, close: created.close };
      cache.guacDbAt = Date.now();
      return cache.guacDb.client;
    },
    getGuacApi: async () => {
      if (cache.guacApi !== null) return cache.guacApi;
      const g = await settings.guacamole();
      if (!g) return null;
      cache.guacApi = new GuacamoleApiClient(g.url);
      return cache.guacApi;
    },
    getCloudflareClient: async () => {
      const config = await getCloudflareConfig(settings);
      if (!config.apiToken) {
        throw new AppError(
          "CONFIGURATION_ERROR",
          "Cloudflare is not configured. Set PROXVM_CLOUDFLARE_API_TOKEN or save an API token on the Domains page.",
          400,
        );
      }
      return new CloudflareClient({ token: config.apiToken });
    },
    getPbsClient: async () => {
      const s = await settings.pbs();
      if (!s) return null;
      if (!s.verifySsl && !warnedPbsTls) {
        warnedPbsTls = true;
        logger.warn({}, "Proxmox Backup Server TLS certificate verification is DISABLED (verifySsl=false): credentials and traffic are exposed to network attackers. Install a trusted certificate or enable verifySsl.");
      }
      return new ProxmoxBackupClient({
        url: s.url,
        tokenId: s.tokenId,
        tokenSecret: s.tokenSecret,
        verifySsl: s.verifySsl,
      });
    },
    verifyDomain: async (fqdn: string): Promise<DomainVerification> => verifyDomainReachability(fqdn),
    runHealthChecks: async () =>
      runHealthChecks({
        db,
        redis,
        logger,
        settings,
        getProxmoxClient: ctx.getProxmoxClient,
        getGuacDb: ctx.getGuacDb,
        getGuacApi: ctx.getGuacApi,
      }),
    rotateCredential: (vmId, opts, actor) =>
      rotateVmCredential(
        {
          db,
          logger,
          settings,
          vms: ctx.vms,
          creds: ctx.creds,
          guac: ctx.guac,
          audit: ctx.audit,
          decrypt,
          hostKeys: ctx.hostKeys,
          getProxmoxClient: ctx.getProxmoxClient,
          getGuacDb: ctx.getGuacDb,
        },
        vmId,
        opts,
        actor,
      ),
  };
  return ctx;
}

export { runMigrations };
export type { Logger } from "./util/logger.js";
export type { LocalConfig } from "@proxvm/shared";