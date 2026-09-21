import { describe, expect, it } from "vitest";
import net from "node:net";
import { testTcp, testRdpHandshake, testConnection } from "./index.js";

// Regression coverage for the connection diagnostics behind the VM detail
// "Test connection" button: refused endpoints fail fast, and a canned RDP
// Connection Confirm is recognized as a live stack.
const openSockets = new Set<net.Socket>();

function trackServer(server: net.Server): void {
  server.on("connection", (sock) => {
    openSockets.add(sock);
    sock.on("close", () => openSockets.delete(sock));
  });
}

function closeServer(server: net.Server): void {
  // server.close() alone can wait forever for RST-torn-down peers on some
  // stacks; drop every connection first so teardown is deterministic.
  for (const sock of openSockets) sock.destroy();
  openSockets.clear();
}

describe("connection endpoint diagnostics", () => {
  it("refused TCP endpoints report unreachable without throwing", async () => {
    expect(await testTcp("127.0.0.1", 1, 3000)).toBe(false);
    expect(await testRdpHandshake("127.0.0.1", 1, 3000)).toBe(false);
    const result = await testConnection({ protocol: "rdp", hostname: "127.0.0.1", port: 1, timeoutMs: 3000 });
    expect(result.reachable).toBe(false);
    expect(result.authenticated).toBeNull();
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it("recognizes an RDP Connection Confirm from a fake listener", async () => {
    const confirm = Buffer.from([
      0x03, 0x00, 0x00, 0x13, 0x0e, 0xd0, 0x00, 0x00, 0x01, 0x23, 0x40, 0x00,
      0x02, 0x01, 0x08, 0x00, 0x01, 0x00, 0x00,
    ]);
    const server = net.createServer((sock) => {
      sock.on("data", () => {
        sock.write(confirm);
      });
    });
    trackServer(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      expect(await testTcp("127.0.0.1", port, 3000)).toBe(true);
      expect(await testRdpHandshake("127.0.0.1", port, 3000)).toBe(true);
      const result = await testConnection({ protocol: "rdp", hostname: "127.0.0.1", port });
      expect(result.reachable).toBe(true);
    } finally {
      closeServer(server);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("a listener that accepts but never speaks RDP is reported wedged", async () => {
    const server = net.createServer(() => {
      // accept and stay silent, like a half-dead xrdp
    });
    trackServer(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const result = await testConnection({ protocol: "rdp", hostname: "127.0.0.1", port, timeoutMs: 2000 });
      expect(result.reachable).toBe(true);
      expect(result.detail).toMatch(/wedged/i);
    } finally {
      closeServer(server);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);
});
