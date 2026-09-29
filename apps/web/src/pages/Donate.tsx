import { PageTitle } from "../components/ui.js";

export const DONATE_URL = "https://ko-fi.com/bamoyskistudios";

export default function Donate() {
  return (
    <div className="max-w-3xl">
      <PageTitle title="Donate" />
      <div className="bg-slate-900 border border-slate-800 rounded p-5 text-sm text-slate-300 space-y-4">
        <p>
          ProxVM is free and open-source (MIT), built and maintained by{" "}
          <span className="font-medium text-slate-100">bamoyskistudios</span>. If it is useful to you,
          a coffee keeps development — and the homelab it runs on — going.
        </p>
        <a
          className="inline-block px-5 py-2.5 text-sm font-medium bg-amber-500 hover:bg-amber-400 text-slate-950 rounded"
          href={DONATE_URL}
          target="_blank"
          rel="noreferrer"
        >
          ☕ Donate on Ko-fi
        </a>
        <p className="text-slate-500 text-xs">
          Donations go through Ko-fi; ProxVM itself never touches payment details. Donations are
          voluntary and do not buy features, support SLAs, or influence access decisions.
        </p>
      </div>
    </div>
  );
}
