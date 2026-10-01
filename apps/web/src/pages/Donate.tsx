import { PageTitle } from "../components/ui.js";
import { useSiteContent } from "../content.js";

export const DONATE_URL = "https://ko-fi.com/bamoyskistudios";

const DEFAULT_TIERS = [
  { amount: "$3", blurb: "Helps keep the site up." },
  { amount: "$5", blurb: "Helps cover yearly domain renewals." },
  { amount: "$10", blurb: "Helps cover a month of power for an always-on lab server." },
  { amount: "$25", blurb: "Goes to parts: SSDs, cables, replacement fans." },
  { amount: "$50", blurb: "Goes to RAM and storage upgrades for hosted VMs." },
  { amount: "$100+", blurb: "Directly funds the next Proxmox node." },
];

function parseTiers(raw: string | null): Array<{ amount: string; blurb: string }> {
  if (!raw) return DEFAULT_TIERS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 12) return DEFAULT_TIERS;
    const clean = parsed.filter(
      (t): t is { amount: string; blurb: string } =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as { amount?: unknown }).amount === "string" &&
        typeof (t as { blurb?: unknown }).blurb === "string" &&
        (t as { amount: string }).amount.length > 0 &&
        (t as { blurb: string }).blurb.length > 0,
    );
    return clean.length > 0 ? clean : DEFAULT_TIERS;
  } catch {
    return DEFAULT_TIERS;
  }
}

export default function Donate() {
  const { get } = useSiteContent();
  const intro = get("donate.intro");
  const funfact = get("donate.funfact");
  const tiers = parseTiers(get("donate.tiers"));
  return (
    <div className="max-w-3xl">
      <PageTitle title="Donate" />
      <div className="bg-slate-900 border border-slate-800 rounded p-5 text-sm text-slate-300 space-y-4">
        <p>
          {intro ?? (
            <>
              ProxVM is free and open-source (MIT), built and maintained by{" "}
              <span className="font-medium text-slate-100">bamoyskistudios</span>. If it is useful to you,
              a coffee keeps development — and the homelab it runs on — going.
            </>
          )}
        </p>
        <p className="text-slate-400">
          {funfact ??
            "Fun fact: ProxVM is designed, built, and run by two 15-year-olds out of a home lab. Every donation goes directly to two teenagers buying server parts instead of video games (mostly)."}
        </p>
        <a
          className="inline-block px-5 py-2.5 text-sm font-medium bg-amber-500 hover:bg-amber-400 text-slate-950 rounded"
          href={DONATE_URL}
          target="_blank"
          rel="noreferrer"
        >
          ☕ Donate on Ko-fi
        </a>
        <div>
          <h2 className="text-base font-medium text-slate-100 mb-2">What your donation buys</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {tiers.map((t) => (
              <div key={t.amount} className="bg-slate-800/60 border border-slate-700/60 rounded p-3">
                <div className="font-mono text-amber-300 text-sm mb-1">{t.amount}</div>
                <div className="text-xs text-slate-400">{t.blurb}</div>
              </div>
            ))}
          </div>
        </div>
        <p className="text-slate-500 text-xs">
          Donations go through Ko-fi; ProxVM itself never touches payment details. Donations are
          voluntary and do not buy features, support SLAs, or influence access decisions.
        </p>
      </div>
    </div>
  );
}
