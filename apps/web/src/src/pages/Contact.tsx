import { Fragment } from "react";
import { PageTitle, Section } from "../components/ui.js";
import { useSiteContent } from "../content.js";

export const CONTACT_EMAIL = "bamoyskistudios@gmail.com";
export const GITHUB_PROFILE_URL = "https://github.com/Bamoyski";
export const GITHUB_REPO_URL = "https://github.com/Bamoyski/ProxVM";

function displayHost(url: string): string {
  try {
    return new URL(url).host + new URL(url).pathname.replace(/\/$/, "");
  } catch {
    return url;
  }
}

export default function Contact() {
  const { get, getHttps } = useSiteContent();
  const email = get("contact.email") ?? CONTACT_EMAIL;
  const github = getHttps("contact.github") ?? GITHUB_PROFILE_URL;
  const repo = getHttps("contact.repo") ?? GITHUB_REPO_URL;
  const rows: Array<[string, string, string]> = [
    ["Email", email, `mailto:${email}`],
    ["GitHub", displayHost(github), github],
    ["Project", displayHost(repo), repo],
  ];
  return (
    <div className="pv-page pv-page-narrow">
      <PageTitle
        title="Contact"
        description="ProxVM is built and maintained by bamoyskistudios. For questions, bug reports, access requests, or anything else, reach out:"
      />
      <Section title="Reach us">
        <dl className="pv-kv">
          {rows.map(([k, v, href]) => (
            <Fragment key={k}>
              <dt>{k}</dt>
              <dd>
                <a className="pv-mono" href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
                  {v}
                </a>
              </dd>
            </Fragment>
          ))}
        </dl>
        <p className="pv-hint" style={{ marginTop: 12 }}>
          Security vulnerabilities? Please email them directly instead of opening a public issue — see
          SECURITY.md in the repository for details.
        </p>
      </Section>
    </div>
  );
}
