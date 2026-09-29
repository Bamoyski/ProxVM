import { PageTitle } from "../components/ui.js";

export const CONTACT_EMAIL = "bamoyskistudios@gmail.com";
export const GITHUB_PROFILE_URL = "https://github.com/Bamoyski";
export const GITHUB_REPO_URL = "https://github.com/Bamoyski/ProxVM";

export default function Contact() {
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
            <a className="font-mono text-blue-300 hover:text-blue-200 underline" href={`mailto:${CONTACT_EMAIL}`}>
              {CONTACT_EMAIL}
            </a>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-slate-500 w-20">GitHub</span>
            <a
              className="font-mono text-blue-300 hover:text-blue-200 underline"
              href={GITHUB_PROFILE_URL}
              target="_blank"
              rel="noreferrer"
            >
              github.com/Bamoyski
            </a>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-slate-500 w-20">Project</span>
            <a
              className="font-mono text-blue-300 hover:text-blue-200 underline"
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noreferrer"
            >
              github.com/Bamoyski/ProxVM
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
