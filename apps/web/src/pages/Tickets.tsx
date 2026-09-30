import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageTitle, ErrorBox } from "../components/ui.js";

interface Ticket {
  id: string;
  username: string;
  title: string;
  body: string;
  status: "open" | "answered" | "closed";
  createdAt: string;
}

const STATUS_COLORS: Record<Ticket["status"], string> = {
  open: "text-amber-300",
  answered: "text-blue-300",
  closed: "text-slate-500",
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
    <div className="max-w-4xl">
      <PageTitle title="Support tickets" />
      {error && <ErrorBox error={error} />}
      {notice && <div className="bg-green-900/50 border border-green-700 text-green-200 rounded p-3 mb-4 text-sm">{notice}</div>}
      <div className="bg-slate-900 border border-slate-800 rounded p-5 mb-4">
        <h2 className="text-sm font-medium text-slate-300 mb-3">File a ticket</h2>
        <div className="space-y-2">
          <input
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm"
            placeholder="Short summary (max 120 chars)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm"
            placeholder="What happened, what you expected, VM name if relevant…"
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <button
            onClick={() => void file()}
            disabled={!title.trim() || !body.trim()}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded"
          >
            Submit ticket
          </button>
        </div>
      </div>
      <div className="flex gap-2 mb-3 text-xs">
        {(["", "open", "answered", "closed"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3 py-1 rounded ${filter === s ? "bg-blue-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
          >
            {s === "" ? "All" : s[0]!.toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
      <div className="space-y-2">
        {(data?.tickets ?? []).map((t) => (
          <div key={t.id} className="bg-slate-900 border border-slate-800 rounded p-4">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <span className={`text-xs font-medium uppercase ${STATUS_COLORS[t.status]}`}>{t.status}</span>
              <span className="text-sm font-medium text-slate-100">{t.title}</span>
              <span className="text-xs text-slate-500 ml-auto">
                {t.username} · {new Date(t.createdAt).toLocaleString()}
              </span>
            </div>
            <p className="text-sm text-slate-300 whitespace-pre-wrap">{t.body}</p>
            {isAdmin && t.status !== "closed" && (
              <div className="flex gap-2 mt-2">
                {t.status !== "answered" && (
                  <button className="text-xs text-blue-400 underline" onClick={() => void setStatus(t.id, "answered")}>
                    Mark answered
                  </button>
                )}
                <button className="text-xs text-slate-400 underline" onClick={() => void setStatus(t.id, "closed")}>
                  Close
                </button>
              </div>
            )}
            {isAdmin && t.status === "closed" && (
              <button className="text-xs text-slate-400 underline mt-2" onClick={() => void setStatus(t.id, "open")}>
                Reopen
              </button>
            )}
          </div>
        ))}
        {data && data.tickets.length === 0 && (
          <div className="text-xs text-slate-500 text-center py-4">No tickets here.</div>
        )}
      </div>
    </div>
  );
}
