import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { sha256Hex, type HostKeyDecision, type HostKeyPolicy } from "./host-keys.js";
import { probeSsh, runSshCommand } from "./client.js";

const h = vi.hoisted(() => ({ clients: [] as any[] }));

vi.mock("ssh2", async () => {
  const { EventEmitter: EE } = await import("node:events");
  class FakeClient extends EE {
    connectConfig: any = null;
    ended = false;
    execImpl: ((cmd: string, cb: (err: Error | null, stream: any) => void) => void) | null = null;
    constructor() {
      super();
      h.clients.push(this);
    }
    connect(cfg: any) {
      this.connectConfig = cfg;
      return this;
    }
    end() {
      this.ended = true;
    }
    exec(cmd: string, cb: any) {
      this.execImpl?.(cmd, cb);
    }
  }
  return { Client: FakeClient };
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
const blob = () => Buffer.from("fake-host-key-material");

function makeStream() {
  const stream: any = new EventEmitter();
  stream.stderr = new EventEmitter();
  return stream;
}

function policy(decide: HostKeyDecision, confirm: HostKeyDecision = decide) {
  return {
    scope: "vm:vm-1@192.0.2.10:22",
    vmId: "vm-1",
    endpoint: "192.0.2.10:22",
    decide: vi.fn(async () => decide),
    confirm: vi.fn(async () => confirm),
  } satisfies HostKeyPolicy & { decide: any; confirm: any };
}

const base = { host: "192.0.2.10", username: "root", password: "pw", timeoutMs: 1000 };

describe("probeSsh host-key policy wiring", () => {
  beforeEach(() => {
    h.clients.length = 0;
  });

  it("omits the verifier entirely when no policy is set (legacy behavior)", async () => {
    const p = probeSsh({ ...base });
    const client = h.clients[0];
    expect(client.connectConfig.hostVerifier).toBeUndefined();
    client.emit("error", new Error("ECONNREFUSED"));
    await expect(p).resolves.toMatchObject({ status: "CONNECTION_FAILED" });
  });

  it("runs the KEX verifier against the policy and accepts a matching/known key", async () => {
    const pol = policy({ accept: true, alreadyEnrolled: true });
    const p = probeSsh({ ...base, hostKey: pol as never });
    const client = h.clients[0];
    let valid: boolean | undefined;
    client.connectConfig.hostVerifier(blob(), (v: boolean) => (valid = v));
    await flush();
    expect(valid).toBe(true);
    expect(pol.decide).toHaveBeenCalledWith(sha256Hex(blob()), null);
    client.emit("error", new Error("ECONNRESET"));
    await p;
  });

  it("rejects a pinned mismatch before auth and surfaces the policy reason", async () => {
    const pol = policy({ accept: false, alreadyEnrolled: true, detail: "host key changed" });
    const p = probeSsh({ ...base, hostKey: pol as never });
    const client = h.clients[0];
    let valid: boolean | undefined;
    client.connectConfig.hostVerifier(blob(), (v: boolean) => (valid = v));
    await flush();
    expect(valid).toBe(false);
    client.emit("error", new Error("(SSH) Invalid host key"));
    await expect(p).resolves.toEqual({ status: "CONNECTION_FAILED", detail: "host key changed" });
  });

  it("fails closed when the policy itself throws", async () => {
    const pol = policy({ accept: true, alreadyEnrolled: false });
    pol.decide.mockRejectedValueOnce(new Error("db down"));
    const p = probeSsh({ ...base, hostKey: pol as never });
    const client = h.clients[0];
    let valid: boolean | undefined;
    client.connectConfig.hostVerifier(blob(), (v: boolean) => (valid = v));
    await flush();
    expect(valid).toBe(false);
    client.emit("error", new Error("(SSH) Invalid host key"));
    await expect(p).resolves.toMatchObject({ status: "CONNECTION_FAILED" });
  });

  it("commits the pin post-auth (confirm) and completes the probe", async () => {
    const pol = policy({ accept: true, alreadyEnrolled: false });
    const p = probeSsh({ ...base, hostKey: pol as never });
    const client = h.clients[0];
    const stream = makeStream();
    client.execImpl = (_cmd: string, cb: (err: Error | null, stream: any) => void) => cb(null, stream);
    client.connectConfig.hostVerifier(blob(), () => undefined);
    await flush();
    client.emit("ready");
    await flush();
    expect(pol.confirm).toHaveBeenCalledTimes(1);
    expect(pol.confirm).toHaveBeenCalledWith(sha256Hex(blob()), null);
    stream.emit("data", Buffer.from("proxvm-ok\n"));
    stream.emit("close");
    await expect(p).resolves.toEqual({ status: "AUTHENTICATED", detail: "authentication succeeded", output: "proxvm-ok" });
    expect(client.ended).toBe(true);
  });

  it("fails the connection when post-auth confirm rejects (concurrent enrollment conflict)", async () => {
    const pol = policy({ accept: true, alreadyEnrolled: false }, { accept: false, alreadyEnrolled: true, detail: "enrolled a different key" });
    const p = probeSsh({ ...base, hostKey: pol as never });
    const client = h.clients[0];
    client.execImpl = (_cmd: string, cb: (err: Error | null, stream: any) => void) => cb(null, makeStream());
    client.connectConfig.hostVerifier(blob(), () => undefined);
    await flush();
    client.emit("ready");
    await flush();
    await expect(p).resolves.toMatchObject({ status: "CONNECTION_FAILED", detail: "enrolled a different key" });
    expect(client.ended).toBe(true);
  });

  it("refuses to proceed when a policy is set but no key was presented", async () => {
    const pol = policy({ accept: true, alreadyEnrolled: false });
    const p = probeSsh({ ...base, hostKey: pol as never });
    const client = h.clients[0];
    client.emit("ready");
    await flush();
    await expect(p).resolves.toMatchObject({ status: "CONNECTION_FAILED" });
    expect(client.ended).toBe(true);
  });
});

describe("runSshCommand host-key policy wiring", () => {
  beforeEach(() => {
    h.clients.length = 0;
  });

  it("verifies the host key, runs the exact command, and returns stdout", async () => {
    const pol = policy({ accept: true, alreadyEnrolled: true });
    const p = runSshCommand({ ...base, hostKey: pol as never, command: "passwd deploy" });
    const client = h.clients[0];
    const stream = makeStream();
    let ran = "";
    client.execImpl = (cmd: string, cb: (err: Error | null, stream: any) => void) => {
      ran = cmd;
      cb(null, stream);
    };
    client.connectConfig.hostVerifier(blob(), () => undefined);
    await flush();
    client.emit("ready");
    await flush();
    stream.emit("data", Buffer.from("changed\n"));
    stream.emit("close");
    await expect(p).resolves.toMatchObject({ status: "AUTHENTICATED", output: "changed\n" });
    expect(ran).toBe("passwd deploy");
  });

  it("sends no credentials past a rejected host key", async () => {
    const pol = policy({ accept: false, alreadyEnrolled: true, detail: "nope" });
    const p = runSshCommand({ ...base, hostKey: pol as never, command: "id" });
    const client = h.clients[0];
    let execCalled = false;
    client.execImpl = () => {
      execCalled = true;
    };
    client.connectConfig.hostVerifier(blob(), () => undefined);
    await flush();
    client.emit("error", new Error("(SSH) Invalid host key"));
    await expect(p).resolves.toMatchObject({ status: "CONNECTION_FAILED", detail: "nope" });
    expect(execCalled).toBe(false);
  });
});
