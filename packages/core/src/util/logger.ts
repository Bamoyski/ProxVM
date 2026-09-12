export interface Logger {
  trace(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export function getLogLevel(): LogLevel {
  const raw = process.env.PROXVM_LOG_LEVEL ?? "info";
  return LEVEL_ORDER[raw as LogLevel] !== undefined ? (raw as LogLevel) : "info";
}

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

export function makeLogger(name: string, bindings: Record<string, unknown> = {}): Logger {
  return new ConsoleLogger(getLogLevel(), { logger: name, ...bindings });
}

export function redactMessage(msg: string, secrets: string[]): string {
  let out = msg;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[REDACTED]");
  }
  return out;
}