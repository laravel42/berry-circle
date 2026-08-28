# Berry — Frontend

Next.js frontend for Berry, a self-hosted workspace where humans and AI coding
agents plan, execute, and review work together. Vendored from the MIT-licensed
[Circle](https://github.com/ln-dev7/circle) template (see `LICENSE.md` for the
upstream notice) with its demo/mock data layer stripped.

The browser calls Berry only, through `lib/api.ts`. It never receives a
provider credential or talks to a model provider. Empty same-origin config and an empty
`NEXT_PUBLIC_BOARD_ID` boot with no remote issues. Local create-issue writes the
Zustand store only. Do not restore Circle demo datasets or invent run records.

## What you see

Berry Dark is the default theme. Berry Light is the accessible inversion.
System follows the OS and switches between those two. Geist Mono is the UI
face (weight 300 at 13/20; sidebar menu stays 15/26). DM Serif Display is wordmark and display only.
Tokens, contrast, and mark rules live in
[`docs/design-system.md`](../docs/design-system.md).

Default navigation is **issues**, **runs**, **reviews**, and **settings**. `/`
and `/{org}` redirect to `/{org}/runs`. The runs page is a ledger: create an
issue and assign it; a run appears here only when execution is connected.
Inbox, teams, projects, views, members, and other inherited tracker surfaces
are parked under **more** or Customize sidebar. Their routes still exist;
they are not the product home.

Berry is not a chat window. Delegated work must be visible on the ledger.

## Stack

Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS v4 ·
shadcn/ui · Zustand · nuqs · next-themes. Managed with Bun. Format with
Prettier **3-space**; lint with ESLint. Do not run the gateway Biome tools
here.

## Getting started

```shell
bun install
cp .env.example .env.local
bun run dev
```

Gates: `bun run lint` and `bun run build`, plus a manual check of the
changed view.

## Configuration

The frontend uses a same-origin transport by default. Next.js proxies Berry
requests to a server-only origin, while the optional `NEXT_PUBLIC_*` override
is reserved for explicit cross-origin development:

| Variable                     | Purpose                                                       | Default                              |
| ---------------------------- | ------------------------------------------------------------- | ------------------------------------ |
| `BERRY_API_ORIGIN`           | Server-only target for `/api`, health, readiness, and uploads | `http://127.0.0.1:4000`              |
| `NEXT_PUBLIC_BERRY_API_URL`  | Browser-visible cross-origin development escape hatch         | _(empty — use same-origin)_          |
| `NEXT_PUBLIC_BOARD_ID`       | Board loaded into issue views until board discovery lands     | _(empty — app boots with no issues)_ |
| `NEXT_PUBLIC_WORKSPACE_SLUG` | URL segment for workspace routes (`/{slug}/…`)                | `berry`                              |
| `NEXT_PUBLIC_WORKSPACE_NAME` | Workspace display name                                        | `Berry`                              |
| `NEXT_PUBLIC_ISSUE_PREFIX`   | Issue identifier prefix (e.g. `BERRY-123`)                    | `BERRY`                              |

`BERRY_API_ORIGIN` is read only by the Next.js server and must not contain
credentials. `NEXT_PUBLIC_BERRY_API_URL` is inlined into the browser bundle;
leave it empty outside deliberate cross-origin development and never put a
token or upstream URL in it.

The Berry client lives in `lib/api.ts` (`apiUrl` / `apiFetch`). It includes
same-origin credentials, parses Berry error envelopes and request IDs, and
accepts an optional runtime in-memory bearer session. When both
`NEXT_PUBLIC_BERRY_API_URL` and `NEXT_PUBLIC_BOARD_ID` are set, the issue
store hydrates from Berry; create, PATCH, and run dispatch are not wired
yet.

## Data layer

Circle kept all domain types next to its demo data in `mock-data/`. The
directory is renamed `data/` and every demo dataset was removed. Types and
helpers stay so API wiring can land incrementally:

- `data/*.ts` — domain types (`Issue`, `Project`, `Team`, `User`, …) and
  pure helpers (filtering, grouping, status ordering), operating on empty
  arrays until real data arrives.
- `store/*.ts` — Zustand stores; seeded from the (empty) data modules.
  Sidebar visibility persists as `sidebar-prefs-v2`.
- `data/users.ts` exports a `currentUser` placeholder used by flows that
  need an identity before auth exists (comment composer, issue creation).

## License

Berry's own code and the Circle template code in this directory are
MIT-licensed. The upstream Circle notice is retained in `LICENSE.md`.
