import { randomUUID as cryptoRandomUUID } from "node:crypto";

export const newId = (): string => cryptoRandomUUID();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the value is shaped like a UUID. Repositories use this to turn
 *  malformed IDs into clean "not found" results instead of leaking database
 *  cast errors as HTTP 500s. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : d;
}

export function parseDbHost(raw: string): { host: string; port: number | undefined } {
  const value = (raw ?? "").trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return { host: url.hostname, port: url.port ? Number(url.port) : undefined };
    } catch {
      return { host: value, port: undefined };
    }
  }
  return { host: value, port: undefined };
}

export function normalizeHttpBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(
      `"${raw}" is not a valid URL. Use the full Guacamole base URL, e.g. http://192.168.1.22:8080/guacamole`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported protocol "${url.protocol}" — use http:// or https://`);
  }
  return url.origin + (url.pathname.replace(/\/+$/, ""));
}