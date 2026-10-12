/* ---------------------------------------------------------------------------
 * errors.ts — the single typed error for the whole backend (AppError).
 *
 * Every service throws AppError with a stable machine code + HTTP status;
 * the API layer maps code/status to responses. `cause` chains the low-level
 * failure for server logs only, while `details` carries the safe, user-facing
 * authorization explanation (never internals — no hostnames, SQL, traces).
 * ------------------------------------------------------------------------- */
export type AppErrorCode =
  | "NOT_IMPLEMENTED"
  | "SETUP_REQUIRED"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "CONFIGURATION_ERROR"
  | "EXTERNAL_SERVICE_ERROR"
  | "PROXMOX_ERROR"
  | "GUACAMOLE_ERROR"
  | "SSH_ERROR"
  | "PROVISIONING_ERROR"
  | "RATE_LIMITED"
  | "ACCOUNT_LOCKED"
  | "INTERNAL_ERROR";

export interface ErrorExplanation {
  allowed: false;
  reason: string;
  permission?: string | string[];
}

// --- AppError ---------------------------------------------------------------
/**
 * Typed operational error: code is the stable contract clients switch on,
 * statusCode drives the HTTP response, cause preserves the root failure for
 * logs. Prefer the static factories below so codes and statuses stay paired.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly statusCode: number;
  override readonly cause: unknown;
  /** Optional safe, user-facing authorization explanation (no internals). */
  details?: Record<string, unknown>;

  constructor(code: AppErrorCode, message: string, statusCode = 500, cause?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.cause = cause;
  }

  /**
   * Attach safe, user-facing context (e.g. which permission was missing).
   * WHY a separate opt-in field: message strings get logged and rendered in
   * varied shapes, while details stays structured for the UI to display.
   */
  withDetails(details: Record<string, unknown>): this {
    this.details = details;
    return this;
  }

  // --- Common factories (code + status stay paired; no ad-hoc numbers) ---
  static notFound(message = "Resource not found"): AppError {
    return new AppError("NOT_FOUND", message, 404);
  }

  static forbidden(message = "You do not have permission to perform this action"): AppError {
    return new AppError("FORBIDDEN", message, 403);
  }

  static unauthorized(message = "Authentication required"): AppError {
    return new AppError("UNAUTHORIZED", message, 401);
  }

  static validation(message: string): AppError {
    return new AppError("VALIDATION_ERROR", message, 400);
  }

  static conflict(message: string): AppError {
    return new AppError("CONFLICT", message, 409);
  }

  /**
   * Wrap a downstream failure (Proxmox/Guacamole/Cloudflare/PBS). WHY 502:
   * the fault is neither the client's (4xx) nor ours (500) — an upstream
   * dependency failed, and the service prefix tells which one at a glance.
   */
  static external(service: string, message: string, cause?: unknown): AppError {
    return new AppError("EXTERNAL_SERVICE_ERROR", `${service}: ${message}`, 502, cause);
  }
}