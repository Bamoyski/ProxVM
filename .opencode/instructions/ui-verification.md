# UI verification: dev server + screenshot (ALWAYS REQUIRED)

This rule is ALWAYS in effect for this project. It is not optional and not a
style preference: any agent implementing or changing anything user-visible
MUST do all of the following before declaring the work done.

## When this applies

Every new feature implementation, and every change that renders in the web
SPA (new pages, layout changes, new controls, visual/interaction changes,
RouteErrorBoundary and shell changes — anything a human can see).

## Required steps, in order

1. **Start the dev web server.** From `C:\ApacheProxVM-GitHub\apps\web`:
   `& "C:\Users\Bamme\AppData\Local\hermes\node\npx.cmd" vite`
   (the `dev:web` script exists at the repo ROOT only — `npm run dev:web`
   fails inside the workspace). Vite serves on http://localhost:5173 and
   proxies `/api` to `http://localhost:4000`.
2. **Satisfy the app's boot calls.** The SPA is only usable past its
   Loading/Setup gates when these endpoints answer:
   `/api/domains/public`, `/api/setup/status`, `/api/me`,
   `/api/iam/effective`, plus shell/dashboard calls (`/api/announcement`,
   `/api/notifications*`, `/api/threats`, `/api/vms`, `/api/users`).
   Use a temporary fixture API on :4000 that mirrors ONLY the shapes the
   frontend declares (precedent: `docs/UI_REWRITE_ARCHITECTURE.md`
   "fixture API"). No live infrastructure, no fabricated verification.
   If a configured dev instance already exists, use it instead.
3. **Screenshot the exact change** with the browser tools against the dev
   server URL (open a tab, capture during the relevant state, verify
   visually — layout, theme classes, both dark and light when theme-
   dependent).
4. **Attach the screenshot** to the PR description / final task report and
   state what the screenshot shows.
5. **Clean up**: stop the fixture API and delete the temp script (it lives
   in `C:\Users\Bamme\AppData\Local\Temp\opencode\` per AGENTS.md); keep the
   dev server running only while verification continues.

## Hard limits

- Screenshot the real rendered UI from the dev server. Never fabricate,
  retouch, or substitute a mock image and claim it is the running app.
- Never fake backend verification: a fixture asserts nothing about real
  backend behaviour; label anything fixture-verified as
  "visually verified only, fixture data".
- Live/homelab behaviour verification stays with the maintainer (label the
  PR `needs-live-verify` when relevant) — per CONTRIBUTING.md.
