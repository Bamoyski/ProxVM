# Idle auto-shutdown

User-class VMs shut themselves down after sustained disuse; server-class
VMs are never touched. Everything defaults to off, so existing installs see
zero behavior change.

## Eligibility (ALL must hold at a 5-minute tick)

1. Global switch on: Settings → Application → "Shut down idle user VMs".
2. VM class is **user** (VM page → VM class; every VM starts as **server**).
3. Guest actually running in Proxmox.
4. Zero active Guacamole sessions on any of the VM's connections.
5. Average guest CPU at or below threshold over the window (default 5%).
6. Last session ended at least `idleMinutes` ago (default 120).
7. At least one ended session exists — a freshly provisioned box nobody ever
   opened is *not* treated as abandoned.

Anything unknown (CPU unreadable, Guacamole unreachable) fails safe toward
leaving the machine running. Shutdown is graceful ACPI with task wait; each
one is audited as `VM_AUTO_SHUTDOWN` with the reason. Metering closes the
period on the next reconcile pass automatically.

## Why sessions + CPU, not just one

- Sessions alone would kill long compiles: a user with no RDP attached but
  a hot CPU is clearly using the machine.
- CPU alone would kill idle-but-watched sessions: someone reading docs over
  RDP at 1% CPU is clearly *there*.
- Both together mean: nobody connected and nothing happening. That is the
  only state worth acting on without asking.

## Operating it

- Mark desktops/user VMs as **User** class; leave infrastructure
  (templates hosts, monitoring, tunnels, Guacamole box) as **Server**.
- Tune minutes (5–10080) and CPU threshold in Settings → Application.
- Watch `VM_AUTO_SHUTDOWN` in the audit log for exactly what happened and why.
- Edge case: already-established *guest-side* flows (an outbound SSH the
  guest opened itself) are not force-killed by ACPI shutdown semantics any
  differently than a manual Stop — same button, same behavior.

## Deliberately not included (yet)

- Per-VM custom idle minutes (global only for now).
- Provision-time class selection (set it on the VM page after provisioning).
- Wake-on-LAN / auto-start on launch attempt (a stopped VM still launches
  fine on demand — sessions just need the VM running first).
