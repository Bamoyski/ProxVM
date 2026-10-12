/**
 * Proxmox Backup Server client.
 *
 * Live against the PBS API2 surface: version/datastore/group reads are used
 * by the running app (status checks and future backup scheduling); only
 * startBackup() remains a stub for the next phase.
 *
 * Transport mirrors ProxmoxClient (raw node http/https honoring
 * per-request TLS verification, optional fetch injection for tests).
 * Auth header is `PBSAPIToken=id:secret` (COLON) — the PVE-style `=` form
 * yields `invalid token name` from PBS, and token AND user ACLs intersect,
 * so both must grant access.
 */
import https from "node:https";
import http from "node:http";
import { stripTrailingSlashes } from "../util/misc.js";

export class ProxmoxBackupApiError extends Error {
  readonly statusCode: number;
  readonly detail: unknown;
  constructor(message: string, statusCode: number, detail: unknown = null) {
    super(message);
    this.name = "ProxmoxBackupApiError";
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

// --- Option + result shapes ----------------------------------------------------
export interface ProxmoxBackupClientOptions {
  url: string;
  tokenId: string;
  tokenSecret: string;
  /** Self-signed PBS certificates are the norm in homelabs; default off. */
  verifySsl?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface PbsDatastore {
  name: string;
  path?: string;
  comment?: string;
}

export interface PbsSnapshot {
  backupId: string;
  backupTime: number;
  size?: number | null;
  files?: unknown;
}

interface HttpResult {
  status: number;
  text: string;
}

/** Same transport as ProxmoxClient: honors per-request TLS verification. */
function nodeHttpRequest(
  target: string,
  opts: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    rejectUnauthorized: boolean;
    timeoutMs: number;
  },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const request = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? "443" : "80"),
        path: `${url.pathname}${url.search}`,
        method: opts.method,
        headers: opts.headers,
        rejectUnauthorized: opts.rejectUnauthorized,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.setTimeout(opts.timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${opts.timeoutMs}ms`));
    });
    request.on("error", reject);
    if (opts.body !== undefined) request.write(opts.body);
    request.end();
  });
}

// --- Client ----------------------------------------------------------------------
export class ProxmoxBackupClient {
  private readonly baseUrl: string;
  private readonly tokenId: string;
  private readonly tokenSecret: string;
  private readonly verifySsl: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch | null;

  constructor(opts: ProxmoxBackupClientOptions) {
    if (!opts.url) throw new ProxmoxBackupApiError("PBS url is required", 400);
    if (!opts.tokenId || !opts.tokenSecret) {
      throw new ProxmoxBackupApiError("PBS API token id and secret are required", 400);
    }
    this.baseUrl = stripTrailingSlashes(opts.url);
    this.tokenId = opts.tokenId;
    this.tokenSecret = opts.tokenSecret;
    this.verifySsl = opts.verifySsl ?? true;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.fetchImpl = opts.fetchImpl ?? null;
  }

  private headers(body?: unknown): Record<string, string> {
    const h: Record<string, string> = {
      // WHY `=` between scheme and id but `:` before the secret: PBS parses
      // `PBSAPIToken=id:secret`; using `=` twice produces `invalid token
      // name` and a permanently failing client that looks like bad creds.
      Authorization: `PBSAPIToken=${this.tokenId}:${this.tokenSecret}`,
      Accept: "application/json",
    };
    if (body !== undefined) {
      const serialized = JSON.stringify(body);
      h["Content-Type"] = "application/json";
      h["Content-Length"] = String(Buffer.byteLength(serialized));
    }
    return h;
  }

