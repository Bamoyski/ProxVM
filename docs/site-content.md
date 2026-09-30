# Site content mini-CMS

Edit the site's text from the UI (Settings → Content, administrators only)
instead of deploying code. Nothing is required: every key falls back to a
built-in default when unset, and clearing a field restores it.

## Editable keys

| Key | Page | Rules |
|---|---|---|
| `contact.email` | Contact | Must be an email address |
| `contact.github` | Contact | Must start with `https://` |
| `contact.repo` | Contact | Must start with `https://` |
| `donate.intro` | Donate | Plain text, ≤5000 chars |
| `donate.funfact` | Donate | Plain text, ≤5000 chars |
| `donate.tiers` | Donate | JSON array, ≤12 entries of `{amount ≤24, blurb ≤300}`; invalid JSON falls back to built-ins |

## Safety model

- Keys are an exact server-side allowlist — nothing else in settings is
  reachable, and unknown keys are rejected before any write.
- Values render as **text** (React-escaped). Link keys additionally require
  `https://` server-side *and* client-side, because `href` attributes are
  the one place escaping alone is insufficient (`javascript:` URLs).
- Reads require a session (same visibility as the pages showing the copy);
  writes require `settings.manage` and are audited as `SETTINGS_CHANGED`.
- Storage is plain settings rows (`category: "content"`), so no migration
  was needed and backups cover it automatically.

## Adding a new editable spot

1. Pick a `snake.case` key and a built-in default in the page component.
2. Read it via `useSiteContent()` (`get` for text, `getHttps` for links).
3. Append the key to `KNOWN_KEYS` in `apps/api/src/routes/content.ts` plus
   any value validation, and to `FIELDS` in `apps/web/src/pages/Content.tsx`.
