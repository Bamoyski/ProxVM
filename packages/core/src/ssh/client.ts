import { Client, type ConnectConfig } from "ssh2";
import { keyTypeOf, sha256Hex, type HostKeyPolicy } from "./host-keys.js";

export type SshStatus = "AUTHENTICATED" | "AUTH_FAILED" | "CONNECTION_FAILED";

export interface SshResult {
  status: SshStatus;
  detail: string;
  output?: string;
}

export interface SshCommonOptions {
  host: string;
  port?: number;
  username: string;
  password: string;
  timeoutMs?: number;
  /** TOFU host-key pinning. When absent, the connection performs no host-key
   *  check (legacy behavior; production call paths always pass a policy). */
  hostKey?: HostKeyPolicy;
}

interface PresentedKey {
  fingerprint: string;
  keyType: string | null;
}

/**
 * Builds the ssh2 host-key verifier for a connection. During key exchange
 * (BEFORE any credential is sent) it records what the server presented and,
 * when a pinning policy is configured, asks the policy whether to proceed:
 * pinned-and-matching or not-yet-pinned both return true, a pinned mismatch
 * returns false (ssh2 aborts the handshake and emits an error). DB failures
 * also return false — the connection fails closed rather than proceeding.
 */
function makeHostVerifier(opts: { hostKey?: HostKeyPolicy; presented: { current: PresentedKey | null }; policyFailure: { current: string | null } }): (key: Buffer, verify: (valid: boolean) => void) => void {
  return (key, verify) => {
    const presentedKey = { fingerprint: sha256Hex(key), keyType: keyTypeOf(key) };
    opts.presented.current = presentedKey;
    if (!opts.hostKey) {
      verify(true);
      return;
    }
    void opts.hostKey.decide(presentedKey.fingerprint, presentedKey.keyType).then(
      (d) => {
        if (d.accept) verify(true);
        else {
          opts.policyFailure.current = d.detail ?? "SSH host key verification failed";
          verify(false);
        }
      },
      () => {
        opts.policyFailure.current = "SSH host key verification failed";
        verify(false);
      },
    );
  };
}

/** Post-authentication gate: commits a first-connect pin or rejects fail-closed. */
async function afterAuthenticated(
  policy: HostKeyPolicy | undefined,
  presented: PresentedKey | null,
): Promise<{ rejected: boolean; detail: string }> {
  if (!policy) return { rejected: false, detail: "" };
  if (!presented) {
    return { rejected: true, detail: "SSH host key was not presented during the handshake; refusing connection" };
  }
  try {
    const verdict = await policy.confirm(presented.fingerprint, presented.keyType);
    if (verdict.accept) return { rejected: false, detail: "" };
    return { rejected: true, detail: verdict.detail ?? "SSH host key verification failed" };
  } catch (err) {
    return { rejected: true, detail: err instanceof Error ? err.message : "SSH host key could not be verified" };
  }
}

export function probeSsh(opts: SshCommonOptions): Promise<SshResult> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  return new Promise((resolve) => {
    const client = new Client();
    const presented: { current: PresentedKey | null } = { current: null };
    const policyFailure: { current: string | null } = { current: null };
    const timeout = setTimeout(() => {
      client.end();
      resolve({ status: "CONNECTION_FAILED", detail: "SSH connection timed out" });
    }, timeoutMs);

    client
      .on("ready", () => {
        void (async () => {
          const verdict = await afterAuthenticated(opts.hostKey, presented.current);
          if (verdict.rejected) {
            clearTimeout(timeout);
            client.end();
            resolve({ status: "CONNECTION_FAILED", detail: verdict.detail });
            return;
          }
          clearTimeout(timeout);
          client.exec("echo proxvm-ok", (err, stream) => {
            if (err) {
              client.end();
              resolve({ status: "AUTHENTICATED", detail: "authentication succeeded; exec failed" });
              return;
            }
            let output = "";
            stream
              .on("data", (data: Buffer) => {
                output += data.toString("utf8");
              })
              .on("close", () => {
                client.end();
                resolve({ status: "AUTHENTICATED", detail: "authentication succeeded", output: output.trim() });
              });
          });
        })();
      })
      .on("error", (err: Error) => {
        clearTimeout(timeout);
        if (policyFailure.current) {
          resolve({ status: "CONNECTION_FAILED", detail: policyFailure.current });
          return;
        }
        if (/authentication failed|All configured authentication methods failed|Too many authentication failures/i.test(err.message)) {
          resolve({ status: "AUTH_FAILED", detail: err.message });
        } else {
          resolve({ status: "CONNECTION_FAILED", detail: err.message });
        }
      })
      .connect(
        baseConnectConfig(opts, timeoutMs, {
          hostVerifier: makeHostVerifier({ hostKey: opts.hostKey, presented, policyFailure }),
        }),
      );
  });
}

export function runSshCommand(opts: SshCommonOptions & { command: string }): Promise<SshResult> {
  const timeoutMs = opts.timeoutMs ?? 30000;
  return new Promise((resolve) => {
    const client = new Client();
    const presented: { current: PresentedKey | null } = { current: null };
    const policyFailure: { current: string | null } = { current: null };
    const timeout = setTimeout(() => {
      client.end();
      resolve({ status: "CONNECTION_FAILED", detail: "SSH command timed out" });
    }, timeoutMs);

    client
      .on("ready", () => {
        void (async () => {
          const verdict = await afterAuthenticated(opts.hostKey, presented.current);
          if (verdict.rejected) {
            clearTimeout(timeout);
            client.end();
            resolve({ status: "CONNECTION_FAILED", detail: verdict.detail });
            return;
          }
          client.exec(opts.command, (err, stream) => {
            if (err) {
              clearTimeout(timeout);
              client.end();
              resolve({ status: "AUTHENTICATED", detail: `exec failed: ${err.message}` });
              return;
            }
            let stdout = "";
            let stderr = "";
            stream
              .on("data", (data: Buffer) => {
                stdout += data.toString("utf8");
              })
              .stderr.on("data", (data: Buffer) => {
                stderr += data.toString("utf8");
              });
            stream.on("close", () => {
              clearTimeout(timeout);
              client.end();
              resolve({
                status: "AUTHENTICATED",
                detail: "command executed",
                output: stdout || stderr,
              });
            });
          });
        })();
      })
      .on("error", (err: Error) => {
        clearTimeout(timeout);
        if (policyFailure.current) {
          resolve({ status: "CONNECTION_FAILED", detail: policyFailure.current });
          return;
        }
        if (/authentication failed|All configured authentication methods failed/i.test(err.message)) {
          resolve({ status: "AUTH_FAILED", detail: err.message });
        } else {
          resolve({ status: "CONNECTION_FAILED", detail: err.message });
        }
      })
      .connect(
        baseConnectConfig(opts, timeoutMs, {
          hostVerifier: makeHostVerifier({ hostKey: opts.hostKey, presented, policyFailure }),
        }),
      );
  });
}

function baseConnectConfig(
  opts: SshCommonOptions,
  timeoutMs: number,
  extra: { hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => void },
): ConnectConfig {
  const cfg: ConnectConfig = {
    host: opts.host,
    port: opts.port ?? 22,
    username: opts.username,
    password: opts.password,
    readyTimeout: timeoutMs,
    tryKeyboard: false,
    keepaliveInterval: 5000,
  };
  if (opts.hostKey) cfg.hostVerifier = extra.hostVerifier;
  return cfg;
}