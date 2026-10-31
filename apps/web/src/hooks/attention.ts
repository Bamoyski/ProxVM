import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import type { AttentionResponse } from "../lib/attention.js";

/**
 * Admin attention counters (threats + support queue).
 *
 * One request for every surface that needs the numbers — badges, dashboard
 * strip — polled at 30s, matching the server's threat cache so a second tab
 * costs nothing extra. `retry: false`: the shell must never spin on a
 * permission error, and a stale badge is better than a stuck sidebar.
 */
export function useAttention(enabled: boolean) {
  return useQuery({
    queryKey: ["attention"],
    queryFn: () => api<AttentionResponse>("/attention"),
    enabled,
    refetchInterval: 30000,
    staleTime: 15000,
    retry: false,
  });
}
