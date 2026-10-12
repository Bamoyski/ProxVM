# Billing foundations: metering, quotas, announcements, tickets

All four ship **inert by default**: no quotas set, no tickets filed, no
announcement posted, no metering rows until a VM actually runs. Existing
installs see zero behavior change (full suites green, no migration surprises).

## Usage metering (the billing base)

- Source of truth is the **live Proxmox power state**, reconciled every 5 min
  by a ticker (`runMetering` in `apps/api/src/app.ts`), plus an immediate
  close on VM delete. Out-of-band power-ons (someone clicks Start in Proxmox
  directly) are still billed — the reconciler opens the period on sight.
- Storage: `vm_power_periods` (one row per power cycle, `ended_at NULL` =
  running). Transitions only, never polled rows, so the table stays tiny.
- Reads: `GET /usage/summary?month=YYYY-MM` and `GET /usage/export` (CSV),
  both `users.manage` (admins). UI: **Usage** page (nav, admins) with month
  picker, totals, and CSV export for invoicing.
- Money mapping: hours × your rate = the invoice line. Attribution today is
  per-VM (bill the VM owner); per-user rollups are the obvious next step.

## Quotas (the tier lever)

- `users.max_vms`, `NULL` = unlimited (everyone, by default).
- Enforced once, at `POST /vms/provision`, for non-ADMINs: live VM count
  (created-by + not deleted) ≥ quota → `403` + `QUOTA_DENIED` audit event +
  "contact your administrator" message. Admins are exempt (they run the infra).
- Managed per-user from the **Users** page (Quota button → inline editor).
  `GET/PUT /users/:id/quota` (`users.manage`), changes audited as
  `QUOTA_CHANGED`.
- Money mapping: Free tier = low quota, paid tiers = higher. The 403 message
  is intentionally a sales conversation starter.

## Announcements (ops comms)

- Settings-backed (`app.announcement_text`/`app.announcement_level`), edited
  in **Settings → Application**, shown as a banner to every signed-in user.
  Dismissal persists per announcement text (localStorage keyed by content, so
  edits reappear for everyone). Levels: info (blue) / warn (amber).
- Reads: `GET /announcement` (any authenticated user).
- Money mapping: maintenance windows, new tiers, "support hours changed" —
  free, instant, no emails.

## Support tickets (the support-plan seed)

- `POST /tickets` (any authenticated user, 20/hour rate limit),
  `GET /tickets` (own tickets; admins see the whole queue + filter by status),
  `PATCH /tickets/:id` (admins: open/answered/closed). Audited
  (`TICKET_CREATED`, `TICKET_STATUS_CHANGED`).
- UI: **Support** page (nav, everyone) with file form, status filters, and
  admin actions inline.
- Money mapping: today's queue is tomorrow's "priority support" SLA —
  response-time tracking per tier is the natural paid upgrade.

## What's deliberately NOT here yet

- No money moves (no Stripe/billing provider integration).
- No per-user rollups or rate tables (CSV + spreadsheet first).
- No automatic enforcement beyond provision-time quota (no
  suspend-on-nonpayment — that stays a human decision until the business
  says otherwise).
