import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, ErrorBox, Section, Btn } from "../components/ui.js";

const input = "pv-input";
const label = "pv-label";

function Field({ label: l, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="pv-field">
      <label className={label}>{l}</label>
      {children}
      {hint ? <div className="pv-hint">{hint}</div> : null}
    </div>
  );
}

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
      setError(err instanceof Error ? err.message : String(err));
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
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const s = proxmox?.settings ?? {};
  const g = guacamole?.settings ?? {};

  return (
    <div className="pv-page">
      <PageTitle title="Settings" description="Connection details and instance behavior. Secrets stay masked." />
      {error && <ErrorBox error={error} />}
      {saved && <div className="pv-notice pv-notice-ok">{saved}</div>}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-10">
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
          <div className="grid grid-cols-3 gap-2">
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
          <div className="grid grid-cols-2 gap-2">
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
          idleMinutes: number;
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
        idleMinutes?: number;
      } = {
        retentionDays: value,
      };
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
      await api("/settings/app", { method: "PUT", body });
      setSaved("Application settings saved");
      setTouched(false);
      setAnnouncementTouched(false);
      setAnnouncementLevelTouched(false);
      setIdleTouched(false);
      void qc.invalidateQueries({ queryKey: ["settings-app"] });
      void qc.invalidateQueries({ queryKey: ["announcement"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      {error && <ErrorBox error={error} />}
      {saved && <div className="pv-notice pv-notice-ok">{saved}</div>}
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
            value={shownIdleMinutes}
            onChange={(e) => {
              setIdleMinutes(e.target.value);
              setIdleTouched(true);
            }}
          />
          <span className="pv-hint">min idle (5–10080)</span>
        </div>
      </Field>
      <Btn kind="primary" onClick={save}>Save</Btn>
    </div>
  );
}