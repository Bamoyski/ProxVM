import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  nav: Array<{ to: string; label: string }>;
  canViewUsers: boolean;
  go: (to: string) => void;
}

interface Entry {
  kind: string;
  label: string;
  hint: string;
  to: string;
}

export default function CommandPalette({ open, onClose, nav, canViewUsers, go }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: vmsData } = useQuery({
    queryKey: ["palette-vms"],
    queryFn: () => api<{ vms: Array<{ id: string | null; name: string; status: string }> }>("/vms"),
    enabled: open,
    staleTime: 30000,
  });
  const { data: usersData } = useQuery({
    queryKey: ["palette-users"],
    queryFn: () => api<{ users: Array<{ id: string; username: string }> }>("/users"),
    enabled: open && canViewUsers,
    staleTime: 30000,
  });

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open ]);

  const entries = useMemo<Entry[]>(() => {
    const q = query.trim().toLowerCase();
    const all: Entry[] = [
      ...nav.map((n) => ({ kind: "Page", label: n.label, hint: n.to, to: n.to })),
      ...(vmsData?.vms ?? [])
        .filter((v) => v.id)
        .map((v) => ({ kind: "VM", label: v.name, hint: v.status, to: `/vms/${v.id}` })),
      ...(canViewUsers ? (usersData?.users ?? []).map((u) => ({ kind: "User", label: u.username, hint: "permissions", to: `/users/${u.id}/permissions` })) : []),
    ];
    if (!q) return all.slice(0, 12);
    return all
      .filter((e) => e.label.toLowerCase().includes(q) || e.hint.toLowerCase().includes(q) || e.kind.toLowerCase().includes(q))
      .slice(0, 12);
  }, [nav, vmsData, usersData, canViewUsers, query]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  if (!open) return null;
  const choose = (i: number): void => {
    const entry = entries[i];
    if (entry) go(entry.to);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-24" onClick={onClose}>
      <div
        className="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
      >
        <input
          ref={inputRef}
          className="w-full bg-transparent px-4 py-3 text-sm outline-none border-b border-slate-800"
          placeholder="Type a page, VM, or user… (Esc to close)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, entries.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              choose(index);
            }
          }}
        />
        <div className="max-h-80 overflow-y-auto py-1">
          {entries.map((e, i) => (
            <button
              key={`${e.kind}-${e.to}`}
              className={`w-full text-left px-4 py-2 text-sm flex items-center gap-3 ${i === index ? "bg-slate-800" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(i)}
            >
              <span className="text-[10px] uppercase tracking-wide text-slate-500 w-10 shrink-0">{e.kind}</span>
              <span className="text-slate-200">{e.label}</span>
              <span className="text-xs text-slate-500 ml-auto truncate">{e.hint}</span>
            </button>
          ))}
          {!entries.length && <div className="px-4 py-3 text-sm text-slate-500">No matches.</div>}
        </div>
      </div>
    </div>
  );
}
