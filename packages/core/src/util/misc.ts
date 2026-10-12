/* ---------------------------------------------------------------------------
 * misc.ts — small shared helpers: ids, UUID guard, CSV encoding, URL utils.
 *
 * csvCell is the injection-sensitive one (formula-guard + quoting); the URL
 * helpers normalize operator-configured base URLs before any SSRF check, so
 * trailing-slash and scheme handling here directly affects connection tests.
 * Keep every helper pure and dependency-free for reuse in tests and scripts.
 * ------------------------------------------------------------------------- */
import { randomUUID as cryptoRandomUUID } from "node:crypto";

/** Mint a v4 UUID (primary keys, idempotency keys, share-link ids). */
export const newId = (): string => cryptoRandomUUID();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the value is shaped like a UUID. Repositories use this to turn
 *  malformed IDs into clean "not found" results instead of leaking database
 *  cast errors as HTTP 500s. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// --- Async helper ------------------------------------------------------------
/** Promise-based sleep for polling loops (task waits, agent retries). */
export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Single CSV cell encoder shared by every exporter. Two protections:
 * RFC-style quoting for structural characters, and a leading-quote guard
 * against spreadsheet formula injection (= + - @ and tab/CR prefixes
 * execute on import in Excel/Sheets).
 */
export function csvCell(value: unknown): string {
  const raw =
    value === null || value === undefined
      ? ""
      : String(value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : value);
  const text = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// --- Time formatting ---------------------------------------------------------
/** Current time as an ISO string (audit rows, API envelopes). */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Normalize a DB Date|string|null into an ISO string or null. WHY pass
 * strings through untouched: pg returns strings for timestamptz depending on
 * parsers, and re-parsing would risk shifting the instant; null stays null
 * so "never happened" remains distinguishable from epoch.
 */
export function toIso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : d;
}

// --- URL helpers -------------------------------------------------------------
/**
 * Split a configured DB host into host + optional port. Accepts bare
 * hostnames or full URLs; WHY the scheme sniff first: `new URL("db:5432")`
 * would misparse as scheme "db:", so only strings with `://` go near URL.
 */
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

/**
 * Normalize an operator-configured HTTP base URL to `origin + path`. WHY
 * reject non-http(s): the value is later fetched server-side, so ftp/file
 * or custom schemes must fail here, before the SSRF guard ever sees them.
 */
export function normalizeHttpBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(
      `"${raw}" is not a valid URL. Use the full Guacamole base URL, e.g. https://guacamole.example.com`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported protocol "${url.protocol}" — use http:// or https://`);
  }
  return url.origin + stripTrailingSlashes(url.pathname);
}