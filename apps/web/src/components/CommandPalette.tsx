import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, CornerDownLeft } from "lucide-react";
import { api } from "../api.js";

interface Entry {
  kind: "Page" | "VM" | "User";
  label: string;
  hint: string;
  to: string;
}

/**
 * Command palette (Ctrl/Cmd+K): navigate to pages, jump to a VM, open a
 * user's permission page. Only surfaces what the user may already reach.
 */
export default function CommandPalette({
  open,
  onClose,
  nav,
  canViewUsers,
  canAudit,
  go,
}: {
  open: boolean;
  onClose: () => void;
  nav: Array<{ to: string; label: string }>;
  canViewUsers: boolean;
  canAudit: boolean;
  go: (to: string) => void;
}) {
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
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const q = query.trim().toLowerCase();
    const all: Entry[] = [
      ...nav.map((n) => ({ kind: "Page" as const, label: n.label, hint: n.to, to: n.to })),
      // Direct admin destinations. The sidebar nests these behind a tab
      // ("System & security") or a generic label ("Support"), which is exactly
      // the step an admin in a hurry should not have to remember.
      ...(canAudit
        ? [{ kind: "Page" as const, label: "Threat analysis", hint: "triage board", to: "/system?tab=threats" }]
        : []),
      ...(canViewUsers
        ? [{ kind: "Page" as const, label: "Support queue", hint: "open tickets", to: "/tickets" }]
        : []),
      ...(vmsData?.vms ?? [])
        .filter((v) => v.id)
        .map((v) => ({ kind: "VM" as const, label: v.name, hint: v.status, to: `/vms/${v.id}` })),
      ...(canViewUsers
        ? (usersData?.users ?? []).map((u) => ({
            kind: "User" as const,
            label: u.username,
            hint: "permissions",
            to: `/users/${u.id}/permissions`,
          }))
        : []),
    ];
    if (!q) return all.slice(0, 12);
    return all
      .filter(
        (e) =>
          e.label.toLowerCase().includes(q) ||
          e.hint.toLowerCase().includes(q) ||
          e.kind.toLowerCase().includes(q),
      )
      .slice(0, 12);
  }, [nav, vmsData, usersData, canViewUsers, canAudit, query]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  if (!open) return null;

  const choose = (i: number): void => {
    const entry = entries[i];
    if (entry) go(entry.to);
  };

  let lastKind = "";

  return (
    <div
      className="pv-palette-scrim"
      onClick={onClose}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div role="dialog" aria-label="Command palette" className="pv-palette" onClick={(e) => e.stopPropagation()}>
        <div style={{ position: "relative" }}>
          <Search
            size={15}
            aria-hidden="true"
            style={{
              position: "absolute",
              left: 18,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--pv-text-3)",
            }}
          />
          <input
            ref={inputRef}
            className="pv-palette-input"
            style={{ paddingLeft: 44 }}
            placeholder="Jump to a page, VM, or user…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search pages, VMs and users"
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
        </div>
        <div className="pv-palette-list" role="listbox" aria-label="Results">
          {entries.map((e, i) => {
            const showGroup = e.kind !== lastKind;
            lastKind = e.kind;
            return (
              <div key={`${e.kind}-${e.to}-${i}`}>
                {showGroup && <div className="pv-palette-group">{e.kind}s</div>}
                <button
                  role="option"
                  aria-selected={i === index}
                  className={`pv-palette-item${i === index ? " pv-palette-item-active" : ""}`}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => choose(i)}
                >
                  <span>{e.label}</span>
                  <span className="pv-palette-hint">{e.hint}</span>
                  {i === index && <CornerDownLeft size={12} aria-hidden="true" style={{ color: "var(--pv-text-3)", flex: "none" }} />}
                </button>
              </div>
            );
          })}
          {!entries.length && (
            <div style={{ padding: "14px 16px", fontSize: "0.85rem", color: "var(--pv-text-3)" }}>
              No matches for “{query}”.
            </div>
          )}
        </div>
        <div className="pv-palette-foot">
          <span><span className="pv-kbd">↑↓</span> navigate</span>
          <span><span className="pv-kbd">↵</span> open</span>
          <span><span className="pv-kbd">Esc</span> close</span>
        </div>
      </div>
    </div>
  );
}
