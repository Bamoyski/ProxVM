import { Client } from "ssh2";

export type SshStatus = "AUTHENTICATED" | "AUTH_FAILED" | "CONNECTION_FAILED";

export interface SshResult {
  status: SshStatus;
  detail: string;
  output?: string;
}

export function probeSsh(opts: {
  host: string;
  port?: number;
  username: string;
  password: string;
  timeoutMs?: number;
}): Promise<SshResult> {
  return new Promise((resolve) => {
    const client = new Client();
    const timeout = setTimeout(() => {
      client.end();
      resolve({ status: "CONNECTION_FAILED", detail: "SSH connection timed out" });
    }, opts.timeoutMs ?? 15000);

    client
      .on("ready", () => {
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
      })
      .on("error", (err: Error) => {
        clearTimeout(timeout);
        if (/authentication failed|All configured authentication methods failed|Too many authentication failures/i.test(err.message)) {
          resolve({ status: "AUTH_FAILED", detail: err.message });
        } else {
          resolve({ status: "CONNECTION_FAILED", detail: err.message });
        }
      })
      .connect({
        host: opts.host,
        port: opts.port ?? 22,
        username: opts.username,
        password: opts.password,
        readyTimeout: opts.timeoutMs ?? 15000,
        tryKeyboard: false,
        keepaliveInterval: 5000,
      });
  });
}

export function runSshCommand(opts: {
  host: string;
  port?: number;
  username: string;
  password: string;
  command: string;
  timeoutMs?: number;
}): Promise<SshResult> {
  return new Promise((resolve) => {
    const client = new Client();
    const timeout = setTimeout(() => {
      client.end();
      resolve({ status: "CONNECTION_FAILED", detail: "SSH command timed out" });
    }, opts.timeoutMs ?? 30000);

    client
      .on("ready", () => {
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
      })
      .on("error", (err: Error) => {
        clearTimeout(timeout);
        if (/authentication failed|All configured authentication methods failed/i.test(err.message)) {
          resolve({ status: "AUTH_FAILED", detail: err.message });
        } else {
          resolve({ status: "CONNECTION_FAILED", detail: err.message });
        }
      })
      .connect({
        host: opts.host,
        port: opts.port ?? 22,
        username: opts.username,
        password: opts.password,
        readyTimeout: opts.timeoutMs ?? 15000,
        tryKeyboard: false,
        keepaliveInterval: 5000,
      });
  });
}