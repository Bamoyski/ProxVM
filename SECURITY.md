# Security Policy

## Reporting a Vulnerability

This project does not currently publish a dedicated security contact.

If you discover a security vulnerability in ProxVM, please report it through a
**GitHub Security Advisory** on this repository ("Security" tab →
"Report a vulnerability"). Advisories keep the details private until a fix is
ready and allow coordinated disclosure with the maintainers.

Please include, where possible:

- A description of the vulnerability and its potential impact
- Steps to reproduce (configuration, roles, requests involved)
- The affected version/commit and component (`apps/api`, `apps/web`,
  `apps/worker`, `packages/core`, `packages/shared`)
- Any suggested mitigation

Please do not open a public issue for unpatched vulnerabilities, and do not
include real credentials, tokens, or infrastructure details in any report —
use placeholders such as `https://proxmox.example.com:8006`.

## Scope

In-scope: authentication, session handling, CSRF protection, IAM/RBAC
enforcement (roles, groups, temporary access, protocol permissions), the
credential vault (encryption, reveal/copy/rotation), Guacamole
synchronization, provisioning authorization, audit logging, and the setup
wizard.

## Security Controls (for contributors)

- Deny-by-default authorization: every API route declares its required
  permission; the backend is authoritative and the frontend is UX-only.
- Server-side sessions in PostgreSQL, httpOnly SameSite=strict cookies,
  per-session CSRF tokens derived on demand (never stored at rest — see below),
  idle timeout, login rate limiting, and account lockout after repeated
  failures.
- AES-256-GCM authenticated encryption for stored secrets (per-install master
  key in `.proxvm/config.json`, never committed); Argon2id for application
  passwords; VM passwords are never logged.
- Audit log redacts secret-like detail keys (`*password*`, `*token*`,
  `*secret*`).

## CSRF tokens

CSRF tokens are **derived, not stored**. For a session with original random id
`sid` (the opaque value in the `proxvm_session` cookie) the token is:

```
csrf = HMAC-SHA256( HKDF-SHA256(sessionSigningKey, info="proxvm:session-csrf-subkey:v1", 32),
                    "proxvm:csrf:v1:" + sid )
```

- The schema uses a dedicated per-install `sessionSigningKey` (never the AES
  master key), and HKDF provides **domain separation** so the CSRF subkey can
  never collide with any other use of that key. The HMAC domain prefix ensures a
  token can only ever be computed over a session id.
- The raw session id is **never exposed by the API** and the database stores
  only `sid_hash = SHA-256(sid)`. The derived token is therefore not a
  substitute for the hashed DB id — it is computed from the original `sid` from
  the cookie, which is why the same browser (including multiple tabs) always
  derives the same token and why `/api/me` is idempotent.
- No plaintext CSRF secret exists at rest: migration `019` drops
  `sessions.csrf_token`, and no code path reads or writes it.
- Comparisons are timing-safe (`timingSafeEqualStr`), and CSRF is enforced on
  every authenticated state-changing request (non-GET/HEAD/OPTIONS routes,
  except those that explicitly opt out such as login/registration).

**Revocation and expiry.** Logout, `revokeAllForUser` (e.g. password change or
account lock), and session expiry/idle timeout all invalidate the session by
`sid_hash`/status, so a previously valid token stops being accepted. Deriving
the token does not extend a session's life.

**Rotating `sessionSigningKey`.** Changing the key changes every derived token
while leaving stored sessions valid. Existing tabs will see their next
state-changing request rejected with 403 until the SPA refetches `/api/me`
(which returns the new token); reads keep working. Restart the API after
rotating the key. Losing the key does not lose any data — sessions simply
re-derive different tokens.

## SSH host key trust (TOFU pinning)

ProxVM opens SSH connections to managed guests to verify credentials and to
rotate VM passwords. Those connections are protected by trust-on-first-use
(TOFU) host-key pinning so a man-in-the-middle on the guest network cannot
silently impersonate a VM after compromise or a rebuild.

### Trust model

- A pin is the **SHA-256 fingerprint** of the SSH host key a guest presents,
  scoped to the **VM identity + SSH endpoint** (`host:port`). The same guest on
  a different address, or a different guest on the same address, is a different
  scope and is pinned independently.
- Nothing is trusted silently. On the *first* connection the key is accepted
  provisionally during key exchange (no credential is sent to a *pinned*
  mismatching host), but it is **only persisted after user authentication
  succeeds**. In other words, enrollment proves the endpoint really holds the
  stored credential, not merely that it answered a TCP handshake.
