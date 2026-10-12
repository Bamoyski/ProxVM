import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, ErrorBox, Section, Empty, Btn } from "../components/ui.js";

interface Ticket {
  id: string;
  username: string;
  title: string;
  body: string;
  status: "open" | "answered" | "closed";
  createdAt: string;
}

const STATUS_TONE: Record<Ticket["status"], string> = {
  open: "pv-status-warn",
  answered: "pv-status-info",
  closed: "",
};

export default function Tickets({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [filter, setFilter] = useState<string>("");
  const { data } = useQuery({
    queryKey: ["tickets", filter],
    queryFn: () =>
      api<{ tickets: Ticket[] }>(`/tickets${filter ? `?status=${encodeURIComponent(filter)}` : ""}`),
  });

  const reload = () => void qc.invalidateQueries({ queryKey: ["tickets"] });

  const file = async () => {
    setError(null);
    setNotice(null);
    try {
      await api("/tickets", { method: "POST", body: { title: title.trim(), body: body.trim() } });
      setTitle("");
      setBody("");
      setNotice("Ticket filed. An administrator will respond here.");
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const setStatus = async (id: string, status: Ticket["status"]) => {
    setError(null);
    try {
      await api(`/tickets/${id}`, { method: "PATCH", body: { status } });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="pv-page pv-page-narrow">
      <PageTitle
        title="Support tickets"
        description={isAdmin ? "The full queue. Mark answered once replied, close when resolved." : "File a ticket and track the response here."}
      />
      {error && <ErrorBox error={error} />}
      {notice && <div className="pv-notice pv-notice-ok">{notice}</div>}
      <div className="pv-panel" style={{ marginBottom: 24 }}>
        <div className="pv-label">File a ticket</div>
        <div className="pv-field">
          <input
            className="pv-input"
            placeholder="Short summary (max 120 chars)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="pv-field">
          <textarea
            className="pv-textarea"
            placeholder="What happened, what you expected, VM name if relevant…"
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        <Btn
          kind="primary"
          onClick={() => void file()}
          disabled={!title.trim() || !body.trim()}
        >
          Submit ticket
        </Btn>
      </div>
      <Section
        title="Tickets"
        hint={`${(data?.tickets ?? []).length} shown`}
        actions={
          <div style={{ display: "flex", gap: 4 }}>
            {(["", "open", "answered", "closed"] as const).map((s) => (
              <Btn
                key={s}
                size="sm"
                kind={filter === s ? "primary" : undefined}
                onClick={() => setFilter(s)}
              >
                {s === "" ? "All" : s[0]!.toUpperCase() + s.slice(1)}
              </Btn>
            ))}
          </div>
        }
      >
        {(data?.tickets ?? []).map((t) => (
          <div key={t.id} style={{ padding: "12px 0", borderBottom: "1px solid var(--pv-border-soft)" }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
              <span className={`pv-status ${STATUS_TONE[t.status]}`}>{t.status}</span>
              <span style={{ fontWeight: 600 }}>{t.title}</span>
              <span style={{ fontSize: "0.76rem", color: "var(--pv-text-3)", marginLeft: "auto" }}>
                {t.username} · {new Date(t.createdAt).toLocaleString()}
              </span>
            </div>
            <p style={{ fontSize: "0.85rem", color: "var(--pv-text-2)", margin: "0 0 6px", whiteSpace: "pre-wrap" }}>{t.body}</p>
            {isAdmin && t.status !== "closed" && (
              <div style={{ display: "flex", gap: 8 }}>
                {t.status !== "answered" && (
                  <Btn size="sm" kind="link" onClick={() => void setStatus(t.id, "answered")}>
                    Mark answered
                  </Btn>
                )}
                <Btn size="sm" kind="link" onClick={() => void setStatus(t.id, "closed")}>
                  Close
                </Btn>
              </div>
            )}
            {isAdmin && t.status === "closed" && (
              <Btn size="sm" kind="link" onClick={() => void setStatus(t.id, "open")}>
                Reopen
              </Btn>
            )}
          </div>
        ))}
        {data && data.tickets.length === 0 && (
          <Empty title="No tickets here" body={filter ? "Nothing with this status." : "Nothing filed yet."} />
        )}
      </Section>
    </div>
  );
}
