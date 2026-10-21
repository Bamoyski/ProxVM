# Ground-truth drift detection

ProxVM's database is a *model* of reality. Reality is Proxmox, the guests
inside them, and the Guacamole database. The two can disagree silently: a
guest deleted from the Proxmox UI, a VM renamed or resized outside the app,
a DHCP lease that moved, a root password rotated, a node that fell back and
came back with a different name.

This feature reconciles the two on a schedule and records the differences as
**findings**. Detection is automatic and read-only. Remediation is always a
separate, explicit, confirmed human action.

## What it detects

| Dimension | Fingerprint | Source of truth | Severity |
|---|---|---|---|
| Out-of-band deletion | `deleted:<vmId>` | cluster guest list | high |
| Config (name / node) | `config:<vmId>:<field>` | cluster guest list | low / medium |
| Hardware (cores / memory / net) | `hw:<vmId>:<field>` | pass-to-pass vs. `drift_vm_state` baseline | medium |
| IP address | `ip:<vmId>` | guest agent vs. recorded | medium |
| Orphaned Guacamole connection | `guac:<connectionId>` | app DB vs. known VMs | low |
| Credential staleness | `credential:<vmId>` | SSH probe (24 h cooldown, max 10/pass) | high |

Case-only name differences are ignored: Proxmox lowercases resource names,
so a case change alone is not a rename.

## Turning it on

Drift detection is **off by default**. A pass opens SSH connections to
guests and probes the stored passwords, so an operator has to switch it on
deliberately:

- **Settings → Application → "Enable drift detection"** (writes the
  `drift.enabled` setting), or
- `PUT /api/settings/app` with `{"driftEnabled": true}`.

Anything other than an explicit `true` means off.

## Lifecycle

```
OPEN -> ACKNOWLEDGED -> RESOLVED (auto | manual | remediation)
  ^__________ re-detected drift re-opens the same row (occurrences + 1)
```

One row per deterministic fingerprint (UNIQUE). A re-detected drift re-opens
the same row and bumps `occurrences` instead of spawning duplicates.

**A finding is only auto-resolved when its check actually ran and did not
reproduce.** "Not observed" is not "verified fixed": if the guest agent is
down, the SSH probe is in its cooldown, the probe cap was hit, or the
Proxmox config read failed, the findings for that dimension are *preserved*.
The scope is the (VM, dimension) pair — a config finding whose name no
longer differs still resolves even when that VM's credential probe was
inconclusive.

`last_seen` advances on every reproducing pass. `remediated_at` /
`remediated_by` are the *last* remediation and survive a re-occurrence: the
resolution history is the point of persisting findings at all.

## Exemptions and safety rails

- VMs with an active provisioning job are skipped entirely (config/IP
  legitimately disagree mid-provisioning).
- **Deletion detection compares against the full guest list, templates
  included.** A guest converted to a Proxmox template still occupies its
  vmid, so it is not deleted.
- **A cluster view that looks partial suppresses deletion findings.** A
  node that is offline, or invisible to the API token, makes
  `/cluster/resources` silently incomplete; treating that as "these guests
  were deleted" would recommend destroying live records. The decommission
  remedy applies the same guard and refuses with a conflict.
- A guest that reappears makes the finding stale; acting on it is refused.

## Remediation

Remediation re-verifies the drift against live state right before acting and
refuses stale findings, reappeared guests, and VMs with active jobs.

| Action | What it does | Extra requirements |
|---|---|---|
| Adopt | records the live name/node, or the live hardware, as the new baseline | — |
| Re-sync IP | writes the guest agent's address to the record and the console connection | refuses statically assigned addresses |
| Delete orphan connection | removes the leftover console record | refuses when another VM still uses the same connection name |
| Decommission | soft-deletes the record and removes its console connections | **`vm.delete` + `guac.manage`**, plus the typed confirmation `DECOMMISSION <vm name>` |
| Acknowledge | marks the finding known-and-tolerated | — |

The typed confirmation is enforced **by the API**, exactly like
`DELETE /vms/:id` (`DELETE <name>`). A confirmation that exists only in the
browser is a UX nicety, not a control.

Decommission also replicates the cleanup the canonical delete path performs
(`DELETE /vms/:id`): a soft delete is an UPDATE, so the FK cascades never
fire and the access grants, the stored credential and an open metering
period would all survive.

## Permissions and privacy

- `drift.manage` (deny-by-default; ADMIN holds it, custom roles can be
  granted it) gates every endpoint.
- Findings that reference a VM are filtered through the same flag-aware
  `visibleTo` gate as every other VM route. A privacy-flagged VM's findings
  are invisible — and un-actionable — to anyone without a concrete grant,
  including administrators. Invisible findings read as 404.
- Every remediation and acknowledgement writes a redacted audit entry
  (`DRIFT_REMEDIATED` / `DRIFT_FINDING_ACKNOWLEDGED`).

## Operating

- A detection pass runs every 15 minutes from the API process ticker, and
  on demand from the Drift board (`POST /api/drift/run`, rate limited to
  10/hour). Only one pass runs at a time — the ticker and the manual
  endpoint share one guard, so a manual run cannot stack with a ticker pass
  and defeat the SSH-probe cooldown.
- The pass fails open: disabled, unconfigured Proxmox, or an unreachable
  Proxmox means nothing was checked and nothing changed. The reason is
  persisted so the board can say the last pass was skipped instead of
  showing a stale board as if it were healthy.
- Credential probes are SSH-only for now (Windows RDP port probing can only
  prove the port is open, which says nothing about the credential), capped
  at 10 per pass, with a 24-hour per-VM cooldown.
