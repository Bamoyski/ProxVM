import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App.js";
import "./index.css";

/** Last-resort render guard: a single crashing component must never blank the whole app. */
class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-8 max-w-md text-center">
            <h1 className="text-xl font-semibold text-red-300 mb-2">Something broke rendering this page</h1>
            <p className="text-sm text-slate-400 mb-4">
              ProxVM hit an unexpected interface error. Your data is safe — this is display-only.
            </p>
            <button
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 rounded"
              onClick={() => window.location.reload()}
            >
              Reload the page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

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
    <RootErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </RootErrorBoundary>
  </StrictMode>,
);