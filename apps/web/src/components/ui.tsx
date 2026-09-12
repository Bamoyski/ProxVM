import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api.js";

export function StatusBadge({ status }: { status: string | null | undefined }) {
  const s = status ?? "unknown";
  const color =
    s === "running" || s === "READY" || s === "ACTIVE" || s === "VERIFIED" || s === "ONLINE"
      ? "bg-green-900 text-green-300"
      : s === "stopped" || s === "PENDING" || s === "ENCRYPTED" || s === "PROVISIONED"
        ? "bg-slate-700 text-slate-300"
        : s === "FAILED" || s === "OFFLINE" || s === "ERROR" || s === "ROTATING"
          ? "bg-red-900 text-red-300"
          : "bg-yellow-900 text-yellow-300";
  return <span className={`px-2 py-0.5 rounded text-xs font-mono ${color}`}>{s}</span>;
}

export function PageTitle({ title, children }: { title: string; children?: ReactNode }) {
  useEffect(() => {
    document.title = `${title} — ProxVM`;
    return () => {
      document.title = "ProxVM";
    };
  }, [title]);
  return (
    <div className="flex items-center justify-between mb-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div className="flex gap-2">{children}</div>
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return <div className="bg-red-900/50 border border-red-700 text-red-200 rounded p-3 text-sm">{message}</div>;
}

export function ConfirmDialog({
  title,
  requiredText,
  onConfirm,
  onCancel,
  busy,
}: {
  title: string;
  requiredText: string;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const [text, setText] = useState("");
  const valid = text === requiredText;
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-slate-900 border border-slate-700 rounded-lg p-6 w-[28rem]">
        <h2 className="text-lg font-semibold mb-2">{title}</h2>
        <p className="text-sm text-slate-400 mb-4">
          Type <span className="font-mono text-red-300">{requiredText}</span> to confirm. This action cannot be undone.
        </p>
        <input
          className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 mb-4 font-mono text-sm"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={requiredText}
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-2 text-sm bg-slate-800 hover:bg-slate-700 rounded">
            Cancel
          </button>
          <button
            disabled={!valid || busy}
            onClick={onConfirm}
            className="px-4 py-2 text-sm bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed rounded"
          >
            {busy ? "Working…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function useApiAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      return true;
    } catch (err) {
      setBusy(false);
      throw err;
    }
  };
  return { busy, setBusy, run };
}

export async function confirmAndRun(
  action: () => Promise<unknown>,
  setBusy: (b: boolean) => void,
): Promise<void> {
  try {
    await action();
  } finally {
    setBusy(false);
  }
}

export function useConfirm() {
  const [confirm, setConfirm] = useState<{ title: string; requiredText: string; action: () => Promise<void> } | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = confirm ? (
    <ConfirmDialog
      title={confirm.title}
      requiredText={confirm.requiredText}
      busy={busy}
      onConfirm={async () => {
        setBusy(true);
        try {
          await confirm.action();
          setConfirm(null);
        } catch (err) {
          alert(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
      onCancel={() => setConfirm(null)}
    />
  ) : null;
  return { confirm: (title: string, requiredText: string, action: () => Promise<void>) => setConfirm({ title, requiredText, action }), dialog };
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function masked(): string {
  return "••••••••••••••••••";
}

export { api };