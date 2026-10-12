import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";

/**
 * Mini-CMS reader. Site copy lives server-side (settings rows, admin-edited
 * on the Content page); every key falls back to the built-in default when
 * unset, so a fresh install renders identically with zero configuration.
 */
export function useSiteContent() {
  const { data } = useQuery({
    queryKey: ["site-content"],
    queryFn: () => api<{ entries: Record<string, string> }>("/content"),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const entries = data?.entries ?? {};
  const get = (key: string): string | null => entries[key] ?? null;
  /** Link values are only honored as https:// — defense in depth on top of the server check. */
  const getHttps = (key: string): string | null => {
    const value = get(key);
    return value && value.startsWith("https://") ? value : null;
  };
  return { entries, get, getHttps };
}
