> **If you are Vihaan's agent:** read [`AGENTS-VIHAAN.md`](../AGENTS-VIHAAN.md) first. Branch from the latest `main`, open every PR against `main`, and follow its verification, branch, and secrets rules.

# Start on host boot

Any VM can power itself on automatically when its Proxmox node boots.
Opt-in per VM; everything defaults to off exactly as before.

## How it works

ProxVM manages Proxmox's native `onboot` guest flag — no ProxVM-side
polling, no extra moving parts:

1. VM page → **Start on host boot → On**. ProxVM sets `onboot: 1` on the
   guest in Proxmox and records the desired state locally.
2. On the next node boot, **Proxmox itself** starts the flagged guests
   (in `order` sequence when a start order is configured on the node).
   Guests without the flag stay stopped.
3. Turning the toggle off clears the flag (`onboot: 0`).

The Proxmox write happens first: if Proxmox rejects the flag change
(VM gone, permission missing), the local record is left untouched so the
two never disagree after a successful call. Every change is audited as
`VM_START_ON_BOOT_CHANGED`.

## Operating it

- Mark infrastructure that must survive a power event (tunnels,
  monitoring, Guacamole box) as **On**; leave the rest **Off**.
- Changing it needs `vm.edit` (it alters power behavior), same as VM class.
- Guest OS boot time still applies — RDP/SSH accepts connections only
  once the guest's own services are up.

## Limits and honest notes

- This is node boot, not Proxmox-cluster magic: a VM starts on the node
  that hosts it. Migrating a VM to another node keeps the flag (it lives
  in the guest config), so it still starts there after that node's boot.
- Proxmox starts guests in parallel unless a start order is set on the
  node — on a big outage, set `order`/`up` delays in Proxmox for guests
  that depend on each other (e.g. database before app).
- A VM deleted in Proxmox directly keeps its ProxVM row (same as every
  other per-VM setting); delete through ProxVM to clean up.
