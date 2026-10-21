> **If you are Vihaan's agent:** read [`AGENTS-VIHAAN.md`](../AGENTS-VIHAAN.md) first. Branch from the latest `main`, open every PR against `main`, and follow its verification, branch, and secrets rules.

# Network isolation ("default deny" per VM)

Any VM can be cut off from the network except for explicitly configured
traffic — typically just remote sessions in, nothing out. Opt-in per VM;
everything defaults to open exactly as before.

## How it works (networking-wise)

ProxVM drives the **Proxmox VE firewall at guest scope**:

1. One-time prerequisite (on each Proxmox node, by hand, once): the cluster
   firewall must be enabled (Datacenter → Firewall → Options → Firewall: Yes)
   and the `pve-firewall` service running. Without it, guest rules are
   silently ignored — so ProxVM *refuses* to isolate and says why, instead
   of pretending. ProxVM never touches datacenter/node/host firewall config
   itself; getting host lockout wrong would be catastrophic, so that stays
   a human step.
2. Per isolated VM, ProxVM sets the guest firewall `enable: 1` with
   `policy_in: DROP` and `policy_out: DROP`, then adds explicit ACCEPTs.
3. `conntrack` (stateful) still passes **established return traffic**, which
   is why Guacamole-initiated RDP/SSH/VNC keeps working: the session starts
   outside, the guest's replies ride the established flow. The guest itself
   cannot open anything new.

Default ruleset on isolate (all stamped `proxvm-isolation:*`, first match
wins inside each direction; ProxVM creates them last-first with explicit
pos 0 because Proxmox prepends every insert — probed live, never assume):

- IN TCP 22, 3389, 5900:5910 from one source (defaults to the Guacamole host
  derived from the Guacamole URL setting; override per isolate).
- OUT UDP+TCP 53 to one resolver (optional; empty = no DNS).
- OUT UDP 67 + IN UDP 68 (DHCP client; narrow ports only) — only with
  internet egress on.
- OUT DROP to 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16,
  127.0.0.0/8 — only with internet egress on. The guest cannot initiate
  anything toward the local network, other VMs, or the router.
- OUT ACCEPT everything else (i.e. the public internet) — only with
  internet egress on.
- Custom extras as given (appended last).

Internet egress defaults **on**: an isolated VM can use DNS and the
internet but cannot talk to the LAN. Turn it off per isolate for the
legacy posture (DNS only, no internet). With either setting the LAN can
never initiate toward the guest (policy_in DROP + no LAN inbound ACCEPTs),
and the guest's replies to Guacamole-initiated sessions ride conntrack.

## Operating it

- **VM page → Network isolation**: toggle, live policy/rule readout, add and
  remove rules. Removing isolation deletes only `proxvm-isolation` rules and
  restores ACCEPT policies; hand-made rules are listed, never touched, and
  cannot be deleted from ProxVM (edit those in Proxmox directly).
- **VM list** tags isolated machines (`isolated`) and privacy-flagged ones
  (`private`); the detail section shows the live rule table with positions.
- Everything is audited as `VM_FIREWALL_CHANGED` (toggle with rule counts,
  single-rule add with the rule, removal with the position).

## Limits and honest notes

- This is L3/L4 filtering at the tap device. It does not inspect traffic,
  does not stop a compromised guest from attacking *allowed* destinations,
  and does not replace VLANs/SDN segmentation for hostile multi-tenant
  setups — it is per-VM default-deny, which is the correct 90% answer.
- Rule changes apply live (no reboot), but already-established guest flows
  keep flowing until they close — isolating a VM does not kill its current
  outbound connections instantly; stop/start does.
- Guests that need NTP or specific mirrors need explicit outbound rules
  (DHCP and general internet are covered; NTP port 123 to a chosen server
  is not). There is no auto-discovery of "what this guest needs" — that
  stays an operator call.
- IPv4 only. The rule builder validates IPv4/CIDR destinations; IPv6
  ranges are not covered by the generated ruleset.
