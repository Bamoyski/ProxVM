# Domain migration guide

ProxVM keeps almost no domain state, so moving to a new domain (with or
without Cloudflare in front) is a short checklist rather than a migration.
Do the steps in order; nothing below requires database surgery.

> **Shortcut:** the **Domains** page (Settings → Domains, administrators
> only) automates most of this when Cloudflare manages your DNS: connect an
> API token + Zone ID, then use **Switch domain** to point a name at the
> current target, flip canonical, and keep the old domain redirecting — in
> one audited step. The manual checklist below remains the fallback (and the
> only path without Cloudflare).

## What is domain-dependent (complete list)

| # | Touchpoint | Where it lives | Change requires |
|---|---|---|---|
| 1 | Public web origin (CORS allowlist) | `PROXVM_WEB_ORIGIN` env var | API restart |
| 2 | Guacamole browser URL in launch links | `guacamole.public_url` setting (Settings UI) | None (live immediately) |
| 3 | DNS + TLS termination | Your reverse proxy / Cloudflare | Proxy reload |
| 4 | Session cookies | Host-only, no `Domain` attribute | Nothing (see notes) |

There is deliberately nothing else: CSRF uses per-session tokens (no origin
list), audit logs store paths not hosts, and no domain is hardcoded in code.

## Checklist

1. **Point DNS** for the new domain at your reverse proxy (or Cloudflare).
   Keep the old domain resolving until step 6 passes.
2. **Terminate TLS** for the new domain at the proxy. ProxVM itself serves
   plain HTTP behind the proxy; the API logs a warning if the public origin
   is plaintext HTTP.
3. **Set `PROXVM_WEB_ORIGIN=https://new-domain.example`** in the API
   environment (compose file, systemd unit, or shell) and **restart the API**.
   CORS is an exact match — `https://new-domain.example` and
   `https://www.new-domain.example` are different origins; list exactly the
   origin browsers use. A wrong value breaks login with CORS errors, nothing
   worse.
4. **Update the Guacamole public URL** in Settings → Guacamole (or re-run
   setup) if Guacamole's browser address changes too. This only affects the
   links opened by "launch" buttons; the server-side Guacamole URL/API is
   separate and usually unchanged.
5. **Enable Secure cookies** in Settings if not already on (required for
   HTTPS; the API logs a warning on boot otherwise).
6. **Verify on the new domain**: load the login page, log in, open a VM,
   launch a Guacamole session, run `docker compose logs api | grep -i warn`
   (or the dev log) and confirm no origin/TLS warnings.
7. **Retire the old domain** (DNS + proxy) once verified.

## Removing Cloudflare Access (or any access proxy)

Order matters: first complete steps 1–6 with the access proxy still in
place (so the app is reachable and verified), then remove the proxy rule.
Between removal and verification the app relies on its own controls —
confirm before removing:

- An admin account with a strong password exists; disable or delete any
  temporary setup/admin accounts.
- No `PROXVM_TRUST_PROXY=1` unless a reverse proxy you control is guaranteed
  in front (see `.env.example`).
- Login rate limiting (10/min/IP), per-username throttling, and account
  lockout (5 failures → 15-minute lock) are on by default — no action needed.
- First configuration of a fresh instance requires the one-time
  `SETUP_TOKEN` from the API logs; never paste it anywhere public.

## Notes

- **Sessions do not migrate, and that is fine.** Cookies are host-only, so
  browsers will not send old-domain cookies to the new domain; users simply
  log in again. Server-side sessions stay valid, and nothing needs revoking
  for the move itself. Revoke sessions (per-user, from the Users page) only
  if you suspect compromise.
- **Rollback** is just DNS: point the old domain back, restore the previous
  `PROXVM_WEB_ORIGIN`, restart the API.
- **Guacamole itself** (guacd, the Guacamole webapp, its database) is
  untouched by a ProxVM domain move unless you relocate those too.
