# UI verification (optional, not a gate)

Screenshots are **not required** for user-visible changes. A green
`typecheck` + `test` + `build`, plus a described manual check where one was
done, is enough to call UI work finished.

When a screenshot genuinely helps — a layout change that is hard to put in
words, or a PR where the reviewer needs to see the rendered result — this is
the pattern that works in this repo:

1. Start the dev web server (see `AGENTS-VIHAAN.md` / `AGENTS.md`).
2. Satisfy the SPA's boot calls. `/api/domains/public`, `/api/setup/status`,
   `/api/me`, `/api/iam/effective`, plus shell calls (`/api/announcement`,
   `/api/notifications*`, `/api/threats`, `/api/vms`, `/api/users`). Use a
   configured dev instance, or a THROWAWAY fixture API on :4000 that mirrors
   only the shapes the frontend declares (precedent:
   `docs/UI_REWRITE_ARCHITECTURE.md`). Never point a fixture at real homelab
   infrastructure.
3. Capture the state that changed, and check it visually (layout, theme
   classes, dark/light where the theme matters).
4. Say what the image shows. Label fixture-based results "visually verified
   only, fixture data".
5. Stop the fixture API and delete the temporary script.

Hard limit that still applies to any image you publish: never fabricate,
retouch, or substitute a mock for the running app. Live homelab behaviour
(Guacamole launch, real backups, DNS) stays with the maintainer via the
`needs-live-verify` label.
