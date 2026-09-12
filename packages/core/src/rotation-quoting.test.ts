import { describe, expect, it } from "vitest";
import { quoteWindowsArg, shellQuote, windowsPasswordError } from "./index.js";

describe("guest command quoting", () => {
  it("shellQuote escapes single quotes (POSIX airtight)", () => {
    expect(shellQuote("deploy")).toBe("deploy");
    expect(shellQuote("a'b")).toBe("a'\\''b");
    // An injection attempt stays inside the single-quoted string.
    expect(shellQuote("x'; rm -rf /; echo '")).toBe("x'\\''; rm -rf /; echo '\\''");
  });

  it("shellQuote rejects line breaks (would split chpasswd input lines)", () => {
    expect(() => shellQuote("a\nb")).toThrow(/line breaks/);
    expect(() => shellQuote("a\rb")).toThrow(/line breaks/);
  });

  it("windows args are double-quoted", () => {
    expect(quoteWindowsArg("deploy")).toBe('"deploy"');
    expect(quoteWindowsArg("P@ss w0rd!")).toBe('"P@ss w0rd!"');
  });

  it("windows rejects quote/line-break passwords outright", () => {
    expect(windowsPasswordError('ab"cd')).toMatch(/"/);
    expect(windowsPasswordError("ab\ncd")).toMatch(/line breaks/);
    expect(windowsPasswordError("ab\rcd")).toMatch(/line breaks/);
  });

  it("windows rejects %-wrapping (cmd.exe environment expansion)", () => {
    expect(windowsPasswordError("%PATH%")).toMatch(/%/);
    expect(windowsPasswordError("100%legit")).toBeNull();
    expect(windowsPasswordError("50%done%today")).toMatch(/%/);
  });

  it("ordinary complex passwords pass both quoters", () => {
    const pw = "Tr0ub4dor&3!)_+-=[]{};:,.<>?";
    expect(() => shellQuote(pw)).not.toThrow();
    expect(shellQuote(pw)).toBe(pw);
    expect(windowsPasswordError(pw)).toBeNull();
  });
});
