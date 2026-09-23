import { PageTitle } from "../components/ui.js";

interface HelpSection {
  id: string;
  title: string;
  about: string;
  steps: string[];
  /** Permission needed to use the page. Omit for guides every logged-in user can follow. */
  perm?: string;
}

const SECTIONS: HelpSection[] = [
  {
    id: "getting-started",
    title: "Getting started",
    about:
      "The first time you open ProxVM, a setup wizard configures the administrator account and all service connections. Afterwards you log in with your username and password.",
    steps: [
      "Open the app and work through the setup wizard: create the administrator, then configure ProxMOX, Guacamole, the application database, and Redis.",
      "Use each step's Test button — the wizard runs a real connection check before letting you continue.",
      "Finish the wizard and restart the API/worker processes when asked, then log in as the administrator.",
      "If you ever see a blank error instead of data, the service behind that page is unreachable — the message tells you which one.",
    ],
  },
  {
    id: "dashboard",
    title: "Dashboard",
    about:
      "Your landing page. It summarizes the state of the platform: your virtual machines, recent provisioning jobs, and — for privileged roles — Proxmox cluster status and recent audit events.",
    steps: [
      "Scan the VM list for anything stopped or failed that needs attention.",
      "Follow a recent job to see whether provisioning finished or needs a retry.",
      "Administrators and operators also see Proxmox node/storage health and the latest audit entries here.",
    ],
  },
  {
    id: "vms",
    title: "Virtual Machines: viewing and managing",
    perm: "vm.read",
    about:
      "The Virtual Machines page lists every VM you are allowed to see. Regular users only see VMs explicitly assigned to them; privileged roles may also discover untracked Proxmox guests.",
    steps: [
      "Click a VM name to open its detail page.",
      "Use START, STOP, or RESTART to change power state (needs the matching permission).",
      "Use OPEN GUACAMOLE to launch a remote session — pick the protocol (SSH, RDP, or VNC) you were granted.",
      "Use EDIT to change resources or manage which users can access the VM.",
      "Deleting a VM is destructive: type DELETE followed by the VM name to confirm, and the Proxmox VM plus its Guacamole connections are really removed.",
    ],
  },
  {
    id: "provisioning",
    title: "Virtual Machines: provisioning a new VM",
    perm: "vm.create",
    about:
      "Provisioning clones a registered template on Proxmox, configures it with cloud-init, waits for the guest agent, discovers the IP, verifies the credentials, and creates the Guacamole connections — as a tracked background job.",
    steps: [
      "Make sure a matching template is registered first (see Templates).",
      "Click Provision VM and fill in the name, template, node, storage, and network (bridge, optional VLAN tag, DHCP or static IP).",
      "Set the cloud-init username and a strong guest password — it is stored encrypted in the credential vault.",
      "Submit and watch the job stream through VALIDATE → CLONE → START → WAIT_FOR_GUEST → VERIFY → READY.",
      "If a step fails, the job shows the real error: fix the cause and RETRY to resume from the last successful step, KEEP it for debugging, or roll it back.",
    ],
  },
  {
    id: "templates",
    title: "Templates",
    perm: "templates.manage",
    about:
      "Templates are the Proxmox VM templates you are allowed to clone from. Linux templates must be cloud-init enabled with the QEMU guest agent installed; Windows templates must be prepared with Cloudbase-Init.",
    steps: [
      "Register a template with its Proxmox VM ID, node, operating system type, and login username.",
      "Templates marked unattend or none are refused — automated provisioning cannot configure them, and ProxVM will not pretend otherwise.",
      "Edit or remove templates you no longer want offered in the provisioning flow.",
    ],
  },
  {
    id: "vm-detail",
    title: "VM detail page",
    perm: "vm.read",
    about:
      "Everything about one VM: live status and IP, power actions, remote-access connections per protocol, stored credentials, and who else can access it.",
    steps: [
      "Check status, node, IP address, and operating system at the top.",
      "Open the Guacamole section to launch a session for a specific protocol, or manage the connections (privileged).",
      "In the credentials section you can reveal or copy the guest password (audited) and rotate it — rotation updates Proxmox/cloud-init records, the vault, and the Guacamole parameters together.",
      "In the access section you can grant or revoke other users, optionally limited to certain protocols or an expiry time.",
    ],
  },
  {
    id: "guacamole",
    title: "Guacamole (remote access)",
    perm: "guac.launch",
    about:
      "ProxVM writes real connections, users, and permissions into the Guacamole database and launches sessions through the Guacamole web application. This page manages those connections.",
    steps: [
      "Each VM gets one connection per protocol (SSH on port 22, RDP on 3389, VNC on 5900).",
      "Launching passes your login through the Guacamole token API, so you land directly in the session.",
      "If a launch fails, check that the Guacamole web app and its database are reachable in Settings, and that the VM has an IP.",
      "Removing a VM's connections revokes remote access without touching the VM itself.",
    ],
  },
  {
    id: "credentials",
    title: "Credentials vault",
    perm: "cred.reveal",
    about:
      "Every VM guest password is encrypted with AES-256-GCM and stored in the vault. Nothing is ever logged, and passwords only leave the server through audited reveal/copy endpoints.",
    steps: [
      "Find the VM whose password you need and reveal or copy it — both actions are written to the audit log.",
      "Use rotation (from the VM page) instead of manual changes whenever possible, so Guacamole stays in sync.",
      "If you do change a guest password inside the VM yourself, update the vault entry so future launches keep working.",
    ],
  },
  {
    id: "users",
    title: "Users",
    perm: "users.manage",
    about:
      "Administrators create and manage application accounts here: roles, active/disabled state, direct permission grants, and per-user effective-permission views.",
    steps: [
      "Create a user with a username and a strong password (12+ characters with mixed case, number, and symbol).",
      "Assign a base role (ADMIN, OPERATOR, or USER) — most people should be USER plus targeted grants.",
      "Open a user's permissions page to see exactly what they hold and where each permission comes from.",
      "Disable rather than delete accounts you might need again; five failed logins lock an account automatically.",
      "New people request accounts from the login page (password rules are shown live); approve or reject them in the pending-requests box with the role they should start with.",
    ],
  },
  {
    id: "roles",
    title: "Roles",
    perm: "roles.manage",
    about:
      "Roles bundle permissions. ADMIN, OPERATOR, and USER are built in; you can also create custom roles (plus ready-made presets like Viewer or VM Operator) for finer control.",
    steps: [
      "Inspect a role to see its permission set — each permission shows its short description.",
      "Create custom roles with exactly the permissions a job function needs; nothing is granted by default.",
      "You can only confer permissions you hold yourself, so an administrator must set up the first custom roles.",
      "System roles are protected from deletion and dangerous edits.",
    ],
  },
  {
    id: "groups",
    title: "Groups",
    perm: "groups.manage",
    about:
      "Groups organize users and hand them roles, VM access, or both at once — optionally expiring. A student's access for one semester is one group with an expiry date.",
    steps: [
      "Create a group and add members by username, optionally with a 1-hour, 1-day, or 1-week expiry.",
      "Assign roles to the group: every member inherits those roles' permissions while the link is live.",
      "Grant VM access to the group, optionally restricted to specific protocols (e.g. RDP only) and an expiry.",
      "Check the Effective permissions section to see the union of everything the group's roles confer, and which role each permission comes from.",
    ],
  },
  {
    id: "privacy",
    title: "Private VMs (privacy flag)",
    perm: "vm.read",
    about:
      "A privacy-flagged VM is invisible to everyone without a direct grant — including administrators and operators. The normal admin bypass does not apply.",
    steps: [
      "Open the VM and use Turn on in the privacy section — no user setup needed, and no special rights: anyone who can see the VM can flip it. Whoever created the VM always counts, so there is nothing to configure first.",
      "Administrators can also flip it blind; flipping never grants data by itself, and every change is audited.",
      "Let people in with the Invite action or the access section: only someone the VM is shared with can bring in the next person.",
      "Administrators without a grant see nothing: no list row, no detail, no launch, no credentials, no jobs, no audit entries.",
      "Withdrawing your own invite, or expiry of a temporary grant, locks the person out again immediately.",
    ],
  },
  {
    id: "matrix",
    title: "Permission Matrix",
    perm: "users.manage",
    about:
      "The matrix answers 'who can do what': one row per user, one column per permission, a ✓ wherever it is held. Hover a ✓ to see the source (role, group, or direct grant).",
    steps: [
      "Search by user, role, or group name; filter columns by category or permission text (descriptions match too).",
      "Hover a column header for a permission's short description, or click its ⓘ button for the full detail card.",
      "Tick 'Only users holding the filtered permission' with exactly one permission visible to list just its holders.",
      "The permission catalog itself (codes, categories, descriptions) is seeded by the system and identical for everyone.",
    ],
  },
  {
    id: "jobs",
    title: "Provisioning Jobs",
    perm: "jobs.read",
    about:
      "Every provisioning run is a tracked job with a live event stream. Jobs survive restarts and can be retried from the last successful step.",
    steps: [
      "Open a job to follow its progress step by step with real backend messages.",
      "On failure, read the error, fix the underlying cause (template, storage, network, credentials), then RETRY.",
      "Use rollback (delete the VM) for runs you want fully cleaned up, including Proxmox and Guacamole resources.",
      "Jobs waiting for a guest agent reschedule themselves automatically — give slow-booting VMs time before intervening.",
    ],
  },
  {
    id: "audit",
    title: "Audit Log",
    perm: "audit.read",
    about:
      "A tamper-evident record of who did what: logins, permission changes, VM lifecycle, credential reveals/copies/rotations, access grants, and settings changes. Secret values are redacted.",
    steps: [
      "Filter by event type, user, or VM to investigate something specific.",
      "Credential reveal/copy entries tell you exactly who saw a password and when.",
      "Denied-authorization entries help diagnose 'why can't Alice do X' without guessing.",
    ],
  },
  {
    id: "settings",
    title: "Settings",
    perm: "settings.manage",
    about:
      "System connections and defaults: Proxmox URL and API token, Guacamole URL and database credentials, default node/storage/network, and session behavior.",
    steps: [
      "Change one section at a time and use its Test button before saving.",
      "The Guacamole public URL is what your browser opens — it can differ from the server-side URL in Docker setups.",
      "Wrong credentials here break provisioning and launches everywhere, so the audit log records every settings change.",
    ],
  },
  {
    id: "health",
    title: "Health",
    perm: "health.read",
    about:
      "Live reachability of everything ProxVM depends on: Proxmox, Guacamole (web + database), PostgreSQL, and Redis.",
    steps: [
      "If a page shows errors, check Health first — it names the failing dependency.",
      "Database or Redis failures affect the whole app; Proxmox or Guacamole failures only affect the features built on them.",
    ],
  },
];

