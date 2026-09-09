# Frontend architecture (`frontend`)

A map of the Next.js App Router client, for someone reading it for the first
time. The frontend talks to **Berry only**, through one seam, and holds no
provider secrets.

## The shape in one paragraph

A route under `app/` renders components from `components/`. Anything that needs
server data calls a **client module** in `lib/` (never `fetch` directly), which
goes through the one API seam `lib/api.ts`. Cross-render state lives in a
**Zustand store** in `store/`, seeded from the domain types in `data/`. Shared
subscriptions and loaders are **hooks** in `hooks/`. There is no test runner —
a change is verified with `pnpm lint`, `pnpm build:check`, and a look at the
screen.

```
app/<route>/page.tsx
   │  renders
   ▼
components/…                     Zustand store (store/…)  ← seeded from data/…
   │  data via                        ▲
   ▼                                  │ shared loaders/subscriptions
lib/<domain>.ts  ──►  lib/api.ts  ──► Berry API (same-origin, proxied)
                                      hooks/…
```

## Folder responsibilities

| Folder | Responsibility |
| --- | --- |
| `app/` | Next.js App Router routes. Public routes (`login`, `sign-in`, `sign-up`, `onboarding`) sit at the top; everything authenticated lives under the dynamic `app/[orgId]/` segment (issues, projects, agents, plans, goals, members, the `settings/` tree, …). `layout.tsx` wraps the app in the session gate; `globals.css` holds the semantic design tokens. |
| `components/` | React components, grouped: `ui/` are the shadcn/Radix primitives; `common/` are the domain components (one subfolder per feature); `layout/`, `auth/`, `brand/`, `onboarding/` are their namesakes; `data-table-filter/` is vendored (the **only** place `any` is allowed). |
| `lib/` | One client module per resource (`issues.ts`, `projects.ts`, `agents.ts`, …), each calling the API through `api.ts`. Also `config.ts` (the `NEXT_PUBLIC_*` knobs) and shared utilities. **All server traffic goes through `api.ts`.** |
| `store/` | Zustand stores, one per screen or feature slice (`session-store`, `issues-store`, `filter-store`, `event-stream-store`, …). State the UI reads and mutates. |
| `data/` | Domain types and intentionally **empty** collections. `currentUser` is a pre-auth placeholder. Do not reintroduce the Circle template's demo datasets. |
| `hooks/` | Shared React hooks: realtime event-stream subscriptions, `use-hydrate-workspace-data`, entity loaders (`use-plan`/`use-project`/`use-goal`), and `use-mobile`. |

## Conventions worth knowing before you edit

- **Call Berry only through `lib/api.ts`** (`apiUrl` / `apiFetch`). Do not
  hand-roll `fetch`, and never call a model provider from the browser. The API
  is same-origin, proxied to the server by the Next.js rewrites; an empty
  `NEXT_PUBLIC_BERRY_API_URL` is the normal case.
- **No secret may use a `NEXT_PUBLIC_*` name** — that prefix is the browser
  bundle. The session token lives in an in-memory closure plus tab-scoped
  `sessionStorage`, never in a URL or build variable (`lib/session.ts`).
- **Store for shared state, `lib/` for one-shot operations.** A component reads
  and mutates cross-render collection state through the Zustand store, but calls
  a `lib/<domain>.ts` function directly for a single-record fetch, a create, or
  a delete — operations that do not belong in a client cache. Both talking to
  the same feature from one component is expected; it is not a layering
  violation, and wrapping a one-shot call in a pass-through store action only
  adds indirection.
- **Formatting:** Prettier with **3-space** indent, single quotes, semicolons,
  `es5` trailing commas, `printWidth` 100. The alias `@/*` maps to the frontend
  root (the bundler resolves it — unlike the server, aliases are fine here).
- **Forms use `react-hook-form` + a Zod schema** (one schema per form). The
  frontend is on **Zod 3** (`package.json` pins `^3.24.2`) while the server is
  on Zod 4 — do not assume they match. See `lib/zod-resolver.ts` for the
  resolver seam that bridges `@hookform/resolvers` 4 against Zod 3.
- **No test runner.** Verify with `pnpm lint` and `pnpm build:check` (which
  writes to a throwaway dist dir so it will not corrupt a running `next dev`),
  plus a manual check of the changed view.
- Prefer existing `ui/` primitives and the semantic tokens in `globals.css`
  over new components or raw palette utilities.
