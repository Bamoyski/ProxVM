import net from "node:net";
import { probeSsh } from "../ssh/client.js";

export interface ConnectionTestResult {
  /** TCP session to hostname:port established. */
  reachable: boolean;
  /**
   * SSH only: whether the stored credentials authenticated. Null when no
   * credential check applies (RDP/VNC) or the endpoint was unreachable.
   */
  authenticated: boolean | null;
  /** Human-readable diagnosis. Never contains secrets. */
  detail: string;
}

/** Plain TCP connect with a bounded wait. Never throws. */
export function testTcp(host: string, port: number, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(value);
    };
    const sock = net.connect(port, host);
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on("connect", () => finish(true));
    sock.on("error", () => finish(false));
  });
}

/**
 * Minimal RDP X.224 Connection Request; true on a well-formed Connection
 * Confirm. Distinguishes a live RDP stack from a wedged listener that
 * accepts TCP but never speaks RDP. Never throws.
 */
export function testRdpHandshake(host: string, port: number, timeoutMs = 10000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const chunks: Buffer[] = [];
    const finish = (value: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(value);
    };
    const variable = Buffer.concat([
      Buffer.from("Cookie: mstshash\r\n", "ascii"),
      Buffer.from([0x01, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00, 0x00]),
    ]);
    const li = 6 + variable.length;
    const tpktLen = 4 + 1 + li;
    const request = Buffer.concat([
      Buffer.from([0x03, 0x00, (tpktLen >> 8) & 0xff, tpktLen & 0xff]),
      Buffer.from([li, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00]),
      variable,
    ]);
    const sock = net.connect(port, host);
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on("connect", () => sock.write(request));
    sock.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const data = Buffer.concat(chunks);
      if (data.length >= 7 && data[5] === 0xd0) finish(true);
    });
    sock.on("close", () => {
      const data = Buffer.concat(chunks);
      finish(data.length >= 7 && data[5] === 0xd0);
    });
    sock.on("error", () => finish(false));
  });
}

export async function testConnection(opts: {
  protocol: string;
  hostname: string;
  port: number;
  username?: string;
  password?: string;
  timeoutMs?: number;
}): Promise<ConnectionTestResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const open = await testTcp(opts.hostname, opts.port, timeoutMs);
  if (!open) {
    return {
      reachable: false,
      authenticated: null,
      detail: `TCP connection to ${opts.hostname}:${opts.port} failed (refused or timed out). The guest may be down, the IP stale, or a firewall in the way.`,
    };
  }
  if (opts.protocol === "ssh" && opts.username && opts.password) {
    const result = await probeSsh({
      host: opts.hostname,
      port: opts.port,
      username: opts.username,
      password: opts.password,
      timeoutMs: 10000,
    });
    if (result.status === "AUTHENTICATED") {
      return { reachable: true, authenticated: true, detail: "SSH authentication succeeded with the stored credential." };
    }
    return {
      reachable: true,
      authenticated: false,
      detail: `SSH is reachable but authentication failed (${result.detail}). The guest password likely drifted from the vault — rotate it from the VM page.`,
    };
  }
  if (opts.protocol === "rdp") {
    const live = await testRdpHandshake(opts.hostname, opts.port, timeoutMs);
    return live
      ? {
          reachable: true,
          authenticated: null,
          detail:
            "RDP endpoint answered the handshake. If sessions still fail, the fault is inside the guest (xrdp/NLA/session) — check its xrdp logs, not ProxVM.",
        }
      : {
          reachable: true,
          authenticated: null,
          detail:
            "TCP is open but the RDP handshake got no valid response — the listener is wedged (xrdp half-dead after a restart is the classic cause). Restart xrdp on the guest.",
        };
  }
  return { reachable: true, authenticated: null, detail: `TCP connection to ${opts.hostname}:${opts.port} succeeded.` };
}
