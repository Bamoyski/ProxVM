import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { fmtDateTime } from "../lib/format.js";
import {
  PageHeader, Section, EmptyState, Btn, Alert, Badge, Field, Input, Textarea, useToast, errText,
} from "../ui/index.js";

interface Ticket {
  id: string;
  username: string;
  title: string;
  body: string;
  status: "open" | "answered" | "closed";
  createdAt: string;
}

const STATUS_TONE: Record<Ticket["status"], "warn" | "info" | "neutral"> = {
  open: "warn",
  answered: "info",
  closed: "neutral",
};

export default function Tickets({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [notice, setNotice] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [filter, setFilter] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["tickets", filter],
    queryFn: () =>
      api<{ tickets: Ticket[] }>(`/tickets${filter ? `?status=${encodeURIComponent(filter)}` : ""}`),
  });

  const reload = () => void qc.invalidateQueries({ queryKey: ["tickets"] });

  const file = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await api("/tickets", { method: "POST", body: { title: title.trim(), body: body.trim() } });
      setTitle("");
      setBody("");
      setNotice("Ticket filed. An administrator will respond here.");
      reload();
    } catch (err) {
      toast.err("Could not file the ticket", errText(err));
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (id: string, status: Ticket["status"]) => {
    try {
      await api(`/tickets/${id}`, { method: "PATCH", body: { status } });
      toast.info(`Ticket ${status}`);
      reload();
    } catch (err) {
      toast.err("Status change failed", errText(err));
    }
  };

  return (
    <div className="pv-page pv-page-narrow">
      <PageHeader
        title="Support tickets"
        description={
          isAdmin
            ? "The full queue. Mark answered once replied, close when resolved."
            : "File a ticket and track the response here."
        }
      />
      {notice && <Alert kind="ok" title="Filed">{notice}</Alert>}

      <Section title="File a ticket" hint="Describe the problem and which VM it affects.">
        <Field label="Summary" required hint="Max 120 characters.">
          {({ id }) => (
            <Input
              id={id}
              maxLength={120}
              placeholder="Short summary"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          )}
        </Field>
        <Field label="Description" required>
          {({ id }) => (
            <Textarea
              id={id}
              rows={4}
              placeholder="What happened, what you expected, VM name if relevant…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          )}
        </Field>
        <Btn kind="primary" loading={busy} onClick={() => void file()} disabled={!title.trim() || !body.trim()}>
          Submit ticket
        </Btn>
      </Section>

      <Section
        title="Tickets"
        hint={`${(data?.tickets ?? []).length} shown`}
        actions={
          <div className="pv-seg" role="group" aria-label="Filter tickets">
            {(["", "open", "answered", "closed"] as const).map((s) => (
              <button
                key={s || "all"}
                className={`pv-seg-btn${filter === s ? " pv-seg-btn-active" : ""}`}
                onClick={() => setFilter(s)}
                aria-pressed={filter === s}
              >
                {s === "" ? "All" : s[0]!.toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        }
      >
        {(data?.tickets ?? []).map((t) => (
          <div key={t.id} style={{ padding: "13px 0", borderBottom: "1px solid var(--pv-border-soft)" }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
              <Badge tone={STATUS_TONE[t.status]}>
                {t.status}
              </Badge>
              <span style={{ fontWeight: 600 }}>{t.title}</span>
              <span className="pv-faint" style={{ fontSize: "0.76rem", marginLeft: "auto" }}>
                {t.username} · {fmtDateTime(t.createdAt)}
              </span>
            </div>
            <p style={{ fontSize: "0.85rem", color: "var(--pv-text-2)", margin: "0 0 7px", whiteSpace: "pre-wrap" }}>{t.body}</p>
            {isAdmin && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {t.status !== "closed" && t.status !== "answered" && (
                  <Btn size="sm" kind="link" onClick={() => void setStatus(t.id, "answered")}>
                    Mark answered
                  </Btn>
                )}
                {t.status !== "closed" && (
                  <Btn size="sm" kind="link" onClick={() => void setStatus(t.id, "closed")}>
                    Close
                  </Btn>
                )}
                {t.status === "closed" && (
                  <Btn size="sm" kind="link" onClick={() => void setStatus(t.id, "open")}>
                    Reopen
                  </Btn>
                )}
              </div>
            )}
          </div>
        ))}
        {isLoading && !data && <div className="pv-faint" style={{ fontSize: "0.85rem" }}>Loading tickets…</div>}
        {data && data.tickets.length === 0 && (
          <EmptyState title="No tickets here" body={filter ? "Nothing with this status." : "Nothing filed yet."} />
        )}
      </Section>
    </div>
  );
}
