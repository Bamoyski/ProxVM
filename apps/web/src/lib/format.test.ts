import { describe, it, expect } from "vitest";
import { fmtBytes, fmtUptime, fmtRelative, fmtDays, fmtHM, shortId, masked, expiryIso, pct, fmtDateTime, fmtDate } from "./format.js";

/**
 * Formatters are the last line of defense against garbage on screen: a null
 * from Proxmox must render as "—", never "NaN undefined". These helpers were
 * previously copy-pasted per page with slightly different bugs each time.
 */
describe("fmtBytes", () => {
  it("scales through the unit ladder", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1024)).toBe("1.0 KB");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(1024 * 1024)).toBe("1.0 MB");
    expect(fmtBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(fmtBytes(1024 ** 4)).toBe("1.0 TB");
  });

  it("drops the decimal on large values", () => {
    expect(fmtBytes(200 * 1024)).toBe("200 KB");
    expect(fmtBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });

  it("honours an explicit decimal count", () => {
    expect(fmtBytes(1536, 2)).toBe("1.50 KB");
  });

  it("renders null/undefined/NaN as an em dash", () => {
    expect(fmtBytes(null)).toBe("—");
    expect(fmtBytes(undefined)).toBe("—");
    expect(fmtBytes("not a number")).toBe("—");
    expect(fmtBytes(NaN)).toBe("—");
  });
});

describe("fmtUptime", () => {
  it("renders days, hours, and minutes at the right granularity", () => {
    expect(fmtUptime(90061)).toBe("1d 1h");
    expect(fmtUptime(3700)).toBe("1h 1m");
    expect(fmtUptime(120)).toBe("2m");
    expect(fmtUptime(59)).toBe("0m");
  });

  it("renders zero/negative/non-finite as an em dash", () => {
    expect(fmtUptime(0)).toBe("—");
    expect(fmtUptime(-5)).toBe("—");
    expect(fmtUptime(Infinity)).toBe("—");
    expect(fmtUptime(null)).toBe("—");
    expect(fmtUptime(undefined)).toBe("—");
  });
});

describe("fmtRelative", () => {
  it("renders 'just now' under a minute", () => {
    expect(fmtRelative(new Date())).toBe("just now");
  });

  it("renders minutes, hours, and days ago", () => {
    const now = Date.now();
    expect(fmtRelative(new Date(now - 4 * 60000))).toBe("4m ago");
    expect(fmtRelative(new Date(now - 3 * 3600000))).toBe("3h ago");
    expect(fmtRelative(new Date(now - 12 * 86400000))).toBe("12d ago");
  });

  it("falls back to a date beyond a month", () => {
    const old = new Date(Date.now() - 90 * 86400000);
    expect(fmtRelative(old)).toBe(fmtDate(old));
  });

  it("renders invalid input as an em dash", () => {
    expect(fmtRelative(null)).toBe("—");
    expect(fmtRelative("garbage")).toBe("—");
  });
});

describe("fmtDays", () => {
  it("renders wildcard and full weeks as every day", () => {
    expect(fmtDays("*")).toBe("Every day");
    expect(fmtDays(null)).toBe("Every day");
    expect(fmtDays(undefined)).toBe("Every day");
    expect(fmtDays("Mon,Tue,Wed,Thu,Fri,Sat,Sun")).toBe("Every day");
  });

  it("recognises weekends and weekdays", () => {
    expect(fmtDays("Sat,Sun")).toBe("Weekends");
    expect(fmtDays("Mon,Tue,Wed,Thu,Fri")).toBe("Weekdays");
  });

  it("lists other combinations by name", () => {
    expect(fmtDays("Mon,Wed,Fri")).toBe("Mon, Wed, Fri");
    expect(fmtDays("Sun")).toBe("Sun");
  });
});

describe("fmtHM", () => {
  it("zero-pads hour and minute", () => {
    expect(fmtHM(9, 5)).toBe("09:05");
    expect(fmtHM(0, 0)).toBe("00:00");
    expect(fmtHM(23, 59)).toBe("23:59");
  });
});

describe("shortId", () => {
  it("truncates to 8 characters", () => {
    expect(shortId("12345678-abcd")).toBe("12345678");
  });

  it("renders null/undefined as an em dash", () => {
    expect(shortId(null)).toBe("—");
    expect(shortId(undefined)).toBe("—");
  });
});

describe("masked", () => {
  it("never contains anything but mask characters", () => {
    expect(masked()).toMatch(/^[•*]+$/);
    expect(masked().length).toBeGreaterThan(8);
  });
});

describe("expiryIso", () => {
  it("returns undefined for an empty preset", () => {
    expect(expiryIso("")).toBeUndefined();
  });

  it("builds 1h/1d/1w offsets from now", () => {
    const before = Date.now();
    const oneHour = new Date(expiryIso("1h")!).getTime();
    const oneDay = new Date(expiryIso("1d")!).getTime();
    const oneWeek = new Date(expiryIso("1w")!).getTime();
    expect(oneHour - before).toBeGreaterThanOrEqual(3_600_000 - 5000);
    expect(oneHour - before).toBeLessThanOrEqual(3_600_000 + 5000);
    expect(oneDay - oneHour).toBeGreaterThanOrEqual(23 * 3_600_000);
    expect(oneWeek - oneDay).toBeGreaterThanOrEqual(6 * 86_400_000);
  });

  it("passes through a valid custom date, rejects an invalid one", () => {
    expect(expiryIso("custom", "2030-01-01T00:00:00Z")).toBe("2030-01-01T00:00:00.000Z");
    expect(expiryIso("custom", "not-a-date")).toBeUndefined();
    expect(expiryIso("custom")).toBeUndefined();
  });
});

describe("pct", () => {
  it("computes a percentage capped at 100", () => {
    expect(pct(50, 100)).toBe(50);
    expect(pct(200, 100)).toBe(100);
    expect(pct(0, 100)).toBe(0);
  });

  it("is null-safe for missing or zero maxima", () => {
    expect(pct(50, 0)).toBeNull();
    expect(pct(null, 100)).toBeNull();
    expect(pct(undefined, 100)).toBeNull();
    expect(pct(50, null)).toBeNull();
  });
});

describe("fmtDateTime / fmtDate", () => {
  it("renders an em dash for empty or invalid input", () => {
    expect(fmtDateTime(null)).toBe("—");
    expect(fmtDateTime(undefined)).toBe("—");
    expect(fmtDateTime("")).toBe("—");
    expect(fmtDateTime("not a date")).toBe("—");
    expect(fmtDate("not a date")).toBe("—");
  });

  it("accepts strings, numbers, and Date objects", () => {
    const iso = "2026-03-15T12:00:00Z";
    expect(fmtDateTime(iso)).not.toBe("—");
    expect(fmtDateTime(new Date(iso))).not.toBe("—");
    expect(fmtDateTime(Date.parse(iso))).not.toBe("—");
    expect(fmtDate(iso)).not.toBe("—");
  });
});
