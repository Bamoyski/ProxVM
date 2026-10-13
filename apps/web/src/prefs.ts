import { useState } from "react";

/** Browser-local UI preferences (NOT secrets, NOT auth state): last-used
 *  form values, dismissed hints, widget layouts. Namespaced keys, JSON
 *  values, silent failure in private mode. Server-side policy never reads
 *  these — they only prefill forms the server still validates. */

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(`proxvm-pref:${key}`);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(`proxvm-pref:${key}`, JSON.stringify(value));
  } catch {
    // private mode: preferences just won't persist
  }
}

/** Write without React state (safe inside effects that would otherwise loop). */
export function savePref(key: string, value: unknown): void {
  write(key, value);
}

/** useState backed by localStorage: persists on every change. */
export function usePref<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => read(key, initial));
  const set = (v: T | ((p: T) => T)): void => {
    setValue((prev) => {
      const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
      write(key, next);
      return next;
    });
  };
  return [value, set];
}
