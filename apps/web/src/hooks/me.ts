import { useQuery } from "@tanstack/react-query";
import { api, setCsrfToken } from "../api.js";

export interface MeUser {
  id: string;
  username: string;
  roles: string[];
}

/** Session bootstrap: identity + CSRF token recovery on every page load. */
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        const res = await api<{ user: MeUser | null; csrfToken: string | null }>("/me");
        setCsrfToken(res.csrfToken);
        return res.user;
      } catch (err) {
        if (err instanceof Error && "statusCode" in err && (err as { statusCode: number }).statusCode === 401) {
          return null;
        }
        throw err;
      }
    },
  });
}
