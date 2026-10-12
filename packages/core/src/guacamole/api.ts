export class GuacamoleApiError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "GuacamoleApiError";
    this.cause = cause;
  }
}

export interface GuacamoleToken {
  authToken: string;
  username: string;
  dataSource: string;
  availableDataSources: string[];
}

import { stripTrailingSlashes } from "../util/misc.js";

export class GuacamoleApiClient {
  constructor(private readonly baseUrl: string) {}

  private get url(): string {
    return stripTrailingSlashes(this.baseUrl);
  }

  async requestToken(username: string, password: string): Promise<GuacamoleToken> {
    let response: Response;
    try {
      response = await fetch(`${this.url}/api/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username, password }).toString(),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      // No host/URL in the message: it is surfaced to normal users through
      // launch fallbacks. The configured URL stays visible to admins in
      // Settings and in server logs.
      throw new GuacamoleApiError(
        "Cannot reach the Guacamole web application.",
        err,
      );
    }
    if (!response.ok) {
      throw new GuacamoleApiError(
        `Guacamole rejected the login (HTTP ${response.status}): ${(await safeText(response)).slice(0, 300)}`,
      );
    }
    const payload = (await response.json()) as Record<string, unknown>;
    if (!payload.authToken || !payload.username || !payload.dataSource) {
      throw new GuacamoleApiError(
        "Guacamole returned an unrecognized token response. Ensure the Guacamole version supports /api/tokens (1.4+).",
      );
    }
    return {
      authToken: String(payload.authToken),
      username: String(payload.username),
      dataSource: String(payload.dataSource),
      availableDataSources: Array.isArray(payload.availableDataSources)
        ? payload.availableDataSources.map(String)
        : [],
    };
  }

  /**
   * Invalidate a previously issued auth token (logout). Guacamole also
   * expires tokens on its own `api-session-timeout`; failure here is
   * non-fatal for callers, which treat it as best-effort.
   */
  async deleteToken(token: string): Promise<void> {
    const response = await fetch(`${this.url}/api/tokens/${encodeURIComponent(token)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok && response.status !== 404) {
      throw new GuacamoleApiError(`Guacamole token invalidation failed (HTTP ${response.status})`);
    }
  }

  async fetchConnections(token: string, dataSource: string): Promise<Array<{ identifier: string; name: string; protocol: string }>> {
    const response = await fetch(
      `${this.url}/api/session/data/${encodeURIComponent(dataSource)}/connections?token=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok) {
      throw new GuacamoleApiError(`Guacamole connection listing failed (HTTP ${response.status})`);
    }
    const payload = (await response.json()) as Record<string, Array<Record<string, unknown>>>;
    const entries = Object.values(payload).flat();
    return entries.map((entry) => ({
      identifier: String(entry.identifier ?? ""),
      name: String(entry.name ?? ""),
      protocol: String(entry.protocol ?? ""),
    }));
  }

  async findConnectionIdentifier(token: string, dataSource: string, connectionName: string): Promise<string | null> {
    const connections = await this.fetchConnections(token, dataSource);
    const match = connections.find((c) => c.name === connectionName);
    return match?.identifier ?? null;
  }
}

/**
 * Client-identifier type for a stored connection. The web client only
 * launches connection objects through direct URLs; groups and active
 * connections are never linked this way.
 */
export type GuacClientObjectType = "c" | "g" | "a";

/**
 * Encodes a `#/client/` identifier the way the Guacamole web client builds
 * them (`ClientIdentifier.toString()`): base64 of
 * `identifier + "\0" + type + "\0" + dataSource`, made URL-safe by swapping
 * `+`/`/` for `-`/`_` and stripping `=` padding.
 *
 * Passing the raw numeric connection id (e.g. `#/client/14`) does NOT work:
 * the client base64-decodes it into garbage (id becomes `×`, type and data
 * source become `undefined`) and the tunnel connect fails with HTTP 400.
 */
export function encodeClientIdentifier(
  identifier: string,
  dataSource: string,
  type: GuacClientObjectType = "c",
): string {
  return Buffer.from([identifier, type, dataSource].join(String.fromCharCode(0)), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function buildClientLaunchUrl(
  guacamoleUrl: string,
  identifier: string,
  authToken: string,
  dataSource: string,
  type: GuacClientObjectType = "c",
): string {
  const encoded = encodeClientIdentifier(identifier, dataSource, type);
  return `${stripTrailingSlashes(guacamoleUrl)}/#/client/${encoded}?token=${encodeURIComponent(authToken)}`;
}

export function buildLoginUrl(guacamoleUrl: string): string {
  return `${stripTrailingSlashes(guacamoleUrl)}/`;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}