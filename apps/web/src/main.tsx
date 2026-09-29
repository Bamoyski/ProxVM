import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App.js";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5000 },
  },
});

// Canonical-domain bounce: after a domain switch the old hostnames stay in
// DNS as redirect aliases, but this static bundle can't know that — so ask
// the API (public, pre-login) where home is and move there, preserving path.
// Unknown hosts (localhost, LAN IPs, fresh DNS) never redirect.
void fetch("/api/domains/public", { credentials: "omit" })
  .then((res) => (res.ok ? res.json() : null))
  .then((data: { canonical?: string | null; aliases?: string[] } | null) => {
    const canonical = (data?.canonical ?? "").toLowerCase();
    const host = window.location.hostname.toLowerCase();
    if (canonical && host !== canonical && (data?.aliases ?? []).includes(host)) {
      window.location.replace(`https://${canonical}${window.location.pathname}${window.location.search}`);
    }
  })
  .catch(() => undefined);

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);