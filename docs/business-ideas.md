# Business ideas for ProxVM (bamoyskistudios)

Ordered roughly by money-soonest. Anything marked [NEEDS] is a prerequisite,
not a suggestion — the AI-generated/production warning stays up until the
"before taking money" list in `hosting-readiness.md` is done.

## Now (no new code)

1. **Paid homelab setup calls** — flat-fee video-call setup of ProxVM +
   Proxmox + Guacamole. Highest $/hour available today; every call also
   teaches you what to productize.
2. **Ko-fi tiers with lab-flavored rewards** — e.g. "name a VM", vote on the
   next feature, supporters page. The "two 15-year-olds" story is the asset;
   lean into it.
3. **Build-in-public content** — one short video/post per week (bugs fixed,
   features shipped, lab tours). Audience compounds into users, donations,
   customers — in that order.
4. **"Office-hours" support retainer** — one small business or creator pays
   monthly for a Slack/Discord channel where you keep their one server alive.
   Precursor to MSP work.

## Next (built last night — sell the workflow)

5. **Usage-based billing** — the metering + CSV export from this batch *is*
   the invoice pipeline. Rate card × exported hours, send the invoice.
6. **Tiered quotas as pricing** — Free: 2 VMs. Hobby: 10. Pro: unlimited +
   priority tickets. The quota gate + deny message already frames the upsell.
7. **Priority support SLA** — same ticket queue, but paid tiers get response
   times. Add `responded_at` tracking per tier when the first customer asks.
8. **Maintenance windows as a feature** — announcements + scheduled power
   already cover "we patch Sundays 2–4 AM". Sell it as managed ops, not
   downtime.
9. **Onboarding service for teams** — per-seat setup: accounts, groups, VM
   grants, first templates. The IAM system makes this a checklist, not a
   project.

## Later (needs hardening first)

10. **Managed Proxmox for small business** — you run the control plane (or
    remote-manage theirs), monthly per node/VM. Best revenue per customer on
    this list. [NEEDS] contracts/SLA, backup story, an adult co-signer.
11. **Open-core SaaS** — free MIT core; paid: SSO/SAML, compliance audit
    exports, multi-cluster fleet view, backup integrations. Per-seat or
    per-node. [NEEDS] human security review.
12. **White-label for schools/clubs** — robotics teams, esports clubs, CS
    classes need exactly this (safe student VMs + RDP in browser). Per-org
    pricing. [NEEDS] student-data care (privacy flags already help).
13. **Template marketplace** — curated one-click stacks with revenue share.
    Side quest; crowded.
14. **Uptime SLA tier** — external monitoring + guaranteed response, priced
    from the metering + ticket data you already collect. [NEEDS] on-call
    rotation (of two teenagers — price accordingly).

## Structural notes (boring, load-bearing)

- **Age mechanics:** LLC, business bank account, and Stripe payouts all need
  a parent/guardian co-signer at 15. Line that up before the first invoice,
  not after.
- **The production warning is the launch gate.** Removing it after a real
  human review is practically the business launch event — announce it.
- **Keep the free tier genuinely useful.** Every paid conversion in this
  market starts as a homelabber who outgrew free. The quota numbers *are*
  the funnel — tune them from real usage data, not guesses.
- **Never auto-delete for money reasons.** Suspend (block launches) on
  nonpayment; deletion stays human-approved. Billing disputes over deleted
  VMs are how you lose the business.
