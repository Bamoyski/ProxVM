/**
 * Proxmox Backup Server client — BASELINE STRUCTURE ONLY.
 *
 * No PBS instance exists in this infrastructure yet, so every method below
 * is shaped against the public PBS API2 surface but verified ONLY against
 * mocked HTTP (see pbs-client.test.ts). Nothing in the running app calls a
 * live PBS; `getPbsClient()` returns null until settings are configured, and
 * the only wired endpoint (`GET /pbs/status`) reports reachability without
 * mutating anything.
 *
 * When PBS comes up: fill in settings (UI still to be built), flip the
 * status check green, then implement backup scheduling on top of
 * listDatastores()/backupGroupSnapshots()/startBackup().
 */

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

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export class ProxmoxBackupClient {
  private readonly baseUrl: string;
  private readonly tokenId: string;
  private readonly tokenSecret: string;
  private readonly verifySsl: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ProxmoxBackupClientOptions) {
    if (!opts.url) throw new ProxmoxBackupApiError("PBS url is required", 400);
    if (!opts.tokenId || !opts.tokenSecret) {
      throw new ProxmoxBackupApiError("PBS API token id and secret are required", 400);
    }
    this.baseUrl = stripTrailingSlashes(opts.url);
    this.tokenId = opts.tokenId;
    this.tokenSecret = opts.tokenSecret;
    // NOTE: verifySsl is accepted for API parity with ProxmoxClient, but the
    // default fetch path cannot disable TLS verification per-request. Real
    // deployments terminate PBS behind trusted certs or a reverse proxy;
    // self-signed direct support is intentionally left for the live phase.
    this.verifySsl = opts.verifySsl ?? true;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api2/json${path}`, {
        method: init?.method ?? "GET",
        headers: {
          Authorization: `PBSAPIToken=${this.tokenId}=${this.tokenSecret}`,
          Accept: "application/json",
          ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new ProxmoxBackupApiError(
        "Cannot reach the Proxmox Backup Server. It may be down, unreachable, or rejecting TLS.",
        0,
        { cause: err instanceof Error ? `${err.name}: ${err.message}` : String(err) },
      );
    } finally {
      clearTimeout(timer);
    }
    type Envelope = { success?: boolean; data?: T; errors?: unknown; message?: string };
    let json: Envelope | null = null;
    try {
      json = (await response.json()) as Envelope;
    } catch {
      throw new ProxmoxBackupApiError(
        `PBS returned a non-JSON response (HTTP ${response.status})`,
        response.status,
      );
    }
    if (!response.ok) {
      throw new ProxmoxBackupApiError(
        typeof json?.message === "string" && json.message
          ? json.message
          : `PBS request failed (HTTP ${response.status})`,
        response.status,
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
   * Kick off a backup. SHAPE ONLY — not called anywhere yet. The real flow
   * (guest qemu backup via PVE → PBS datastore, UPID tracking, verify) gets
   * built against a live PBS in the next phase.
   */
  async startBackup(_args: {
    datastore: string;
    node: string;
    vmid: number;
    mode?: "snapshot" | "suspend" | "stop";
  }): Promise<{ upid: string }> {
    void _args;
    throw new ProxmoxBackupApiError("Backup execution is not wired yet (PBS integration baseline)", 501);
  }
}
