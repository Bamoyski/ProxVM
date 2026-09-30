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

Default ruleset on isolate (all stamped `proxvm-isolation:*`):

- IN TCP 22, 3389, 5900:5910 from one source (defaults to the Guacamole host
  derived from the Guacamole URL setting; override per isolate).
- OUT UDP+TCP 53 to one resolver (optional; empty = no DNS).
- Custom extras as given.

With cloud-init static IPs (ProxVM's provisioning flow) the guest needs no
DHCP, so a default-isolated VM is fully usable over remote session while
being unable to reach anything else — including the LAN, the internet, and
other VMs.

## Operating it

- **VM page → Network isolation**: toggle, live policy/rule readout, add and
  remove rules. Removing isolation deletes only `proxvm-isolation` rules and
  restores ACCEPT policies; hand-made rules are listed, never touched, and
  cannot be deleted from ProxVM (edit those in ProxMOX directly).
- **VM list** shows 🛡️ on isolated machines; the detail section shows the
  live rule table with positions.
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
- Guests that need DHCP, NTP, updates, or package installs need explicit
  outbound rules (DNS + 80/443 to your mirror of choice). There is no
  auto-discovery of "what this guest needs" — that stays an operator call.
