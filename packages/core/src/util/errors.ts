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

  withDetails(details: Record<string, unknown>): this {
    this.details = details;
    return this;
  }

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

  static external(service: string, message: string, cause?: unknown): AppError {
    return new AppError("EXTERNAL_SERVICE_ERROR", `${service}: ${message}`, 502, cause);
  }
}