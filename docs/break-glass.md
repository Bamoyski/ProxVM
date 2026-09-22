# Break-glass: emergency administrator recovery

Use this procedure **only** when no administrator can log in (all passwords
lost, accounts locked, or accounts disabled). It bypasses every application
control by design — which is exactly why each step requires infrastructure
access an attacker should never have.

## Prerequisites (all required)

- Shell access to a host that can reach the application database.
- Read access to the ProxVM config directory (`PROXVM_CONFIG_DIR`,
  default `./.proxvm`, `/data/.proxvm` in Docker) for database credentials.
- A checkout (or copy) of this repository with `node_modules` installed
  (for the `argon2` and `pg` packages). Nothing is installed or changed by
  the script besides the database rows below.

## Procedure

1. From the repository root, run:
   ```bash
   PROXVM_CONFIG_DIR=/data/.proxvm node scripts/break-glass.mjs <username>
   ```
   Use an existing admin username to reset it, or a new name to create a
   fresh administrator. The script prompts for the new password (minimum 12
   characters); prefer `PROXVM_BG_PASSWORD=...` only in a private shell —
   command lines are visible in process listings.
2. The script sets an Argon2id hash (same parameters as the app), re-enables
   and unlocks the account, grants ADMIN, and revokes all of its sessions.
3. Log in normally with the new password.
4. **Immediately after recovery:** rotate every other administrator
   credential, review the audit log for how access was lost, and re-secure
   whatever allowed this situation (exposed ports, shared passwords).

## What it cannot do

- It cannot run without database credentials — losing `config.json` means
  restoring from backup, not break-glass.
- It does not touch Guacamole, Proxmox, or VM guest passwords; recover those
  through their own consoles.
- Every use should itself be audited out-of-band (who ran it, when, why):
  the script writes no audit row because the audit system may be part of
  what is broken.

## Preventing the need

- Keep at least two active administrators (the app refuses to disable or
  delete the last one — do not work around that).
- Store one admin password in a password manager or sealed envelope.
- Never expose the API port without TLS termination and authentication in
  front of it.
