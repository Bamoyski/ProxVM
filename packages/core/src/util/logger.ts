/* ---------------------------------------------------------------------------
 * logger.ts — tiny structured JSON logger (pino-style obj + msg signature).
 *
 * One JSON object per line on stdout (warn/error go to stderr so process
 * supervisors split severity streams). Level comes from PROXVM_LOG_LEVEL and
 * defaults to info; unknown values fall back to info rather than silencing
 * everything. Child loggers only add bindings — filtering stays level-based.
 * ------------------------------------------------------------------------- */
export interface Logger {
  trace(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

// --- Level ordering ----------------------------------------------------------
// WHY numeric ranks: string comparison can't express severity, and a table
// keeps the "unknown env value falls back to info" check in one place.
const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

/**
 * Read the active level from PROXVM_LOG_LEVEL. Unknown values return "info"
 * (fail-open for visibility) rather than "error" (which would hide warnings
 * over a typo) or throwing during early boot logging.
 */
export function getLogLevel(): LogLevel {
  const raw = process.env.PROXVM_LOG_LEVEL ?? "info";
  return LEVEL_ORDER[raw as LogLevel] !== undefined ? (raw as LogLevel) : "info";
}

// --- Console implementation --------------------------------------------------
class ConsoleLogger implements Logger {
  private readonly levelValue: number;
  private readonly bindings: Record<string, unknown>;

  constructor(level: LogLevel = "info", bindings: Record<string, unknown> = {}) {
    this.levelValue = LEVEL_ORDER[level];
    this.bindings = bindings;
  }

  private log(level: LogLevel, obj: Record<string, unknown>, msg?: string): void {
    if (LEVEL_ORDER[level] < this.levelValue) return;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      ...this.bindings,
      ...obj,
    };
    if (msg !== undefined) entry.msg = msg;
    const line = JSON.stringify(entry);
    // WHY stderr for warn/error: supervisors and `docker logs` split streams,
    // so alerting can watch stderr without ingesting every info line.
    const outs = level === "error" || level === "warn" ? process.stderr : process.stdout;
    outs.write(line + "\n");
  }

  trace(obj: Record<string, unknown>, msg?: string): void {
    this.log("trace", obj, msg);
  }

  debug(obj: Record<string, unknown>, msg?: string): void {
    this.log("debug", obj, msg);
  }

  info(obj: Record<string, unknown>, msg?: string): void {
    this.log("info", obj, msg);
  }

  warn(obj: Record<string, unknown>, msg?: string): void {
    this.log("warn", obj, msg);
  }

  error(obj: Record<string, unknown>, msg?: string): void {
    this.log("error", obj, msg);
  }

  child(bindings: Record<string, unknown>): Logger {
    return new ConsoleLogger(
      getLogLevel(),
      bindings,
    );
  }
}

/**
 * Build a named logger with optional fixed bindings (request id, service).
 * Child bindings are merged per line (bindings first, call fields win) so
 * request context never silently overrides the per-call payload.
 */
export function makeLogger(name: string, bindings: Record<string, unknown> = {}): Logger {
  return new ConsoleLogger(getLogLevel(), { logger: name, ...bindings });
}

/**
 * Best-effort secret scrubber for log strings. WHY the >= 4 gate: shorter
 * fragments (e.g. "a=") would redact half of every message; real tokens and
 * passwords are always longer, so tiny values are skipped, not trusted.
 */
export function redactMessage(msg: string, secrets: string[]): string {
  let out = msg;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[REDACTED]");
  }
  return out;
}