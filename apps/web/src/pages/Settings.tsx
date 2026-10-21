import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageHeader, Section, Btn, Alert, Field, errText } from "../ui/index.js";

const input = "pv-input";
const label = "pv-label";

export default function Settings() {
  const qc = useQueryClient();
  const { data: proxmox } = useQuery({
    queryKey: ["settings-proxmox"],
    queryFn: () => api<{ configured: boolean; settings: Record<string, unknown> | null }>("/settings/proxmox"),
  });
  const { data: guacamole } = useQuery({
    queryKey: ["settings-guacamole"],
    queryFn: () => api<{ configured: boolean; settings: Record<string, unknown> | null }>("/settings/guacamole"),
  });
  const [px, setPx] = useState<Record<string, string>>({});
  const [gac, setGac] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const pxField = (key: string, def: unknown): string => px[key] ?? (def === undefined || def === null ? "" : String(def));
  const gacField = (key: string, def: unknown): string => gac[key] ?? (def === undefined || def === null ? "" : String(def));

  const saveProxmox = async () => {
    setError(null);
    try {
      await api("/settings/proxmox", {
        method: "PUT",
        body: {
          url: pxField("url", proxmox?.settings?.url ?? ""),
          tokenId: pxField("tokenId", proxmox?.settings?.tokenId ?? ""),
          tokenSecret: pxField("tokenSecret", proxmox?.settings?.tokenSecret ?? "") || "********",
          verifySsl: (pxField("verifySsl", String(proxmox?.settings?.verifySsl ?? "false")) === "true"),
          defaultNode: pxField("defaultNode", proxmox?.settings?.defaultNode ?? "") || undefined,
          defaultStorage: pxField("defaultStorage", proxmox?.settings?.defaultStorage ?? "") || undefined,
          defaultNetwork: pxField("defaultNetwork", proxmox?.settings?.defaultNetwork ?? "") || undefined,
        },
      });
      setSaved("Proxmox settings saved");
      void qc.invalidateQueries({ queryKey: ["settings-proxmox"] });
    } catch (err) {
      setError(errText(err));
    }
  };

  const saveGuacamole = async () => {
    setError(null);
    try {
      await api("/settings/guacamole", {
        method: "PUT",
        body: {
          dbEngine: (gacField("dbEngine", guacamole?.settings?.engine ?? "postgresql")) as "postgresql" | "mariadb" | "mysql",
          url: gacField("url", guacamole?.settings?.url ?? ""),
          publicUrl: gacField("publicUrl", guacamole?.settings?.publicUrl ?? ""),
          dbHost: gacField("dbHost", guacamole?.settings?.dbHost ?? ""),
          dbPort: Number(gacField("dbPort", String(guacamole?.settings?.dbPort ?? "5432"))),
          dbName: gacField("dbName", guacamole?.settings?.dbName ?? ""),
          dbUser: gacField("dbUser", guacamole?.settings?.dbUser ?? ""),
          dbPassword: gacField("dbPassword", guacamole?.settings?.dbPassword ?? "") || "********",
          dbSsl: gacField("dbSsl", String(guacamole?.settings?.dbSsl ?? "false")) === "true",
        },
      });
      setSaved("Guacamole settings saved");
      void qc.invalidateQueries({ queryKey: ["settings-guacamole"] });
    } catch (err) {
      setError(errText(err));
    }
  };

  const s = proxmox?.settings ?? {};
  const g = guacamole?.settings ?? {};

  return (
    <div className="pv-page">
      <PageHeader title="Settings" description="Connection details and instance behavior. Secrets stay masked." />
      {error && <Alert kind="err" title="Action failed">{error}</Alert>}
      {saved && <Alert kind="ok" title="Saved">{saved}</Alert>}
      <div className="pv-grid-2">
        <Section title="Proxmox">
          <Field label="URL"><input className={input} value={pxField("url", s.url)} onChange={(e) => setPx({ ...px, url: e.target.value })} /></Field>
          <Field label="Token ID"><input className={input} value={pxField("tokenId", s.tokenId)} onChange={(e) => setPx({ ...px, tokenId: e.target.value })} /></Field>
          <Field label="Token secret" hint="Stored value stays masked. Enter a new value only to replace it.">
            <input type="password" className={input} placeholder={String(s.tokenSecret ?? "")} value={pxField("tokenSecret", "")} onChange={(e) => setPx({ ...px, tokenSecret: e.target.value })} />
          </Field>
          <label className="pv-checkrow" style={{ marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={pxField("verifySsl", String(s.verifySsl ?? "false")) === "true"}
              onChange={(e) => setPx({ ...px, verifySsl: String(e.target.checked) })}
            />
            Verify SSL
          </label>
          <div className="pv-grid-3">
            <Field label="Default node"><input className={input} value={pxField("defaultNode", s.defaultNode)} onChange={(e) => setPx({ ...px, defaultNode: e.target.value })} /></Field>
            <Field label="Default storage"><input className={input} value={pxField("defaultStorage", s.defaultStorage)} onChange={(e) => setPx({ ...px, defaultStorage: e.target.value })} /></Field>
            <Field label="Default bridge"><input className={input} value={pxField("defaultNetwork", s.defaultNetwork)} onChange={(e) => setPx({ ...px, defaultNetwork: e.target.value })} /></Field>
          </div>
          <Btn kind="primary" onClick={saveProxmox}>Save</Btn>
        </Section>
        <Section title="Guacamole">
          <Field label="Database engine">
            <select
              className="pv-select"
              value={gacField("dbEngine", g.engine ?? "postgresql")}
              onChange={(e) => setGac({ ...gac, dbEngine: e.target.value })}
            >
              <option value="mariadb">MariaDB</option>
              <option value="mysql">MySQL</option>
              <option value="postgresql">PostgreSQL</option>
            </select>
          </Field>
          <Field label="URL"><input className={input} value={gacField("url", g.url)} onChange={(e) => setGac({ ...gac, url: e.target.value })} /></Field>
          <Field label="Public URL" hint="For the browser, e.g. https://guacamole.example.com/. Leave empty to use the URL above.">
            <input className={input} value={gacField("publicUrl", g.publicUrl ?? "")} onChange={(e) => setGac({ ...gac, publicUrl: e.target.value })} placeholder="Leave empty to use the URL above" />
          </Field>
          <div className="pv-grid-2">
            <Field label="DB host"><input className={input} value={gacField("dbHost", g.dbHost)} onChange={(e) => setGac({ ...gac, dbHost: e.target.value })} /></Field>
            <Field label="DB port"><input type="number" className={input} value={gacField("dbPort", String(g.dbPort ?? ""))} onChange={(e) => setGac({ ...gac, dbPort: e.target.value })} /></Field>
          </div>
          <Field label="DB name"><input className={input} value={gacField("dbName", g.dbName)} onChange={(e) => setGac({ ...gac, dbName: e.target.value })} /></Field>
          <Field label="DB user"><input className={input} value={gacField("dbUser", g.dbUser)} onChange={(e) => setGac({ ...gac, dbUser: e.target.value })} /></Field>
          <Field label="DB password" hint="Stored value stays masked. Enter a new value only to replace it.">
            <input type="password" className={input} placeholder={String(g.dbPassword ?? "")} value={gacField("dbPassword", "")} onChange={(e) => setGac({ ...gac, dbPassword: e.target.value })} />
          </Field>
          <Btn kind="primary" onClick={saveGuacamole}>Save</Btn>
        </Section>
        <Section title="Application" hint="Retention, announcements, idle policy">
          <AppSettings />
        </Section>
      </div>
    </div>
  );
}

function AppSettings() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ["settings-app"],
    queryFn: () =>
      api<{
        app: Record<string, unknown>;
        settings: {
          retentionDays: number | null;
          announcementText: string | null;
          announcementLevel: "info" | "warn";
          idleShutdownEnabled: boolean;
          driftEnabled: boolean;
          idleMinutes: number;
          threatWebhookUrl: string | null;
          threatMinSeverity: string;
          gotifyUrl: string | null;
          gotifyPriority: number;
          gotifyEnabled: boolean;
          gotifyConfigured: boolean;
          maxCpu: number | null;
          maxRamMb: number | null;
          maxDiskGb: number | null;
          staticAllowedCidrs: string | null;
          selfServeMode: "closed" | "approval" | "auto";
          turnstileSiteKey: string | null;
          turnstileSecretConfigured: boolean;
        };
      }>("/settings/app"),
  });
  const [retention, setRetention] = useState("");
  const [touched, setTouched] = useState(false);
  const current = data?.settings?.retentionDays ?? null;
  const shown = touched ? retention : current === null ? "" : String(current);
  const [announcement, setAnnouncementText] = useState("");
  const [announcementTouched, setAnnouncementTouched] = useState(false);
  const [announcementLevel, setAnnouncementLevel] = useState<"info" | "warn">("info");
  const [announcementLevelTouched, setAnnouncementLevelTouched] = useState(false);
  const currentAnnouncement = data?.settings?.announcementText ?? null;
  const shownAnnouncement = announcementTouched ? announcement : (currentAnnouncement ?? "");
  const shownLevel = announcementLevelTouched ? announcementLevel : (data?.settings?.announcementLevel ?? "info");

  const [idleEnabled, setIdleEnabled] = useState<boolean | null>(null);
  const [idleMinutes, setIdleMinutes] = useState("");
  const [idleTouched, setIdleTouched] = useState(false);
  const currentIdleEnabled = data?.settings?.idleShutdownEnabled ?? false;
  const shownIdleEnabled = idleEnabled ?? currentIdleEnabled;
  const currentIdleMinutes = data?.settings?.idleMinutes ?? 120;
  const shownIdleMinutes = idleTouched ? idleMinutes : String(currentIdleMinutes);

  // Drift detection is opt-in: it opens SSH connections to guests and probes
  // the stored passwords, so it stays off until an operator turns it on.
  const [driftEnabled, setDriftEnabled] = useState<boolean | null>(null);
  const shownDriftEnabled = driftEnabled ?? (data?.settings?.driftEnabled ?? false);

  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookTouched, setWebhookTouched] = useState(false);
  const [minSeverity, setMinSeverity] = useState<"high" | "medium" | "low">("high");
  const [severityTouched, setSeverityTouched] = useState(false);
  const currentWebhook = data?.settings?.threatWebhookUrl ?? null;
  const shownWebhook = webhookTouched ? webhookUrl : (currentWebhook ?? "");
  const shownSeverity = severityTouched ? minSeverity : ((data?.settings?.threatMinSeverity ?? "high") as "high" | "medium" | "low");

  const [gotifyUrl, setGotifyUrl] = useState("");
  const [gotifyTouched, setGotifyTouched] = useState(false);
  const [gotifyToken, setGotifyToken] = useState("");
  const [gotifyTokenTouched, setGotifyTokenTouched] = useState(false);
  const [gotifyPriority, setGotifyPriority] = useState("5");
  const [gotifyPriorityTouched, setGotifyPriorityTouched] = useState(false);
  const [gotifyEnabled, setGotifyEnabled] = useState<boolean | null>(null);
  const currentGotifyUrl = data?.settings?.gotifyUrl ?? null;
  const shownGotifyUrl = gotifyTouched ? gotifyUrl : (currentGotifyUrl ?? "");
  const currentGotifyPriority = data?.settings?.gotifyPriority ?? 5;
  const shownGotifyPriority = gotifyPriorityTouched ? gotifyPriority : String(currentGotifyPriority);
  const shownGotifyEnabled = gotifyEnabled ?? (data?.settings?.gotifyEnabled ?? false);
  const gotifyConfigured = data?.settings?.gotifyConfigured ?? false;
  const [gotifyTestMsg, setGotifyTestMsg] = useState<string | null>(null);

  const [maxCpu, setMaxCpu] = useState("");
  const [maxRamMb, setMaxRamMb] = useState("");
  const [maxDiskGb, setMaxDiskGb] = useState("");
  const [cidrs, setCidrs] = useState("");
  const [policyTouched, setPolicyTouched] = useState(false);
  const shownMaxCpu = policyTouched ? maxCpu : (data?.settings?.maxCpu ?? null)?.toString() ?? "";
  const shownMaxRam = policyTouched ? maxRamMb : (data?.settings?.maxRamMb ?? null)?.toString() ?? "";
  const shownMaxDisk = policyTouched ? maxDiskGb : (data?.settings?.maxDiskGb ?? null)?.toString() ?? "";
  const shownCidrs = policyTouched ? cidrs : (data?.settings?.staticAllowedCidrs ?? "");

  const [selfServeMode, setSelfServeMode] = useState<"closed" | "approval" | "auto" | null>(null);
  const [modeTouched, setModeTouched] = useState(false);
  const [siteKey, setSiteKey] = useState("");
  const [siteKeyTouched, setSiteKeyTouched] = useState(false);
  const [tsSecret, setTsSecret] = useState("");
  const [tsSecretTouched, setTsSecretTouched] = useState(false);
  const shownMode = modeTouched ? (selfServeMode ?? "approval") : (data?.settings?.selfServeMode ?? "approval");
  const shownSiteKey = siteKeyTouched ? siteKey : (data?.settings?.turnstileSiteKey ?? "");
  const tsSecretConfigured = data?.settings?.turnstileSecretConfigured ?? false;

  const save = async () => {
    setError(null);
    setSaved(null);
    try {
      const value = shown.trim() === "" ? null : Number(shown);
      if (value !== null && (!Number.isInteger(value) || value < 1 || value > 3650)) {
        throw new Error("Retention must be blank (keep forever) or 1-3650 days");
      }
      const body: {
        retentionDays: number | null;
        announcementText?: string | null;
        announcementLevel?: "info" | "warn";
        idleShutdownEnabled?: boolean;
        driftEnabled?: boolean;
        idleMinutes?: number;
        threatWebhookUrl?: string | null;
        threatMinSeverity?: "high" | "medium" | "low";
        gotifyUrl?: string | null;
        gotifyToken?: string | null;
        gotifyPriority?: number;
        gotifyEnabled?: boolean;
        maxCpu?: number | null;
        maxRamMb?: number | null;
        maxDiskGb?: number | null;
        staticAllowedCidrs?: string | null;
        selfServeMode?: "closed" | "approval" | "auto";
        turnstileSiteKey?: string | null;
        turnstileSecret?: string | null;
      } = {
        retentionDays: value,
      };
      if (policyTouched) {
        const numOrNull = (raw: string, label: string, min: number, max: number): number | null => {
          if (raw.trim() === "") return null;
          const n = Number(raw);
          if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be blank or ${min}–${max}`);
          return n;
        };
        body.maxCpu = numOrNull(shownMaxCpu, "Max CPU", 1, 4096);
        body.maxRamMb = numOrNull(shownMaxRam, "Max RAM", 256, 8388608);
        body.maxDiskGb = numOrNull(shownMaxDisk, "Max disk", 1, 131072);
        body.staticAllowedCidrs = shownCidrs.trim() === "" ? null : shownCidrs.trim();
      }
      if (webhookTouched || severityTouched) {
        const trimmed = shownWebhook.trim();
        if (trimmed !== "" && trimmed.length > 512) throw new Error("Webhook URL must be 512 characters or fewer");
        body.threatWebhookUrl = trimmed === "" ? null : trimmed;
        body.threatMinSeverity = shownSeverity;
      }
      if (gotifyTouched || gotifyTokenTouched || gotifyPriorityTouched || gotifyEnabled !== null) {
        const trimmed = shownGotifyUrl.trim();
        if (trimmed !== "" && trimmed.length > 512) throw new Error("Gotify URL must be 512 characters or fewer");
        if (gotifyTouched) body.gotifyUrl = trimmed === "" ? null : trimmed;
        if (gotifyTokenTouched) body.gotifyToken = gotifyToken.trim() === "" ? null : gotifyToken.trim();
        if (gotifyPriorityTouched) {
          const n = Number(shownGotifyPriority);
          if (!Number.isInteger(n) || n < 0 || n > 10) throw new Error("Gotify priority must be 0–10");
          body.gotifyPriority = n;
        }
        if (gotifyEnabled !== null) body.gotifyEnabled = shownGotifyEnabled;
      }
      if (announcementTouched || announcementLevelTouched) {
        if (shownAnnouncement.trim() === "") {
          body.announcementText = null;
        } else {
          if (shownAnnouncement.length > 500) throw new Error("Announcement must be 500 characters or fewer");
          body.announcementText = shownAnnouncement;
          body.announcementLevel = shownLevel;
        }
      }
      if (idleTouched) {
        const minutes = Number(shownIdleMinutes);
        if (!Number.isInteger(minutes) || minutes < 5 || minutes > 10080) {
          throw new Error("Idle minutes must be 5–10080");
        }
        body.idleShutdownEnabled = shownIdleEnabled;
        body.idleMinutes = minutes;
      }
      if (driftEnabled !== null) body.driftEnabled = shownDriftEnabled;
      if (modeTouched) body.selfServeMode = shownMode;
      if (siteKeyTouched) {
        if (shownSiteKey.trim() !== "" && shownSiteKey.trim().length > 512) {
          throw new Error("Turnstile site key must be 512 characters or fewer");
        }
        body.turnstileSiteKey = shownSiteKey.trim() === "" ? null : shownSiteKey.trim();
      }
      if (tsSecretTouched) body.turnstileSecret = tsSecret.trim() === "" ? null : tsSecret.trim();
      await api("/settings/app", { method: "PUT", body });
      setSaved("Application settings saved");
      setTouched(false);
      setAnnouncementTouched(false);
      setAnnouncementLevelTouched(false);
      setIdleTouched(false);
      setDriftEnabled(null);
      setWebhookTouched(false);
      setSeverityTouched(false);
      setGotifyTouched(false);
      setGotifyTokenTouched(false);
      setGotifyPriorityTouched(false);
      setGotifyEnabled(null);
      setGotifyToken("");
      setPolicyTouched(false);
      setModeTouched(false);
      setSelfServeMode(null);
      setSiteKeyTouched(false);
      setTsSecretTouched(false);
      setTsSecret("");
      void qc.invalidateQueries({ queryKey: ["settings-app"] });
      void qc.invalidateQueries({ queryKey: ["announcement"] });
    } catch (err) {
      setError(errText(err));
    }
  };

  const testGotify = async () => {
    setError(null);
    setGotifyTestMsg(null);
    try {
      await api("/settings/gotify/test", { method: "POST", body: {} });
      setGotifyTestMsg("Test message sent — check Gotify.");
    } catch (err) {
      setError(errText(err));
    }
  };

  return (
    <div>
      {error && <Alert kind="err" title="Action failed">{error}</Alert>}
      {saved && <Alert kind="ok" title="Saved">{saved}</Alert>}
      <Field label="Audit retention (days, blank = keep forever)" hint="Entries older than this are pruned hourly.">
        <input
          type="number"
          className={input}
          placeholder="e.g. 180"
          value={shown}
          onChange={(e) => {
            setRetention(e.target.value);
            setTouched(true);
          }}
        />
      </Field>
      <Field label="Instance announcement (blank = none; shown to every signed-in user)">
        <textarea
          className="pv-textarea"
          placeholder="e.g. Maintenance Sunday 2–4 AM — sessions may drop briefly."
          rows={2}
          value={shownAnnouncement}
          onChange={(e) => {
            setAnnouncementText(e.target.value);
            setAnnouncementTouched(true);
          }}
        />
      </Field>
      <Field label="Announcement style">
        <select
          className="pv-select"
          value={shownLevel}
          onChange={(e) => {
            setAnnouncementLevel(e.target.value === "warn" ? "warn" : "info");
            setAnnouncementLevelTouched(true);
          }}
        >
          <option value="info">Info (blue)</option>
          <option value="warn">Warning (amber)</option>
        </select>
      </Field>
      <Field label="Idle auto-shutdown" hint="User-class VMs only; server VMs never shut down. A VM shuts down only with zero sessions, idle CPU, and no activity for the full window. Never-used VMs are skipped.">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <label className="pv-checkrow">
            <input
              type="checkbox"
              checked={shownIdleEnabled}
              onChange={(e) => {
                setIdleEnabled(e.target.checked);
                setIdleTouched(true);
              }}
            />
            Shut down idle user VMs
          </label>
          <input
            type="number"
            className="pv-input"
            style={{ width: 112 }}
            title="Minutes of no sessions + idle CPU before shutdown"
            aria-label="Idle minutes before shutdown"
            value={shownIdleMinutes}
            onChange={(e) => {
              setIdleMinutes(e.target.value);
              setIdleTouched(true);
            }}
          />
          <span className="pv-hint">min idle (5–10080)</span>
        </div>
      </Field>
      <Field
        label="Ground-truth drift detection"
        hint="Reconciles the ProxVM database against live Proxmox every 15 minutes and records the differences (deleted guests, renames, resized hardware, changed IPs, stale credentials). OFF by default: the pass opens SSH connections to guests and probes the stored passwords. Remediation is always a separate, confirmed action."
      >
        <label className="pv-checkrow">
          <input
            type="checkbox"
            checked={shownDriftEnabled}
            onChange={(e) => {
              setDriftEnabled(e.target.checked);
            }}
          />
          Enable drift detection
        </label>
      </Field>
      <Field
        label="Threat webhook (blank = disabled)"
        hint="POSTs fresh threat findings as JSON every 5 minutes. Any http(s) URL works (Discord/Slack-compatible body); cloud metadata endpoints are refused."
        htmlFor="settings-webhook-url"
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <input
            id="settings-webhook-url"
            className="pv-input"
            style={{ minWidth: 280, flex: 1 }}
            placeholder="e.g. https://hooks.slack.com/services/…"
            value={shownWebhook}
            onChange={(e) => {
              setWebhookUrl(e.target.value);
              setWebhookTouched(true);
            }}
          />
          <select
            className="pv-select"
            aria-label="Minimum severity that triggers a webhook post"
            value={shownSeverity}
            title="Minimum severity that triggers a webhook post"
            onChange={(e) => {
              setMinSeverity(e.target.value === "low" ? "low" : e.target.value === "medium" ? "medium" : "high");
              setSeverityTouched(true);
            }}
          >
            <option value="high">High and up</option>
            <option value="medium">Medium and up</option>
            <option value="low">Everything</option>
          </select>
        </div>
      </Field>
      <Field label="Gotify push (admin downtime alerts)" hint="Server URL + application token from your Gotify instance (e.g. http://192.168.1.28/). VM power, RDP/SSH reachability, infrastructure, and threat alerts fan out here. Token is never shown back.">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <label className="pv-checkrow">
            <input
              type="checkbox"
              checked={shownGotifyEnabled}
              onChange={(e) => setGotifyEnabled(e.target.checked)}
            />
            Enable Gotify push {gotifyConfigured ? "(configured)" : "(not configured)"}
          </label>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <input
            className="pv-input"
            style={{ minWidth: 220, flex: 1 }}
            placeholder="e.g. http://192.168.1.28/"
            aria-label="Gotify server URL"
            value={shownGotifyUrl}
            onChange={(e) => {
              setGotifyUrl(e.target.value);
              setGotifyTouched(true);
            }}
          />
          <input
            type="password"
            className="pv-input"
            style={{ minWidth: 160, flex: 1 }}
            placeholder="App token (saved hidden)"
            aria-label="Gotify application token"
            value={gotifyToken}
            onChange={(e) => {
              setGotifyToken(e.target.value);
              setGotifyTokenTouched(true);
            }}
          />
          <input
            type="number"
            className="pv-input"
            style={{ width: 100 }}
            title="Gotify priority 0–10"
            aria-label="Gotify priority (0–10)"
            min={0}
            max={10}
            value={shownGotifyPriority}
            onChange={(e) => {
              setGotifyPriority(e.target.value);
              setGotifyPriorityTouched(true);
            }}
          />
          <Btn onClick={testGotify}>Send test</Btn>
        </div>
        {gotifyTestMsg && <div className="pv-alert pv-alert-ok">{gotifyTestMsg}</div>}
      </Field>
      <Field label="Provisioning ceilings (blank = no ceiling; admins exempt)" hint="Non-admin requests above these are rejected. Applies at request time and again when the worker runs.">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <input type="number" className="pv-input" style={{ width: 110 }} placeholder="Max CPU" title="Max vCPU per VM" aria-label="Max vCPU per VM" value={shownMaxCpu} onChange={(e) => { setMaxCpu(e.target.value); setPolicyTouched(true); }} />
          <input type="number" className="pv-input" style={{ width: 130 }} placeholder="Max RAM MB" title="Max RAM megabytes per VM" aria-label="Max RAM megabytes per VM" value={shownMaxRam} onChange={(e) => { setMaxRamMb(e.target.value); setPolicyTouched(true); }} />
          <input type="number" className="pv-input" style={{ width: 130 }} placeholder="Max disk GB" title="Max disk gigabytes per VM" aria-label="Max disk gigabytes per VM" value={shownMaxDisk} onChange={(e) => { setMaxDiskGb(e.target.value); setPolicyTouched(true); }} />
        </div>
      </Field>
      <Field label="Static-IP subnets (blank = static assignment disabled for non-admins)" hint="Comma-separated IPv4 CIDRs, e.g. 192.168.1.0/24. Static requests outside these are rejected; addresses must also be unique across VMs.">
        <input
          className="pv-input"
          style={{ minWidth: 280, flex: 1 }}
          placeholder="e.g. 192.168.1.0/24, 10.0.5.0/24"
          value={shownCidrs}
          onChange={(e) => { setCidrs(e.target.value); setPolicyTouched(true); }}
        />
      </Field>
      <Field
        label="Self-serve signups"
        hint="closed: the public register form is refused. approval: requests queue for your review (Users page). auto: accounts are created instantly with the zero-permission GUEST role — you grant VM access later. auto without a Turnstile secret behaves as approval."
      >
        <select
          className="pv-select"
          value={shownMode}
          onChange={(e) => {
            const value = e.target.value as "closed" | "approval" | "auto";
            setSelfServeMode(value);
            setModeTouched(true);
          }}
        >
          <option value="closed">Closed (accounts created by admins only)</option>
          <option value="approval">Approval queue (default)</option>
          <option value="auto">Instant — GUEST role, you grant access later</option>
        </select>
        {shownMode === "auto" && !tsSecretConfigured && tsSecret.trim() === "" && (
          <div className="pv-alert pv-alert-warn" style={{ marginTop: 6, fontSize: "0.8rem" }}>
            Instant signups need a Turnstile secret — save one below, or this behaves as the approval queue.
          </div>
        )}
      </Field>
      <Field
        label="Turnstile keys (Cloudflare bot gate for signups)"
        hint={`From Cloudflare dashboard → Turnstile → Add site (your signup hostname). Site key is public; the secret key is stored encrypted and never shown back${tsSecretConfigured ? " (configured)" : ""}.`}
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <input
            className="pv-input"
            style={{ minWidth: 240, flex: 1 }}
            placeholder="Site key, e.g. 0x4AAAAAAA…"
            value={shownSiteKey}
            onChange={(e) => {
              setSiteKey(e.target.value);
              setSiteKeyTouched(true);
            }}
          />
          <input
            type="password"
            className="pv-input"
            style={{ minWidth: 200, flex: 1 }}
            placeholder={tsSecretConfigured ? "Secret key (saved hidden)" : "Secret key"}
            aria-label="Turnstile secret key"
            value={tsSecret}
            onChange={(e) => {
              setTsSecret(e.target.value);
              setTsSecretTouched(true);
            }}
          />
        </div>
      </Field>
      <Btn kind="primary" onClick={save}>Save</Btn>
    </div>
  );
}