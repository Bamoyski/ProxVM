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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24" style={{ background: "rgba(0,0,0,0.55)" }} onClick={onClose}>
      <div
        role="dialog"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 560, background: "var(--pv-surface)",
          border: "1px solid var(--pv-border)", borderRadius: 8,
          boxShadow: "0 12px 40px rgba(0,0,0,0.5)", overflow: "hidden",
        }}
      >
        <input
          ref={inputRef}
          className="pv-input"
          style={{ border: "none", borderBottom: "1px solid var(--pv-border-soft)", borderRadius: 0, height: 44, fontSize: "0.9rem" }}
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
        <div style={{ maxHeight: 320, overflowY: "auto", padding: "4px 0" }}>
          {entries.map((e, i) => (
            <button
              key={`${e.kind}-${e.to}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(i)}
              style={{
                width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 12,
                padding: "8px 16px", fontSize: "0.85rem", cursor: "pointer",
                background: i === index ? "var(--pv-surface-2)" : "none",
                border: "none", borderLeft: i === index ? "2px solid var(--pv-accent)" : "2px solid transparent",
                color: "var(--pv-text)",
              }}
            >
              <span className="pv-mono" style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--pv-text-3)", width: 40, flex: "none" }}>{e.kind}</span>
              <span>{e.label}</span>
              <span style={{ fontSize: "0.76rem", color: "var(--pv-text-3)", marginLeft: "auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.hint}</span>
            </button>
          ))}
          {!entries.length && <div style={{ padding: "12px 16px", fontSize: "0.85rem", color: "var(--pv-text-3)" }}>No matches.</div>}
        </div>
      </div>
    </div>
  );
}
