import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";

/**
 * The backend-resolved effective permission set for the current user
 * (legacy roles + custom roles + group roles + direct grants, unexpired).
 * Shared across pages via the query cache. Null while loading or on error —
 * callers fall back to the legacy role map so the UI keeps working.
 */
export function useEffectivePermissions(): Set<string> | null {
  const { data } = useQuery({
    queryKey: ["iam-effective"],
    queryFn: () => api<{ permissions: Array<{ permission: string }> }>("/iam/effective"),
    staleTime: 30000,
    retry: false,
  });
  if (!data) return null;
  return new Set(data.permissions.map((p) => p.permission));
}

/** Effective-first check with a legacy fallback while loading/offline. */
export function makeCan(
  effective: Set<string> | null,
  legacy: (perm: string) => boolean,
): (perm: string) => boolean {
  return (perm: string): boolean => (effective ? effective.has(perm) : legacy(perm));
}
