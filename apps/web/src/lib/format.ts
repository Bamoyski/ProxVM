/* =====================================================================
 * Formatting helpers shared by every page. One implementation of bytes,
 * uptime, time rendering, day names — no more per-page copies.
 * ===================================================================== */

export function fmtBytes(n: unknown, decimals?: number): string {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n);
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  const d = decimals ?? (v >= 100 || u === 0 ? 0 : 1);
  return `${v.toFixed(d)} ${units[u]}`;
}

export function fmtUptime(seconds: unknown): string {
  const s = Number(seconds);
  if (!s || s <= 0 || !Number.isFinite(s)) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtDateTime(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtDate(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function fmtClock(value: string | number | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Short relative time: "just now", "4m ago", "3h ago", "12d ago". */
export function fmtRelative(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const ms = Date.now() - d.getTime();
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return "just now";
  const suffix = ms >= 0 ? " ago" : "";
  if (mins < 60) return `${mins}m${suffix}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h${suffix}`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d${suffix}`;
  return fmtDate(d);
}

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export function fmtDays(days: string | null | undefined): string {
  if (!days || days === "*" || days.split(",").length === 7) return "Every day";
  const list = days.split(",").filter(Boolean);
  const weekend = list.length === 2 && list.includes("Sat") && list.includes("Sun");
  if (weekend) return "Weekends";
  const weekdays = list.length === 5 && ["Mon", "Tue", "Wed", "Thu", "Fri"].every((d) => list.includes(d));
  if (weekdays) return "Weekdays";
  return list.map((d) => DAYS.find((x) => x.startsWith(d)) ?? d).join(", ");
}

/** "HH:MM" from hour+minute numbers (zero-padded). */
export function fmtHM(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** UTC hour/minute rendered in the browser's timezone, with both noted. */
export function utcHMToLocal(hour: number, minute: number): string {
  const now = new Date();
  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute));
  return utc.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Short id for display: first 8 chars of a uuid/jobid. */
export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "—";
}

/** Masked secret rendering (never the real value). */
export function masked(): string {
  return "••••••••••••••••";
}

/** Build an ISO string Date.now()+ms from a select value like "1h"/"1d"/"1w". */
export function expiryIso(preset: string, custom?: string): string | undefined {
  if (!preset) return undefined;
  if (preset === "custom") {
    if (!custom) return undefined;
    const d = new Date(custom);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const ms = preset === "1h" ? 3_600_000 : preset === "1d" ? 86_400_000 : 7 * 86_400_000;
  return new Date(Date.now() + ms).toISOString();
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Percent helper: null-safe. */
export function pct(used: unknown, max: unknown): number | null {
  if (used === null || used === undefined || !max) return null;
  return Math.min(100, (Number(used) / Number(max)) * 100);
}
