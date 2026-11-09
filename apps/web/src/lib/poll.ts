/**
 * Poll cadence for a background query that must stay responsive while healthy
 * and go quiet while broken.
 *
 * `failures` is React Query's `fetchFailureCount`: consecutive failed fetches,
 * reset to 0 by the first success. Each failure doubles the interval up to a
 * hard cap.
 *
 * WHY the cap matters: the unread-count badge is polled by every open tab. If
 * a broken endpoint kept a flat 30s cadence, one failure becomes one request
 * every 30s per tab forever — error volume grows with uptime instead of with
 * usage, and a real outage is masked by the self-inflicted load.
 */
export const DEFAULT_POLL_MS = 30_000;
export const DEFAULT_POLL_CAP_MS = 5 * 60_000;
/** Stop doubling here: 30s → 1m → 2m → 4m → cap. */
const MAX_DOUBLINGS = 4;

export function backoffInterval(
  failures: number,
  { baseMs = DEFAULT_POLL_MS, capMs = DEFAULT_POLL_CAP_MS }: { baseMs?: number; capMs?: number } = {},
): number {
  if (!Number.isFinite(failures) || failures <= 0) return baseMs;
  const doublings = Math.min(Math.floor(failures), MAX_DOUBLINGS);
  return Math.min(baseMs * 2 ** doublings, capMs);
}
