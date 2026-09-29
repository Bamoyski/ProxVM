# ProxVM

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Self-Hosted](https://img.shields.io/badge/self--hosted-homelab-blue.svg)](#)
[![Proxmox VE](https://img.shields.io/badge/Proxmox-VE-orange.svg)](#)
[![Apache Guacamole](https://img.shields.io/badge/Apache-Guacamole-green.svg)](#)

> **ProxVM** is an **open-source virtual-machine management** project for
> **Proxmox VE** and **Apache Guacamole**.
>
> ## ⚠️ WARNING — AI-Generated Code / Do Not Use in Production
> **This entire project is 100% AI-generated.**
>
> The code in this repository was generated and modified by AI coding agents. It was **not written, reviewed, or professionally audited by a human software engineer**. Although testing and security analysis have been performed, passing tests and automated security scans do **not** mean that this software is secure or suitable for real-world use.
>
> **Do not deploy this software to production. Do not use it to manage real infrastructure, accounts, credentials, virtual machines, networks, or other sensitive systems.**
>
> This repository is published primarily for **experimentation, learning, research, and demonstration purposes**. Any security vulnerabilities, bugs, unsafe assumptions, or other problems may still exist.
>
> If you choose to run it anyway, assume that **the code is untrusted and potentially insecure**.
>
> **Use at your own risk.**
>
> Repository and documentation: <https://github.com/Bamoyski/ProxVM>

ProxVM is a real VM management platform for **Proxmox VE** and **Apache Guacamole**. It provisions real VMs from real templates via cloud-init, discovers the real guest IP through the QEMU guest agent, verifies guest credentials over SSH (Linux) / RDP port probe (Windows), creates real Guacamole connections in the Guacamole database, and launches real remote sessions.

No mock data, no simulated infrastructure. If a service is unreachable, the UI shows the real error.

## Architecture

```
apps/web      React + Vite + Tailwind frontend
apps/api      Fastify REST API (sessions, RBAC, CSRF, audit, Proxmox/Guac integration)
apps/worker   BullMQ worker executing the provisioning pipeline
packages/core Shared domain logic (crypto, DB, Proxmox client, Guacamole, provisioning)
packages/shared Zod schemas + types
```

- **Application DB**: PostgreSQL (own schema, migrations)
- **Jobs**: Redis + BullMQ (`proxvm:provisioning` queue, reschedule-on-wait design)
- **Guacamole**: connections/users/permissions are written to the real Guacamole SQL database (Postgres), matching the JDBC auth extension schema. Launch uses the Guacamole REST token endpoint (`/api/tokens`, Guacamole 1.4+) when available, otherwise opens the Guacamole login page.
- **Proxmox**: official REST API2 with API tokens. TLS verification is configurable.
- **Credentials**: AES-256-GCM authenticated encryption with a per-install master key. Passwords are hashed with Argon2id (application users). VM passwords are never logged and never sent to the frontend except through audited reveal/copy endpoints.
- **Sessions**: server-side sessions in PostgreSQL, httpOnly SameSite=strict cookies, CSRF token per session, idle timeout, account lockout after 5 failed logins.

## Running

### Development

```bash
npm install
npm run dev          # api :4000, worker, web :5173
```

You need PostgreSQL and Redis reachable (local or remote). On first start, open http://localhost:5173 — the **setup wizard** guides you through:

1. Create the administrator
2. Configure Proxmox (URL, API token ID/secret, SSL verify, defaults)
3. Real Proxmox connection test
4. Configure Guacamole (URL + Guacamole database credentials)
5. Real Guacamole test (DB + schema check + web reachability)
6. Application database + Redis (real connection tests)
7. Encryption initialization (master key generated into `.proxvm/config.json`, ACL-restricted, gitignored)
8. Integration checks (real checks against all services)

### Docker

```bash
docker compose up -d
# open http://localhost:8080
# In the wizard use: database host "postgres", redis host "redis"
```

## Provisioning pipeline

```
VALIDATE_PROXMOX_RESOURCES → CLONE_TEMPLATE → CONFIGURE_VM →
CONFIGURE_GUEST_PROVISIONING (cloud-init: user/password/network) →
START_VM → WAIT_FOR_GUEST (guest agent) → DISCOVER_IP (agent → static → override) →
VERIFY_GUEST → VERIFY_CREDENTIALS (SSH auth for Linux; RDP port for Windows) →
CREATE_GUACAMOLE_CONNECTION → VERIFY_GUACAMOLE → READY
```

- Failure at any step marks the job FAILED with the real error; nothing is silently destroyed.
- Jobs in WAITING_FOR_GUEST are automatically rescheduled (30 s interval, 30 attempts).
- Failed jobs can be RETRIED (resumes from the last successful step), KEPT for debugging, or rolled back (DELETE VM).

## Template requirements

- **Linux**: cloud-init enabled template (cloud-init drive present), `qemu-guest-agent` installed in the image, cloud-init user/password supported.
- **Windows**: only templates prepared with **Cloudbase-Init** on the Proxmox cloud-init drive are supported for automated provisioning. Templates registered as `unattend`/`none` are explicitly refused — the app will not pretend to provision them.

## Privacy

ProxVM is self-hosted: all accounts, credentials, configuration, and audit
data stay on the operator's infrastructure. The application sends nothing to
third parties (no telemetry, analytics, or tracking), sets a single
strictly-necessary session cookie, and never logs plaintext secrets. The
in-app **Legal** page carries the full privacy policy and terms of use.

## Security notes

- All secrets in the app database are AES-256-GCM encrypted with the master key in `.proxvm/config.json` (restrict file permissions; it is excluded from git).
- Audit log redacts any detail keys that look secret-like (`*password*`, `*token*`, `*secret*`).
- GUI destructive actions require typing `DELETE <name>`.
- Login rate limiting (10/min/IP) + account lockout; global API rate limit 400/min.
- Never put secrets in frontend code, git, or logs.

## Tests

```bash
npm test                   # offline unit + service tests (pg-mem, ioredis-mock)
npm run test:integration   # real-infrastructure tests (requires configured services)
```

Integration tests run against your REAL Proxmox/Guacamole once the app is configured.

## End-to-end provisioning test strategy

1. Register a real Linux cloud-init template.
2. Provision a VM through the UI; watch the job SSE stream.
3. Verify: VM runs in Proxmox, has a real IP, SSH works with the vault credential.
4. Verify the Guacamole connection appears in the real Guacamole UI and an RDP/SSH session opens.
5. Rotate the credential; verify login with the new password and that the Guacamole parameter was updated.
6. Reveal/copy from the vault and confirm audit entries (PASSWORD_REVEALED / PASSWORD_COPIED / PASSWORD_ROTATED).
7. Stop/restart/delete the VM; confirm Proxmox and Guacamole resources are actually removed.

## Security

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities. Summary of controls: deny-by-default RBAC, server-side sessions with httpOnly SameSite=strict cookies, per-session CSRF tokens, login rate limiting + account lockout, AES-256-GCM credential encryption, Argon2id password hashing, audit log with secret redaction, and security regression tests.

Deployments should terminate TLS in front of the web service (the bundled compose file serves plain HTTP for local use) and restrict who can reach the setup wizard and API ports.

## License

ProxVM is licensed under the MIT License. See [LICENSE](LICENSE) for the full text.
