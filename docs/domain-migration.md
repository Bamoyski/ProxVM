# Domain migration guide

ProxVM keeps almost no domain state, so moving to a new domain (with or
without Cloudflare in front) is a short checklist rather than a migration.
Do the steps in order; nothing below requires database surgery.

> **Shortcut:** the **Domains** page (Settings → Domains, administrators
> only) automates all of this when Cloudflare manages your DNS: connect an
> API token + Zone ID, then use **Switch domain** to point a name at the
> current target, route it through your tunnel, verify it resolves (and probe
> HTTPS), flip canonical, and keep the old domain redirecting — in one
> audited step, no SSH, no config files, no restarts. The switch refuses to
> flip while the new name does not resolve, so a typo can't strand you.
> The manual checklist below remains the fallback (and the only path without
> Cloudflare).

## Full-auto tunnel ingress (no manual cloudflared step)

When the Domains page also knows your Cloudflare **Account ID** and **Tunnel
ID**, Switch manages the tunnel itself: it reads the tunnel's remote ingress
config, copies the service target from the current domain's rule onto the new
hostname (inserted before the catch-all, which always stays last), and writes
it back — then proceeds to DNS verification and the flip as usual.

Requirements and sharp edges:

- The tunnel must be **cloud-managed** (remote config in the dashboard). A
  tunnel running on a local `config.yml` is detected and refused with
  instructions — convert it once in the dashboard, then automation takes over.
- The API token needs **Zone:Read + DNS:Edit** (as before) plus
  **Account:Cloudflare Tunnel:Edit** (and Read, for the status check).
- Wiring lives in the server environment (`PROXVM_CLOUDFLARE_API_TOKEN`,
  `PROXVM_CLOUDFLARE_ZONE_ID`, `PROXVM_CLOUDFLARE_ACCOUNT_ID`,
  `PROXVM_CLOUDFLARE_TUNNEL_ID` — see `.env.example`), which always wins over
  the Domains-page settings. There is deliberately no credential UI: secrets
  stay in a gitignored local `.env`, never in the database display, and never
  in any mirrored copy of this repo.
- First switch ever with a tunnel configured asks for the **service target**
  once (e.g. `http://localhost:8080`, copied from your existing rule) because
  there is no current rule to copy from yet. Every switch after that copies
  automatically; the field stays for overrides.
- Every ingress write is audit-logged with before/after service. Read-modify-
  write races with a human editing the dashboard at the same moment resolve
  last-write-wins — don't hand-edit ingress mid-switch.

## What is domain-dependent (complete list)

| # | Touchpoint | Where it lives | Change requires |
|---|---|---|---|
| 1 | Public web origin (CORS allowlist) | Canonical domain setting + `PROXVM_WEB_ORIGIN` fallback | Nothing (evaluated per request) |
| 2 | Guacamole browser URL in launch links | `guacamole.public_url` setting (Settings UI) | None (live immediately) |
| 3 | DNS + TLS termination | Your reverse proxy / Cloudflare | Proxy reload |
| 4 | Session cookies | Host-only, no `Domain` attribute | Nothing (see notes) |
| 5 | Old-URL redirects | API redirect hook + SPA pre-login bounce + redirect aliases | Nothing (automatic) |

There is deliberately nothing else: CSRF uses per-session tokens (no origin
list), audit logs store paths not hosts, and no domain is hardcoded in code.

CORS is resolved per request from `PROXVM_WEB_ORIGIN` (always honored) plus
`https://` for the canonical domain and every redirect alias — a switch
takes effect with no restart and no env edit. `PROXVM_WEB_ORIGIN` remains as
the fallback for setups with no canonical domain set (LAN/IP access, dev).

## Checklist

1. **Point DNS** for the new domain at your reverse proxy (or Cloudflare).
   Keep the old domain resolving until step 6 passes.
2. **Terminate TLS** for the new domain at the proxy. ProxVM itself serves
   plain HTTP behind the proxy; the API logs a warning if the public origin
   is plaintext HTTP.
3. CORS needs no action: once the canonical domain is set (via the Domains
   page or step 6's verification), the API accepts the new `https://` origin
   automatically. `PROXVM_WEB_ORIGIN` remains only as a fallback for setups
   with no canonical domain (LAN/IP access, dev). If logins fail with CORS
   errors, the origin in the browser address bar is not the canonical domain
   and not a redirect alias — fix DNS/canonical, not the env.
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

## School-filter watch (Securly)

The Domains page shows whether the current canonical domain is blocked by
Securly for your school, using Securly's own broker endpoint as an oracle
(same verdict the extension enforces, checked from anywhere). Configure one
school user email (Domains page, or `PROXVM_SECURILY_USEREMAIL` env) to scope
the check to that school's policy. This is an admin alert only — it never
rotates, never redirects, and unknown/timeout answers stay unknown rather
than claiming clean.

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