- Every subsequent connection must present the same key. A mismatch is rejected
  **before** any credential is sent, and again after authentication, and is
  recorded in the audit log.
- Pins are stored in the `ssh_host_keys` table; they cannot be changed by a
  connection. Configuration state and connection failures never fall back to
  "accept any host key" — failures fail closed.
- First enrollment is atomic (`INSERT ... ON CONFLICT (scope) DO NOTHING` plus
  a confirming re-read), so two simultaneous first connections cannot both
  trust different keys; the loser is rejected.

### Audit events

- `SSH_HOST_KEY_ENROLLED` — a first connection authenticated and pinned a key.
- `SSH_HOST_KEY_MISMATCH` — a connection presented a key that differs from the
  pin and was rejected (`detail.blocked = true`).
- `SSH_HOST_KEY_ROTATED` — an administrator re-verified a changed fingerprint.
- `SSH_HOST_KEY_UNPINNED` — an administrator cleared a pin.

### Recovery: legitimate host-key change or guest rebuild

A guest rebuild, reinstall, or deliberate host-key rotation changes the key and
will (correctly) be rejected with `SSH_HOST_KEY_MISMATCH`. Do **not** disable
verification. Instead:

1. Confirm the new key out-of-band — e.g. from the Proxmox console run
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the guest and read the
   `SHA256:...` value.
2. Inspect the current pin:
   `GET /api/vms/{id}/host-keys`.
3. Either re-verify the pin to the confirmed value —
   `POST /api/vms/{id}/host-keys/rotate` with `{ "fingerprint": "SHA256:..." }`
   — or, if you prefer the next connection to re-enroll automatically, clear it
   with `POST /api/vms/{id}/host-keys/unpin`.

Both operations require an admin session (CSRF-protected) and are audited
against the acting administrator. `rotate` is the safer option: it requires the
value to be verified out-of-band, whereas `unpin` re-trusts whatever the next
authenticated connection presents.

### Limitations

- TOFU trusts the *first* successfully authenticated connection per scope. If a
  guest is already compromised at the moment of first enrollment, that key is
  the one pinned; prefer `rotate` with an out-of-band-verified fingerprint for
  high-value guests.
- Changing a VM's IP address changes its scope, so the new endpoint enrolls
  on first use. Set `PATCH` access / static addressing where pinning stability
  matters.

## Secret rotation

### Postgres password (compose)

1. Generate a replacement: `openssl rand -hex 32` (hex avoids SQL quoting issues).
2. Apply live without downtime:
   `docker exec apacheproxvm-postgres-1 psql -U proxvm -d proxvm -c "ALTER USER proxvm WITH PASSWORD '<new>';"`
3. Put the same value in `.env` as `POSTGRES_PASSWORD=<new>`.
4. **Also update `/data/.proxvm/config.json`** — the API/worker read the
   database password from `database.password` there, not from `.env`
   (`.env` is only used at first database init). Skipping this breaks the
   API on its next restart. Update it atomically from inside the api
   container, verifying only the length afterwards:
   `<new> | docker exec -i apacheproxvm-api-1 node -e "let s='';process.stdin.on('data',d=>{s+=d}).on('end',()=>{const fs=require('fs');const f='/data/.proxvm/config.json';const c=JSON.parse(fs.readFileSync(f,'utf8'));c.database.password=s.trim();fs.writeFileSync(f+'.tmp',JSON.stringify(c,null,2),{mode:0o600});fs.renameSync(f+'.tmp',f);console.log('pwLen='+JSON.parse(fs.readFileSync(f,'utf8')).database.password.length)})"`
5. `docker compose up -d api worker` (and `web` if rebuilt) and confirm
   clean boot: `docker logs apacheproxvm-api-1` shows "ProxVM API started"
   with no auth errors, and `/api/setup/status` returns `{"mode":"ready"}`.
6. Never commit `.env` (gitignored). The old default `changeme-postgres`
   must be considered compromised anywhere it was ever used.

### ProxVM master key (`.proxvm/config.json`)

There is no online rotation: the vault cannot be re-encrypted while running.
To rotate, stop the stack, back up the config + database, run a decrypt-with-old
/ encrypt-with-new re-encryption pass over `vm_credentials`,
`guacamole_users`, `guacamole_connections`, and encrypted `settings` rows,
update `masterKey`/`masterKeyId` in the config, then restart and verify a
credential reveal. Losing the master key loses every vault credential.
- Security regression tests (`iam-adversarial`, `rbac-authorization`, and the
  foundation auth tests) must keep passing — do not weaken them to make a
  change fit.
