import { describe, expect, it } from "vitest";
import { getIdlePolicy, shouldAutoShutdown } from "./index.js";

const policy = { idleMinutes: 60, cpuThreshold: 0.05 };
const NOW = new Date("2026-01-01T12:00:00Z").getTime();
const HOUR = 3600000;

describe("idle shutdown decider", () => {
  it("shuts down only fully idle, long-unused, running VMs", () => {
    expect(
      shouldAutoShutdown(
        { powerOn: true, activeSessions: 0, avgCpu: 0.01, lastActivityMs: NOW - 2 * HOUR },
        policy,
        NOW,
      ),
    ).toMatchObject({ shutdown: true });
  });
  it("spares stopped, busy, fresh, and recently-used machines", () => {
    expect(
      shouldAutoShutdown({ powerOn: false, activeSessions: 0, avgCpu: 0, lastActivityMs: NOW - 9 * HOUR }, policy, NOW).shutdown,
    ).toBe(false);
    expect(
      shouldAutoShutdown({ powerOn: true, activeSessions: 1, avgCpu: 0, lastActivityMs: NOW - 9 * HOUR }, policy, NOW).shutdown,
    ).toBe(false);
    expect(
      shouldAutoShutdown({ powerOn: true, activeSessions: 0, avgCpu: 0.5, lastActivityMs: NOW - 9 * HOUR }, policy, NOW).shutdown,
    ).toBe(false);
    expect(
      shouldAutoShutdown({ powerOn: true, activeSessions: 0, avgCpu: null, lastActivityMs: NOW - 9 * HOUR }, policy, NOW).shutdown,
    ).toBe(false);
    expect(
      shouldAutoShutdown({ powerOn: true, activeSessions: 0, avgCpu: 0, lastActivityMs: null }, policy, NOW).shutdown,
    ).toBe(false);
    expect(
      shouldAutoShutdown({ powerOn: true, activeSessions: 0, avgCpu: 0, lastActivityMs: NOW - 30 * 60000 }, policy, NOW)
        .shutdown,
    ).toBe(false);
  });
  it("treats threshold boundaries safely", () => {
    // Exactly at threshold counts as idle (<=), just over does not.
    expect(
      shouldAutoShutdown({ powerOn: true, activeSessions: 0, avgCpu: 0.05, lastActivityMs: NOW - 2 * HOUR }, policy, NOW)
        .shutdown,
    ).toBe(true);
    expect(
      shouldAutoShutdown({ powerOn: true, activeSessions: 0, avgCpu: 0.05001, lastActivityMs: NOW - 2 * HOUR }, policy, NOW)
        .shutdown,
    ).toBe(false);
  });
});

describe("idle policy parsing", () => {
  const stub = (values: Record<string, string>) => ({
    get: async (key: string) => (values[key] !== undefined ? { value: values[key], encrypted: false } : null),
  });
  it("defaults to disabled with sane numbers", async () => {
    expect(await getIdlePolicy(stub({}) as never)).toEqual({ enabled: false, idleMinutes: 120, cpuThreshold: 0.05 });
  });
  it("parses and clamps operator input", async () => {
    expect(
      await getIdlePolicy(stub({ "power.idle_shutdown_enabled": "TRUE", "power.idle_minutes": "30", "power.cpu_threshold": "0.1" }) as never),
    ).toEqual({ enabled: true, idleMinutes: 30, cpuThreshold: 0.1 });
    const clamped = await getIdlePolicy(stub({ "power.idle_minutes": "999999", "power.cpu_threshold": "7" }) as never);
    expect(clamped.idleMinutes).toBe(10080);
    expect(clamped.cpuThreshold).toBe(1);
    expect((await getIdlePolicy(stub({ "power.idle_minutes": "junk" }) as never)).idleMinutes).toBe(120);
  });
});
