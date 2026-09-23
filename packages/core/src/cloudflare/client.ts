export class CloudflareApiError extends Error {
  readonly statusCode: number;
  readonly errors: unknown;
  constructor(message: string, statusCode: number, errors: unknown = null) {
    super(message);
    this.name = "CloudflareApiError";
    this.statusCode = statusCode;
    this.errors = errors;
  }
}

export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
}

export interface CloudflareDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

export interface CloudflareClientOptions {
  token: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class CloudflareClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CloudflareClientOptions) {
    if (!opts.token) throw new CloudflareApiError("Cloudflare API token is required", 400);
    this.baseUrl = (opts.baseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init?.method ?? "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new CloudflareApiError(
        `Cannot reach the Cloudflare API: ${err instanceof Error ? err.message : String(err)}`,
        0,
      );
    } finally {
      clearTimeout(timer);
    }
    type Envelope = { success?: boolean; errors?: Array<{ message?: string }>; result?: T };
    let json: Envelope | null = null;
    try {
      json = (await response.json()) as Envelope;
    } catch {
      throw new CloudflareApiError(`Cloudflare API returned a non-JSON response (HTTP ${response.status})`, response.status);
    }
    if (!response.ok || json === null || json.success === false) {
      const errors: Array<{ message?: string }> = Array.isArray(json?.errors) ? json.errors : [];
      const detail = errors.map((e) => e.message ?? "unknown").join("; ");
      throw new CloudflareApiError(
        `Cloudflare API error (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
        response.status,
        errors,
      );
    }
    return (json.result ?? null) as T;
  }

  /** Who-am-I check: proves the token works without touching anything. */
  async verifyToken(): Promise<{ id: string; status: string }> {
    return this.request<{ id: string; status: string }>("/user/tokens/verify");
  }

  async getZone(zoneId: string): Promise<CloudflareZone> {
    return this.request<CloudflareZone>(`/zones/${encodeURIComponent(zoneId)}`);
  }

  async listDnsRecords(zoneId: string): Promise<CloudflareDnsRecord[]> {
    const records = await this.request<CloudflareDnsRecord[]>(
      `/zones/${encodeURIComponent(zoneId)}/dns_records?per_page=100`,
    );
    return Array.isArray(records) ? records : [];
  }

  async createDnsRecord(
    zoneId: string,
    record: { type: string; name: string; content: string; proxied?: boolean; ttl?: number },
  ): Promise<CloudflareDnsRecord> {
    return this.request<CloudflareDnsRecord>(`/zones/${encodeURIComponent(zoneId)}/dns_records`, {
      method: "POST",
      body: { ttl: 1, proxied: true, ...record },
    });
  }

  async updateDnsRecord(
    zoneId: string,
    recordId: string,
    patch: { type?: string; name?: string; content?: string; proxied?: boolean; ttl?: number },
  ): Promise<CloudflareDnsRecord> {
    return this.request<CloudflareDnsRecord>(`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, {
      method: "PATCH",
      body: patch,
    });
  }
}
