import { Fragment } from "react";
import { PageTitle, Section } from "../components/ui.js";
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
    <div className="pv-page pv-page-narrow">
      <PageTitle title="Donate" />
      <Section title="Support ProxVM">
        <p style={{ fontSize: "0.88rem", color: "var(--pv-text-2)", margin: "0 0 12px" }}>
          {intro ?? (
            <>
              ProxVM is free and open-source (MIT), built and maintained by{" "}
              bamoyskistudios. If it is useful to you,
              a coffee keeps development — and the homelab it runs on — going.
            </>
          )}
        </p>
        <p style={{ fontSize: "0.86rem", color: "var(--pv-text-2)", margin: "0 0 16px" }}>
          {funfact ??
            "Fun fact: ProxVM is designed, built, and run by two 15-year-olds out of a home lab. Every donation goes directly to two teenagers buying server parts instead of video games (mostly)."}
        </p>
        <div style={{ marginBottom: 20 }}>
          <a className="pv-btn pv-btn-primary" href={DONATE_URL} target="_blank" rel="noreferrer">
            Donate on Ko-fi
          </a>
        </div>
      </Section>
      <Section title="What your donation buys">
        <dl className="pv-kv">
          {tiers.map((t) => (
            <Fragment key={t.amount}>
              <dt className="pv-mono">{t.amount}</dt>
              <dd style={{ color: "var(--pv-text-2)" }}>{t.blurb}</dd>
            </Fragment>
          ))}
        </dl>
        <p className="pv-hint" style={{ marginTop: 12 }}>
          Donations go through Ko-fi; ProxVM itself never touches payment details. Donations are
          voluntary and do not buy features, support SLAs, or influence access decisions.
        </p>
      </Section>
    </div>
  );
}