export default function Help({ can }: { can: (perm: string) => boolean }) {
  const visible = SECTIONS.filter((s) => !s.perm || can(s.perm));
  const hidden = SECTIONS.length - visible.length;
  return (
    <div className="max-w-4xl">
      <PageTitle title="Help & Tutorials" />
      <p className="text-sm text-slate-400 mb-6">
        Step-by-step guides for the pages you have access to.
        {hidden > 0 && (
          <span className="ml-1">
            {hidden} {hidden === 1 ? "guide" : "guides"} {hidden === 1 ? "is" : "are"} hidden
            because your account lacks {hidden === 1 ? "its" : "their"} permission.
          </span>
        )}
      </p>
      <div className="bg-slate-900 border border-slate-800 rounded p-5 mb-6">
        <h2 className="text-sm font-medium text-slate-300 mb-3">Contents</h2>
        <ol className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {visible.map((s, i) => (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                className="flex items-center gap-3 bg-slate-800/60 hover:bg-slate-800 border border-slate-700/50 hover:border-blue-500 rounded px-3 py-2.5 transition-colors"
              >
                <span className="shrink-0 w-6 h-6 rounded-full bg-blue-600/20 border border-blue-500/50 text-blue-300 text-xs font-semibold flex items-center justify-center">
                  {i + 1}
                </span>
                <span className="text-sm text-slate-200">{s.title}</span>
              </a>
            </li>
          ))}
        </ol>
      </div>
      <div className="space-y-6">
        {visible.map((s, i) => (
          <section key={s.id} id={s.id} className="bg-slate-900 border border-slate-800 rounded p-4 scroll-mt-4">
            <h2 className="text-base font-medium text-slate-200 mb-1">
              <span className="text-slate-500 mr-2">{i + 1}.</span>
              {s.title}
            </h2>
            <p className="text-sm text-slate-400 mb-3">{s.about}</p>
            <ol className="list-decimal list-inside space-y-1.5 text-sm text-slate-300">
              {s.steps.map((step, j) => (
                <li key={j}>{step}</li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
