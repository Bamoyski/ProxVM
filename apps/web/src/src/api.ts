export interface ApiError {
  code: string;
  message: string;
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}



export interface AuthorizationExplanation {
  allowed: boolean;
  reason: string;
  permission?: string | string[];
}

export class ApiRequestError extends Error {
  code: string;
  statusCode: number;
  explanation: AuthorizationExplanation | null;
  constructor(code: string, message: string, statusCode: number, explanation?: AuthorizationExplanation | null) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.explanation = explanation ?? null;
  }
}

/**
 * Friendly fallback when the server gave us no usable message — proxy HTML
 * error pages, edge timeouts, dead backends. Server-provided JSON messages
 * always win (login errors, validation, denials); this only replaces raw
 * "HTTP 502"-style text end users can't act on.
 */
export function friendlyHttpMessage(statusCode: number): string {
  switch (statusCode) {
    case 401:
      return "Your session expired — please log in again.";
    case 404:
      return "Not found — it may have been deleted.";
    case 429:
      return "Too many attempts — wait a minute and retry.";
    case 502:
    case 503:
    case 504:
      return "ProxVM is briefly unavailable — retry in a few seconds.";
    case 524:
      return "The operation is still running on the server — wait a moment and refresh.";
    default:
      return statusCode >= 500
        ? "Something went wrong on the server — retry, and contact an administrator if it persists."
        : "Request failed — retry, and contact an administrator if it persists.";
  }
}

/** Human-readable rendering of a safe authorization explanation. */
export function explainDenial(err: unknown): string | null {
  if (!(err instanceof ApiRequestError) || !err.explanation || err.explanation.allowed) return null;
  const { reason, permission } = err.explanation;
  const perm = Array.isArray(permission) ? permission.join(" or ") : (permission ?? "the required permission");
  switch (reason) {
    case "missing_permission":
      return `Missing permission: ${perm}.`;
    case "missing_vm_access":
      return "No access to this VM. Ask an administrator to grant it.";
    case "access_expired":
      return "Your access to this VM has expired. Ask an administrator to renew it.";
    case "protocol_denied":
      return `This protocol is not enabled for you${perm && perm !== "the required permission" ? ` (requires ${perm})` : ""}.`;
    case "inactive_user":
      return "Your account is disabled.";
    default:
      return null;
  }
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (csrfToken && method !== "GET") headers["X-CSRF-Token"] = csrfToken;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: "same-origin",
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    // Network-level failure (server down, DNS, offline): fetch throws with
    // no status at all. Previously this surfaced as "Failed to fetch".
    throw new ApiRequestError("NETWORK_ERROR", "Cannot reach ProxVM — check your connection and retry.", 0);
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = data as { code?: string; message?: string; explanation?: AuthorizationExplanation } | null;
    const message =
      typeof err?.message === "string" && err.message.trim()
        ? err.message
        : friendlyHttpMessage(res.status);
    throw new ApiRequestError(err?.code ?? "ERROR", message, res.status, err?.explanation ?? null);
  }
  return data as T;
}

export async function login(username: string, password: string): Promise<{ csrfToken: string }> {
  const res = await api<{ csrfToken: string }>("/auth/login", { method: "POST", body: { username, password } });
  setCsrfToken(res.csrfToken);
  return res;
}

export async function logout(): Promise<void> {
  await api("/auth/logout", { method: "POST", body: {} });
  setCsrfToken(null);
}

export function jobEventSource(
  jobId: string,
  onProgress: (data: unknown) => void,
  onDone?: () => void,
  onError?: (err: Error) => void,
): EventSource {
  const es = new EventSource(`/api/jobs/${jobId}/events`);
  const fail = (err: Error): void => {
    try {
      es.close();
    } catch {
      // ignore close errors; the stream is already unusable
    }
    onError?.(err);
    onDone?.();
  };
  es.addEventListener("progress", (ev) => {
    let data: { status?: string; step?: string | null; message?: string };
    try {
      data = JSON.parse((ev as MessageEvent).data) as typeof data;
    } catch {
      fail(new Error("Received an unreadable job progress event"));
      return;
    }
    onProgress(data);
    if (data.status && ["READY", "FAILED", "CANCELLED"].includes(data.status)) {
      try {
        es.close();
      } catch {
        // ignore close errors on terminal states
      }
      onDone?.();
    }
  });
  // Without this, a dead stream (Redis down, 403, network loss) retries
  // forever while the UI sits on "Connecting…" and hammers the API.
  es.onerror = () => {
    fail(new Error("Job event stream unavailable; use Refresh or Watch again shortly."));
  };
  return es;
}