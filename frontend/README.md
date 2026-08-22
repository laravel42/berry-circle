# Berry — Frontend

Next.js frontend for Berry, a team workspace where humans and AI coding
agents share one board. Vendored from the MIT-licensed
[Circle](https://github.com/ln-dev7/circle) template (see `LICENSE.md` for
the upstream notice) with its demo/mock data layer stripped: every list
(issues, projects, teams, members, cycles, views, reviews, inbox) boots
empty and will be filled from the Berry gateway (BFF) as wiring lands.

## Stack

Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS v4 ·
shadcn/ui · Zustand · nuqs. Managed with Bun.

## Getting started

```shell
bun install
cp .env.example .env.local   # optional until the gateway exists
bun run dev
```

## Configuration

All configuration is environment-driven (`NEXT_PUBLIC_*`, inlined at build
time — see `.env.example`):

| Variable | Purpose | Default |
| --- | --- | --- |
| `NEXT_PUBLIC_BERRY_API_URL` | Base URL of the Berry gateway (BFF) | _(empty — app boots with no data)_ |
| `NEXT_PUBLIC_WORKSPACE_SLUG` | URL segment for workspace routes (`/{slug}/…`) | `berry` |
| `NEXT_PUBLIC_WORKSPACE_NAME` | Workspace display name | `Berry` |
| `NEXT_PUBLIC_ISSUE_PREFIX` | Issue identifier prefix (e.g. `BERRY-123`) | `BERRY` |

The gateway client lives in `lib/api.ts` (`apiUrl` / `apiFetch`) and reads
its base URL from `lib/config.ts`. Feature wiring (board, issue detail,
mutations) plugs into that seam — see BERR-29 / BERR-30.

## Data layer

Circle kept all domain types next to its demo data in `mock-data/`. The
directory is renamed `data/` and every demo dataset was removed, but the
module layout is unchanged so the upcoming gateway wiring can adopt it
incrementally:

- `data/*.ts` — domain types (`Issue`, `Project`, `Team`, `User`, …) and
  pure helpers (filtering, grouping, status ordering), all operating on
  empty arrays until real data arrives.
- `store/*.ts` — Zustand stores; seeded from the (empty) data modules.
- `data/users.ts` exports a `currentUser` placeholder used by flows that
  need an identity before auth exists (comment composer, issue creation).

## License

Berry's own code and the Circle template code in this directory are
MIT-licensed. The upstream Circle notice is retained in `LICENSE.md`.
