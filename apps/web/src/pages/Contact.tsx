import { PageTitle } from "../components/ui.js";
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
  return (
    <div className="max-w-3xl">
      <PageTitle title="Contact" />
      <div className="bg-slate-900 border border-slate-800 rounded p-5 text-sm text-slate-300 space-y-4">
        <p>
          ProxVM is built and maintained by <span className="font-medium text-slate-100">bamoyskistudios</span>.
          For questions, bug reports, access requests, or anything else, reach out:
        </p>
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <span className="text-slate-500 w-20">Email</span>
            <a className="font-mono text-blue-300 hover:text-blue-200 underline" href={`mailto:${email}`}>
              {email}
            </a>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-slate-500 w-20">GitHub</span>
            <a
              className="font-mono text-blue-300 hover:text-blue-200 underline"
              href={github}
              target="_blank"
              rel="noreferrer"
            >
              {displayHost(github)}
            </a>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-slate-500 w-20">Project</span>
            <a
              className="font-mono text-blue-300 hover:text-blue-200 underline"
              href={repo}
              target="_blank"
              rel="noreferrer"
            >
              {displayHost(repo)}
            </a>
          </div>
        </div>
        <p className="text-slate-500 text-xs">
          Security vulnerabilities? Please email them directly instead of opening a public issue — see
          SECURITY.md in the repository for details.
        </p>
      </div>
    </div>
  );
}