  // WHY two transports: production uses node http(s) so self-signed PBS
  // certs can be honored per request via rejectUnauthorized; fetchImpl exists
  // only so tests can inject a stub without opening sockets.
  private async httpRequest(path: string, init?: { method?: string; body?: unknown }): Promise<HttpResult> {
    const method = init?.method ?? "GET";
    const serialized = init?.body !== undefined ? JSON.stringify(init.body) : undefined;
    const headers = this.headers(init?.body);
    if (!this.fetchImpl) {
      try {
        return await nodeHttpRequest(`${this.baseUrl}/api2/json${path}`, {
          method,
          headers,
          body: serialized,
          rejectUnauthorized: this.verifySsl,
          timeoutMs: this.timeoutMs,
        });
      } catch (err) {
        throw new ProxmoxBackupApiError(
          "Cannot reach the Proxmox Backup Server. It may be down, unreachable, or rejecting TLS.",
          0,
          { cause: err instanceof Error ? `${err.name}: ${err.message}` : String(err) },
        );
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api2/json${path}`, {
        method,
        headers,
        body: serialized,
        signal: controller.signal,
      });
      return { status: response.status, text: await response.text() };
    } catch (err) {
      throw new ProxmoxBackupApiError(
        "Cannot reach the Proxmox Backup Server. It may be down, unreachable, or rejecting TLS.",
        0,
        { cause: err instanceof Error ? `${err.name}: ${err.message}` : String(err) },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const { status, text } = await this.httpRequest(path, init);
    type Envelope = { success?: boolean; data?: T; errors?: unknown; message?: string };
    let json: Envelope | null = null;
    try {
      json = (text ? JSON.parse(text) : null) as Envelope;
    } catch {
      throw new ProxmoxBackupApiError(
        `PBS returned a non-JSON response (HTTP ${status})`,
        status,
      );
    }
    if (status < 200 || status >= 300) {
      throw new ProxmoxBackupApiError(
        typeof json?.message === "string" && json.message
          ? json.message
          : `PBS request failed (HTTP ${status})`,
        status,
        json?.errors ?? json?.data ?? null,
      );
    }
    return (json?.data ?? null) as T;
  }

  /** Liveness + version. The `GET /pbs/status` endpoint uses only this. */
  async version(): Promise<{ version: string; release?: string; repoid?: string }> {
    return this.request("/version");
  }

  /** Backup datastores visible to this token. */
  async listDatastores(): Promise<PbsDatastore[]> {
    const result = await this.request<PbsDatastore[]>("/config/datastore");
    return Array.isArray(result) ? result : [];
  }

  /** Snapshot groups in a datastore (optionally filtered by backup-type/ID). */
  async listBackupGroups(datastore: string, query?: { type?: string; backupId?: string }): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (query?.type) params.set("backup-type", query.type);
    if (query?.backupId) params.set("backup-id", query.backupId);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const result = await this.request<unknown[]>(`/admin/datastore/${encodeURIComponent(datastore)}/groups${suffix}`);
    return Array.isArray(result) ? result : [];
  }

  /**
   * Kick off a backup. NOT implemented against PBS on purpose: VM backups
   * are initiated from the PVE side (vzdump toward a PBS-backed storage),
   * so execution lives in ProxmoxClient.createBackup(). This stub exists so
   * callers fail loudly instead of silently doing nothing.
   */
  async startBackup(_args: {
    datastore: string;
    node: string;
    vmid: number;
    mode?: "snapshot" | "suspend" | "stop";
  }): Promise<{ upid: string }> {
    void _args;
    throw new ProxmoxBackupApiError(
      "VM backups run through Proxmox VE (vzdump); use ProxmoxClient.createBackup()",
      501,
    );
  }

  /**
   * Prune snapshots of one backup group (e.g. backup-id "vm/137"),
   * keeping the newest keepLast. Returns the PBS task UPID; poll with
   * pbsTaskStatus(). Destructive by design — callers gate it behind
   * explicit retention settings and audit every invocation.
   */
  async pruneSnapshots(
    datastore: string,
    opts: { backupId: string; backupType?: string; keepLast: number },
  ): Promise<string> {
    const result = await this.request<string>(`/admin/datastore/${encodeURIComponent(datastore)}/prune`, {
      method: "POST",
      body: {
        "backup-id": opts.backupId,
        "backup-type": opts.backupType ?? "vm",
        "keep-last": opts.keepLast,
      },
    });
    return typeof result === "string" ? result : "";
  }

  /** Status of a PBS background task (prune/verify/GC). */
  async pbsTaskStatus(upid: string): Promise<{ status: string; exitstatus: string | null }> {
    const result = await this.request<{ status: string; exitstatus?: string | null }>(
      `/nodes/localhost/tasks/${encodeURIComponent(upid)}/status`,
    );
    return { status: String(result?.status ?? ""), exitstatus: result?.exitstatus ?? null };
  }
}
