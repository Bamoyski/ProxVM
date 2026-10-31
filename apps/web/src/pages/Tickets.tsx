import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { fmtDateTime, fmtRelative } from "../lib/format.js";
import {
  PageHeader, Section, EmptyState, Btn, Alert, Badge, Field, Input, Textarea, Select, Stat,
  SearchInput, CopyButton, useToast, errText,
} from "../ui/index.js";
import {
  WAITING_ERR_MS, WAITING_WARN_MS, ageMs, fmtAge, matchesTicket, oldestOpenAgeMs, sortTickets,
  ticketCounts, waitingTone, type TicketStatus,
} from "../lib/triage.js";

interface Ticket {
  id: string;
  username: string;
  title: string;
  body: string;
  status: TicketStatus;
  createdAt: string;
  updatedAt?: string;
}

const STATUS_TONE: Record<TicketStatus, "warn" | "info" | "neutral"> = {
  open: "warn",
  answered: "info",
  closed: "neutral",
};

const STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Open",
  answered: "Answered",
  closed: "Closed",
};

export default function Tickets({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [notice, setNotice] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  // Admins land on the actionable slice (open) rather than a mixed list.
  const [filter, setFilter] = useState<string>(isAdmin ? "open" : "");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"waiting" | "newest">(isAdmin ? "waiting" : "newest");
  const [busy, setBusy] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["tickets"],
    queryFn: () => api<{ tickets: Ticket[] }>("/tickets"),
  });

  const reload = () => void qc.invalidateQueries({ queryKey: ["tickets"] });

  const all = data?.tickets ?? [];
  const counts = ticketCounts(all);
  const oldestOpen = oldestOpenAgeMs(all);
  const shown = useMemo(
    () =>
      sortTickets(
        all.filter((t) => (!filter || t.status === filter) && matchesTicket(t, search)),
        sort,
      ),
    [data?.tickets, filter, search, sort],
  );

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

  const setStatus = async (id: string, status: TicketStatus) => {
    try {
      await api(`/tickets/${id}`, { method: "PATCH", body: { status } });
      toast.info(`Ticket ${status}`);
      reload();
    } catch (err) {
      toast.err("Status change failed", errText(err));
    }
  };

  const pressure = oldestOpen !== null && oldestOpen >= WAITING_WARN_MS;

  return (
    <div className={`pv-page${isAdmin ? "" : " pv-page-narrow"}`}>
      <PageHeader
        title="Support tickets"
        description={
          isAdmin
            ? "Your queue: open tickets first, longest wait at the top. Mark answered once replied, close when resolved."
            : "File a ticket and track the response here."
        }
        actions={
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={isAdmin ? "Search reporter, title, or text" : "Search your tickets"}
            label="Search tickets"
          />
        }
      />
      {notice && <Alert kind="ok" title="Filed">{notice}</Alert>}

      {isAdmin && data && (
        <div className="pv-grid-stats" style={{ marginBottom: 18 }}>
          <Stat label="Open" value={String(counts.open)} tone={counts.open > 0 ? "var(--pv-warn)" : undefined} hint="Waiting for a first reply" />
          <Stat label="Answered" value={String(counts.answered)} hint="Replied, not yet closed" />
          <Stat label="Closed" value={String(counts.closed)} />
          <Stat
            label="Oldest open"
            value={oldestOpen === null ? "—" : fmtAge(oldestOpen)}
            tone={oldestOpen !== null && oldestOpen >= WAITING_ERR_MS ? "var(--pv-err)" : undefined}
            hint="Longest a ticket has been waiting for a reply"
          />
        </div>
      )}

      {isAdmin && pressure && (
        <Alert
          kind={oldestOpen !== null && oldestOpen >= WAITING_ERR_MS ? "warn" : "info"}
          title="Queue pressure"
          actions={
            <Btn size="sm" onClick={() => { setFilter("open"); setSort("waiting"); setSearch(""); }}>
              Show longest-waiting
            </Btn>
          }
        >
          The oldest open ticket has been waiting {fmtAge(oldestOpen)}. Answer it or set expectations before filing
          anything else.
        </Alert>
      )}

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
        title={isAdmin ? "Queue" : "Tickets"}
        hint={
          all.length === 0
            ? "Nothing filed yet"
            : shown.length === all.length
              ? `${all.length} ticket${all.length === 1 ? "" : "s"}`
              : `${shown.length} of ${all.length} shown`
        }
        actions={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <div className="pv-seg" role="group" aria-label="Filter tickets">
              {(["", "open", "answered", "closed"] as const).map((s) => (
                <button
                  key={s || "all"}
                  className={`pv-seg-btn${filter === s ? " pv-seg-btn-active" : ""}`}
                  onClick={() => setFilter(s)}
                  aria-pressed={filter === s}
                >
                  {s === "" ? "All" : STATUS_LABEL[s]}
                </button>
              ))}
            </div>
            {isAdmin && (
              <Select
                autoWidth
                small
                value={sort}
                onChange={(e) => setSort(e.target.value === "newest" ? "newest" : "waiting")}
                aria-label="Sort tickets"
                title="Sort order"
              >
                <option value="waiting">Waiting longest first</option>
                <option value="newest">Newest first</option>
              </Select>
            )}
          </div>
        }
      >
        {shown.map((t) => (
          <div key={t.id} style={{ padding: "13px 0", borderBottom: "1px solid var(--pv-border-soft)" }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
              <Badge tone={STATUS_TONE[t.status]}>{t.status}</Badge>
              {isAdmin && t.status === "open" && (
                <span title={`Filed ${fmtDateTime(t.createdAt)}`}>
                  <Badge tone={waitingTone(t.createdAt)}>waiting {fmtAge(ageMs(t.createdAt))}</Badge>
                </span>
              )}
              <span style={{ fontWeight: 600 }}>{t.title}</span>
              <span
                className="pv-faint"
                style={{ fontSize: "0.76rem", marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                {isAdmin && <CopyButton text={t.username} label={`Copy username ${t.username}`} />}
                <span title={fmtDateTime(t.createdAt)}>{t.username} · filed {fmtRelative(t.createdAt)}</span>
              </span>
            </div>
            <p style={{ fontSize: "0.85rem", color: "var(--pv-text-2)", margin: "0 0 7px", whiteSpace: "pre-wrap" }}>{t.body}</p>
            {isAdmin && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {t.status === "open" && (
                  <Btn size="sm" kind="link" onClick={() => void setStatus(t.id, "answered")} title="Reply outside the app, then mark this">
                    Mark answered
                  </Btn>
                )}
                {t.status !== "closed" && (
                  <Btn size="sm" kind="link" onClick={() => void setStatus(t.id, "closed")}>
                    Close
                  </Btn>
                )}
                {t.status !== "open" && (
                  <Btn
                    size="sm"
                    kind="link"
                    onClick={() => void setStatus(t.id, "open")}
                    title="Send it back to the open queue"
                  >
                    Reopen
                  </Btn>
                )}
              </div>
            )}
          </div>
        ))}
        {isLoading && !data && <div className="pv-faint" style={{ fontSize: "0.85rem" }}>Loading tickets…</div>}
        {data && shown.length === 0 && (
          <EmptyState
            title={all.length ? "Nothing matches this view" : "No tickets here"}
            body={
              all.length
                ? search
                  ? "No ticket matches that search in this status."
                  : "Nothing with this status — try another filter."
                : "Nothing filed yet."
            }
            action={
              all.length ? (
                <Btn size="sm" onClick={() => { setFilter(""); setSearch(""); }}>
                  Show all tickets
                </Btn>
              ) : undefined
            }
          />
        )}
      </Section>
    </div>
  );
}
