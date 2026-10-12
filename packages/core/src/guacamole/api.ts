/* ---------------------------------------------------------------------------
 * guacamole/api.ts — Guacamole web-API client (tokens, listing, launch URLs).
 *
 * Talks to /api/tokens and the session-data tree over 15s-abort fetches.
 * Error messages deliberately omit host/URL (they surface to normal users
 * via launch fallbacks); the configured URL stays visible to admins only.
 * Client-identifier encoding must mirror the web client's toString(), or the
 * tunnel connect fails with HTTP 400 on garbage-decoded identifiers.
 * ------------------------------------------------------------------------- */
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

// --- Token + connection client ------------------------------------------------
import { stripTrailingSlashes } from "../util/misc.js";

/** Thin wrapper over the Guacamole REST surface ProxVM needs. */
export class GuacamoleApiClient {
  constructor(private readonly baseUrl: string) {}

  private get url(): string {
    return stripTrailingSlashes(this.baseUrl);
  }

  /**
   * Exchange a username+password for a Guacamole auth token (login). Throws
   * GuacamoleApiError on transport failure or non-2xx; the response body is
   * truncated to 300 chars so a verbose error page can't flood the caller.
   */
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

  /**
   * List stored connections for one data source. WHY Object.values().flat():
   * Guacamole groups the map by parent identifier, so entries arrive nested
   * one level deeper than the flat list callers actually need.
   */
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

  /**
   * Resolve a stored connection's numeric identifier by display name. Exact
   * match only — Guacamole names are unique per data source, and fuzzy
   * matching could launch the wrong guest's session.
   */
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
  const raw = Buffer.from([identifier, type, dataSource].join(String.fromCharCode(0)), "utf8").toString("base64");
  // URL-safe base64 without regex: split/join is linear, while the old
  // chain (notably /=+$/ on attacker-influenced connection names) risked
  // quadratic backtracking (CodeQL polynomial-redos). Padding occurs only
  // at the end of base64 output, so the manual loop below strips at most
  // the trailing run — identical result, no backtracking possible.
  let end = raw.length;
  while (end > 0 && raw.charCodeAt(end - 1) === 61 /* "=" */) end--;
  return raw.slice(0, end).split("+").join("-").split("/").join("_");
}

/**
 * Build a `#/client/` launch URL for a stored connection. The auth token
 * rides in the query string (Guacamole web-client convention); leaking that
 * URL equals session hijack, so callers never log or persist it.
 */
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

/**
 * Base login URL for the Guacamole web app (fallback when direct launch
 * fails). Trailing slashes are stripped so concatenation never yields `//`.
 */
export function buildLoginUrl(guacamoleUrl: string): string {
  return `${stripTrailingSlashes(guacamoleUrl)}/`;
}

// --- Response helper -----------------------------------------------------------
// WHY swallow body errors: the error path must never throw its own error and
// mask the login failure it is trying to report — empty string is enough.
async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}