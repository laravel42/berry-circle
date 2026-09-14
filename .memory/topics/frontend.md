# Frontend

- 2026-08-28 — **Supersedes the API-seam entries below.** One backend origin: `BERRY_API_ORIGIN`, proxied by `next.config.ts` for `/api/*`, `/health` and `/ready`. The runs page's endpoints (`/api/v1/issues/{id}/runs`, `/api/v1/runs/{id}/events`) are not served and answer 404. The model playground and `lib/runtime.ts` were removed with the runtime they probed.
- 2026-08-22 — Circle template (MIT, upstream `7785985`) vendored into `frontend/`, demo data stripped, rebranded to Berry (BERR-28). Notice stays in `frontend/LICENSE.md`.
- 2026-08-22 — Removed the sidebar "UI based on Circle (MIT)" attribution; HelpButton remains in `SidebarFooter`.
- 2026-08-22 — Stack from `frontend/package.json`: Next.js App Router, React 19, Tailwind v4, shadcn/Radix, Zustand, nuqs, Zod 4. Tooling is Bun + Prettier 3-space + ESLint. README/playbook still say Next 15 — trust `package.json`.
- 2026-08-22 — Gateway seam: `lib/config.ts` + `lib/api.ts`. Empty `NEXT_PUBLIC_BERRY_API_URL` boots with no data. Board/issue wiring is BERR-29/30.
- 2026-08-22 — BERR-29 committed on `feat/berr-29-board-gateway-wiring` (`766365f`): hydrates the issue store via `apiFetch` when both `NEXT_PUBLIC_BERRY_API_URL` and `NEXT_PUBLIC_BOARD_ID` are set; otherwise stays empty. Create/PATCH/detail left for later.
- 2026-08-22 — `data/*` keeps Circle domain types and empty arrays; `store/*` seeds from them. Do not restore mock datasets. `currentUser` is a pre-auth placeholder.
- 2026-08-22 — Design-system baseline is `docs/design-system.md`. Semantic tokens only; proposed status/actor aliases are not implemented. Circle comments saying "Linear-style" are leftover, not a brand license.
- 2026-08-22 — Runs page dispatches `POST /api/v1/issues/{id}/runs` and follows `GET /api/v1/runs/{id}/events`. Agents hydrate from `GET /api/v1/agents`. Prototype runtime agent is `berry-prototype`.
- 2026-08-22 — Workspace type scale stepped down (`text-sm` 13/20, `text-xs` 11/16, display titles ~one step smaller). Sidebar `[data-slot=sidebar]` keeps the previous 15/26 menu sizes.
- 2026-08-23 — Dark `input`/`textarea` text must set `-webkit-text-fill-color` to `--foreground`. `color` alone leaves WebKit’s black fill; low-opacity `muted-foreground` placeholders also read as black on void. Use `placeholder:text-foreground/40`.
- 2026-08-23 — Swept remaining compose/comment fields (create issue, activity, inbox, command palette, agent search, markdown preview) onto `text-foreground` + `placeholder:text-foreground/40`.
- 2026-09-01 — **Supersedes the runs-404 claim above**: `/api/v1/runs` is served. The rail shows `projects` and `goals` by default, `projects` first, and sidebar preferences moved to `sidebar-prefs-v6` — the upgrade deliberately drops the stored order and visibility, because a stored preference outranks a new default forever. The goal write UI (New goal dialog, its store and provider) and the "Plan something" buttons are gone; planning happens in the create-project dialog.
