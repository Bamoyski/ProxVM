# ProxVM UI rewrite — architecture decision

## Chosen stack

**React 18 + TypeScript + Vite 6 + react-router-dom 7 + TanStack Query 5 —
with a hand-rolled, token-driven CSS design system and `lucide-react` for
icons.** No Tailwind, no component library, no CSS-in-JS.

| Concern | Choice |
| --- | --- |
| Framework | React 18 (kept) |
| Language | TypeScript strict (kept) |
| Build | Vite 6 (kept) |
| Routing | react-router-dom 7, same route map + all legacy redirects (kept) |
| Server state | TanStack Query 5, existing query keys (kept) |
| Styling | Global CSS: `src/styles/tokens.css` + `base.css` + `components.css`, semantic `pv-*` classes only |
| Icons | `lucide-react` (single tree-shakeable family) |
| Forms | Controlled inputs + shared field primitives (no form library) |
| Charts | Hand-rolled inline SVG (kept pattern, improved) |
| Feedback | Context-based toast system (replaces `alert()`) + inline alerts |

## Alternatives considered

- **Svelte/Solid/Vue migration.** Rejected: the frontend talks to a mature
  Fastify backend through `@proxvm/shared` types and a session+CSRF fetch
  layer. A framework swap rewrites 100% of the UI code while adding zero
  product capability, breaks the shared-type build alias, and doubles the
  regression surface on a platform that drives live infrastructure. The
  brief's own rule applies: a well-architected implementation in the
  current framework beats an unnecessary migration.
- **Tailwind (kept).** Rejected: the repo carries vestigial Tailwind whose
  only real effect is a 130-line `html.light .bg-slate-950`-style override
  hack that fights the real design system. Removing it eliminates a second
  styling vocabulary and the light-mode whack-a-mole entirely.
- **daisyUI / MUI / Radix adoption.** Rejected as dependencies: ProxVM's
  density, status semantics, and dark-first tokens are specific enough
  that a home-grown component layer (≈20 small components over one CSS
  file) is smaller, fully controlled, and dependency-free. daisyUI remains
  a *design reference* for breadth/consistency, not code.

## Rationale

1. **Zero backend risk.** All API contracts, CSRF handling, permission
   model, SSE job streams, and Guacamole launch flows are preserved
   verbatim in `api.ts`; pages keep their existing query keys so cache
   behavior and refetch cadences survive.
2. **One visual vocabulary.** A single token file drives dark + light
   themes; every component consumes semantic classes, so theme and density
   changes are one-file operations.
3. **Maintainability.** New pages compose ~20 primitives (Button, Field,
   Table, Dialog, Tabs, Toast, StatusBadge…) instead of ad-hoc inline
   styles, which is what made the old pages drift apart.
4. **Performance.** No new runtime CSS or UI framework; icons tree-shake;
   route-level lazy loading via `React.lazy` for rarely used screens.

## Structure

```
apps/web/src/
  styles/        tokens.css · base.css · components.css (semantic pv-* classes)
  api.ts         fetch layer: CSRF, ApiRequestError, explainDenial, SSE jobs
  prefs.ts       proxvm-pref:* localStorage helpers (theme, sorts, layouts)
  iam.ts         effective-permission query + makeCan (effective-first check)
  lib/           format.ts · permissions.ts · vm.ts · provision.ts
  ui/            index.ts barrel over Button.tsx · form.tsx (Field/Input/
                 Select/Checkbox/Switch/SearchInput) · feedback.tsx (Badge/
                 StatusBadge/Alert/EmptyState/Meter/Progress/Tooltip/Copy) ·
                 overlay.tsx (Menu/Dialog/Confirm/Popover) · layout.tsx
                 (PageHeader/Section/KeyValue/Tabs/Table) · toast.tsx
                 (ToastProvider/useToast/ConfirmProvider/useConfirm)
  shell/         AppShell.tsx (sidebar + topbar + announcement + bells) ·
                 nav.ts (route table, visibility rules)
  components/    CommandPalette.tsx · NotificationBell.tsx · ThreatBell.tsx
  hooks/         me.ts (useMe)
  pages/         one component per route; tab panes switch via ?tab= inside
                 the route component (Access/System/Configuration/About/…)
```

