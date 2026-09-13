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

/** Remove trailing "/" characters in linear time.
 *
 *  This replaces the `/\/+$/` pattern, which backtracks quadratically on
 *  slash-heavy inputs (CodeQL js/polynomial-redos). Behavior is identical
 *  for every input except one degenerate case: a trailing line terminator
 *  (e.g. `"https://host//\n"`) also anchored `$` for the old regex, so the
 *  old code stripped the slashes but left the newline. The helper only
 *  strips "/" and leaves such inputs untouched — both forms are invalid as
 *  base URLs and fail downstream validation either way.
 */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f /* "/" */) end--;
  return value.slice(0, end);
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
  return url.origin + stripTrailingSlashes(url.pathname);
}