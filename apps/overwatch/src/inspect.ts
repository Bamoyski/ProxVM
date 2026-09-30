/**
 * Pure helpers for Overwatch. No I/O here so every rule below is unit-tested:
 * the SQL gate, the docker demux stripper, and the bearer parser.
 */

/** Statements allowed through the read-only SQL console. */
export function isReadOnlyStatement(sql: string): boolean {
  return /^\s*(select|with|explain|show|values|table)\b/i.test(sql);
}

/** Authorization: Bearer <token>, case-insensitive scheme, single token. */
export function parseBearerToken(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] ?? "" : (header ?? "");
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(value);
  return match ? (match[1] as string) : "";
}

/**
 * Strip Docker's multiplexed stream framing (8-byte header per frame:
 * 1B stream type, 3B zero, 4B big-endian length). TTY/plain logs have no
 * framing and pass through untouched. Malformed tails are dropped, never
 * throw.
 */
export function stripDockerStream(buf: Buffer): string {
  if (buf.length < 8) return buf.toString("utf8");
  const looksFramed =
    buf[0]! <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0 && buf.readUInt32BE(4) <= buf.length;
  if (!looksFramed) return buf.toString("utf8");
  const parts: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i]!;
    const zeros = buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 0;
    if (type > 2 || !zeros) break;
    const len = buf.readUInt32BE(i + 4);
    const start = i + 8;
    const end = Math.min(start + len, buf.length);
    parts.push(buf.subarray(start, end));
    if (end - start < len) break;
    i = end;
  }
  return Buffer.concat(parts).toString("utf8");
}