## Component & interaction rules

- Server state only through TanStack Query; mutations invalidate the exact
  query keys the old code used. No second cache, no duplicated truth.
- Every long-running action shows accepted → running → done/failed
  feedback (toasts + inline), never `alert()`.
- Permission gating: backend remains authoritative; the frontend uses the
  effective-permission set (`/iam/effective`) with the legacy role map as
  loading fallback, exactly like before, just centralized.
- Secrets: reveal/rotate flows unchanged (server-mediated, 30s auto-hide,
  no browser storage).
- Tables: real `<table>` markup, consistent density, numeric columns
  tabular-nums, horizontal scroll containers on narrow screens.
- Accessibility: semantic HTML first, dialog focus trap + Escape, visible
  focus rings, `prefers-reduced-motion` honored by all transitions.

## Testing approach

- Root gates unchanged: `npm.cmd run typecheck`, `npm.cmd run test`,
  `npm.cmd run build` (shared/core/api suites untouched; `test` now also runs
  `-w @proxvm/web`).
- Web vitest setup (`apps/web/vitest.config.ts`, node environment, no jsdom
  dependency) covering pure logic:
  - `src/lib/provision.test.ts` — payload parity for both provision modes
    (extracted `lib/provision.ts` builders; asserts exact JSON wire shape,
    including which keys are omitted so the server applies defaults).
  - `src/ui/status.test.ts` — status → tone mapping for every backend status
    class (ok/warn/err/info/none), null-safety, unknown-status fallback.
  - `src/api.test.ts` — `explainDenial` per denial reason, `friendlyHttpMessage`
    for proxy/edge status codes, `ApiRequestError` shape.
  - `src/lib/permissions.test.ts` — legacy role → permission fallback matrix
    (admin/operator/user/guest, unions, unknown roles).
  - `src/lib/format.test.ts` — null-safe formatters (bytes, uptime, relative
    time, day lists, expiry presets, percent).
- Live behavior verification against the dev stack (vite + api) in a real
  browser for core flows.

## Verification performed

Browser verification ran against the dev server with a fixture API (a
temporary mock on :4000 that mirrors the shapes the frontend declares — no
live infrastructure was touched, and the mock lives only in the temp
directory).

| Check | Result |
| --- | --- |
| `npm.cmd run typecheck` | pass |
| `npm.cmd run test` | pass — 605 tests (core 323, api 215 + 1 skipped, web 67) |
| `npm.cmd run build` | pass — route-level chunks, no bundle warnings |
| All 21 routes, both themes | no console errors, no failed requests |
| All 20 legacy redirects | every one lands on the right page and content |
| Lighthouse accessibility (12 pages × 2 themes) | 1.00, zero failures |
| Lighthouse best-practices / SEO | 1.00 / 1.00 |
| Layout at 390 / 768 / 1024 / 1440 px | no horizontal overflow anywhere |
| Headings | exactly one visible `h1` per page (incl. Login and setup) |
| Form controls | every input/select/textarea has an accessible name |
| Pointer targets | no standalone control below 24 px |
| Keyboard | Ctrl+K palette, focus trap + focus return in dialogs, Escape closes the topmost layer only |

Defects found and fixed during this pass (all caught by the browser, not by
the compiler): the mobile nav opener was hidden exactly when the sidebar
becomes off-canvas; tab pages mounted their panel twice; several form
controls had no accessible name; the tertiary text and link colours missed
4.5:1 in light mode; and some standalone controls were under the 24 px
minimum target size.

## Migration constraints

- Route map and redirects are frozen: every old URL keeps working.
- No API payload changes. The provision payload builders emit byte-for-byte
  the same bodies as the old dialog (basic + advanced).
- Old `pv-*` class names survive where sensible (continuity of the design
  lineage); the vocabulary is extended, not renamed for its own sake.
