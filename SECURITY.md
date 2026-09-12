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
  per-session CSRF tokens, idle timeout, login rate limiting, and account
  lockout after repeated failures.
- AES-256-GCM authenticated encryption for stored secrets (per-install master
  key in `.proxvm/config.json`, never committed); Argon2id for application
  passwords; VM passwords are never logged.
- Audit log redacts secret-like detail keys (`*password*`, `*token*`,
  `*secret*`).
- Security regression tests (`iam-adversarial`, `rbac-authorization`, and the
  foundation auth tests) must keep passing — do not weaken them to make a
  change fit.
