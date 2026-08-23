# Repository Guidelines

Guidance for AI agents working in this repository.

> **Single source of truth:** this file is the short pointer. Authoritative
> write-ups live in `docs/`. Read the doc that matches the work before editing.
> Use each workspace's manifest and build documentation as the source of truth
> for commands.

| If you are… | Read first |
| --- | --- |
| Changing product scope or motion | [`docs/product-brief.md`](docs/product-brief.md) |
| Writing code, tests, commits, or PRs | [`docs/coding-playbook.md`](docs/coding-playbook.md) |
| Touching the public HTTP/SSE contract | [`docs/api/gateway-v1.md`](docs/api/gateway-v1.md) |
| Calling or adapting OpenFang | [`docs/integrations/berry-openfang.md`](docs/integrations/berry-openfang.md), [`docs/api/openfang-gateway-consumption.md`](docs/api/openfang-gateway-consumption.md) |
| Changing stack, cache, or the pin | [`docs/adr/`](docs/adr/) |
| Adapting Multica server material | [`docs/provenance/multica-server-reuse.md`](docs/provenance/multica-server-reuse.md), [`docs/parity/multica-web.md`](docs/parity/multica-web.md) |
| Changing UI tokens or visual language | [`docs/design-system.md`](docs/design-system.md) |
| Shipping a notable change | [`docs/changelog-process.md`](docs/changelog-process.md) |

## What Berry is

Berry is a self-hosted, multi-workspace web product where humans and AI coding
agents plan, execute, and review work together. It is the product and
persistence layer on top of
[OpenFang](https://github.com/RightNow-AI/openfang). Berry does **not** rebuild
agent execution, sandboxing, or provider plumbing.

Core loop: issue → assign to a human or agent → work on the issue → human
review gate → done. The approved direction is phased full web parity; desktop
and mobile remain excluded. The Bun gateway and Circle-vendored frontend are
the current implementation, while the Go product server is not scaffolded yet.

## Repository shape

One Git repo, three independently tooled workspaces. They do **not** share a
formatter, lint config, language target, or generated-code workflow. Know which
workspace you are in before you write code. Never run one workspace's tools
over another.

| | `server/` | `apps/gateway/` | `frontend/` |
| --- | --- | --- | --- |
| Role | Go product server (scaffold pending) | Bun + Hono compatibility oracle during migration | Next.js App Router UI (Circle, MIT) |
| Package/module | Go module, defined by scaffold | `@berry/gateway` | `berry-frontend` |
| Paths | Standard Go packages | `~/*` → `src/*` | `@/*` → frontend root |
| Format + lint | `gofmt`; exact gates land with scaffold | Biome (2-space, double quotes) | Prettier **3-space**, single quotes + ESLint |
| Tests | `go test ./...` once scaffolded | `bun:test` | none yet — lint + `next build` |
| Validation | pgx/sqlc boundaries | Zod v3 | Zod v4 |

Also in the repo: `docs/`, `docker-compose.yml` (OpenFang + Postgres + Valkey),
`deploy/openfang.pin.json` (ADR-0003 source of truth).

## Hard boundaries

- **Browsers call Berry only.** During migration that boundary is the Bun
  gateway; after cutover it is the Go server. Never send `OPENFANG_API_KEY` to
  a client, log it, persist it in product rows, or call OpenFang from the
  frontend. Current gateway calls use `tracedFetch` / `getTraceHeaders()`; the
  Go scaffold must provide the equivalent server-side adapter boundary.
- **Berry owns product state.** Postgres is authoritative for users, sessions,
  boards, issues, assignments, comments, review decisions, and the run ledger.
  Valkey (ADR-0002) is cache and ephemeral coordination only — not implemented
  in gateway code yet. OpenFang keeps its own SQLite; it does not use Berry's
  Postgres or Valkey.
- **OpenFang has no issue-correlated run resource.** Berry must mint its own
  run ID before dispatch and persist status, events, usage, and cost. Do not
  treat session/audit/usage/workflow-runs as a substitute. Do not auto-retry
  `POST` dispatch or reconnect an SSE stream by repeating the POST.
- **Pin OpenFang by full commit SHA.** `deploy/openfang.pin.json` is the
  machine-readable pin. A reviewed upgrade updates the pin, the compose
  `OPENFANG_COMMIT` default, and the integration contract in one change.
- **Licenses.** Shipped dependencies must be MIT / Apache-2.0 (or equivalently
  permissive). Retain Circle and OpenFang MIT notices. Do not copy another
  product's schema, brand, or marks. Do not use "OpenFang" or "Linear" as
  Berry product branding or new code identifiers. Existing Circle comments
  that say "Linear-style" are legacy — do not spread that into new APIs.
  Multica-derived Go work additionally follows
  [`docs/provenance/multica-server-reuse.md`](docs/provenance/multica-server-reuse.md).
- **TypeScript `strict` stays on. No `any`.** Narrow instead of `!`. The only
  `any` exemption is vendored `frontend/components/data-table-filter/**`.

## Current implementation (do not invent the missing layer)

**Gateway exists:** `/health`, `/metrics`, central `{ error: { code, message } }`
envelope, Pino + OTel, Drizzle schema + migrations. **Not built yet:**
`/api/v1` product routes, OpenFang adapter module, Valkey, run persistence,
auth/session HTTP. It remains the compatibility oracle until Go cutover.

**Go server does not exist yet:** `server/` and its exact commands land with
the scaffold. Do not invent a module path, generated-code command, or CI gate
before that change. Its target architecture is
[`ADR-0004`](docs/adr/0004-go-product-server.md).

**Frontend exists:** Circle shell, empty `data/*` modules, Zustand stores,
`lib/api.ts` (`apiUrl` / `apiFetch`) and `lib/config.ts`. **Not built yet:**
board/issue/run wiring (BERR-29/30). Do not reintroduce demo/mock datasets.
`NEXT_PUBLIC_BERRY_API_URL` empty means the app boots with no data.

Schema notes that can bite you:

- Allocate `issues.number` via atomic `boards.issue_counter` in the same
  transaction — never `MAX(number)+1`.
- `assignee_type` / `assignee_id` are both-or-neither.
- Validate `boards.columns` with Zod on every write (DB only checks JSON array).
- Same-issue comment threading is not DB-enforced; validate on the write path.
- Schema comments still say the BERR-11 contract is being drafted; the
  contract in `docs/api/gateway-v1.md` is the target public interface.
  Storage names are not API field names (`camelCase` over the wire).

OpenFang adapter gaps (pinned commit `acf2587e`): memory KV ignores `{id}`
(prefix keys by workspace/agent); workflow-runs list ignores `{id}`; no SSE
resume cursor.

The expanded target and every source feature classification live in
[`docs/parity/multica-web.md`](docs/parity/multica-web.md). Do not port a
legacy feature that is classified as replaced or excluded.

## Commands

```bash
# Local substrate (from repo root)
cp .env.example .env && docker compose up -d --build

# Go server
# Not runnable until the server scaffold lands server/go.mod and its documented
# generation/formatting gates. Intended native gates landing with that scaffold:
cd server
go vet ./...
go test ./...

# Gateway
cd apps/gateway
bun run typecheck && bun run lint && bun test
bun run db:generate    # after schema.ts edits
bun run db:migrate     # requires DATABASE_URL
bun run test:smoke:openfang

# Frontend
cd frontend
bun run lint && bun run build
```

The Go commands above are future gates, not a claim that `server/` exists
today. The scaffold must also define its `gofmt` and sqlc generation checks.
DB-backed gateway tests must self-skip when `DATABASE_URL` is unset so a fresh
`bun test` stays green. Endpoint tests drive `createApp()` with
`app.request(...)`.

## Commits, branches, review

```
type(scope): imperative summary (BERR-NN)
```

- Scopes: `server`, `gateway`, `frontend`, or omit for docs-only.
- Agent runtime branches: stay on `agent/<name>/<hash>`. Hand-authored:
  `fix/berr-NN-short-slug`. One issue per branch and PR.
- Reviewers: **Sentinel** (frontend), **Backend PR Adversary** (backend).
  Zero blocking findings is merge authority; re-review the full PR after
  fixes. On a clean review, merge and move the issue to **done**.

Definition of done: after its scaffold lands, server formatting, static
analysis, and tests; gateway typecheck + lint + test while it exists; frontend
lint + build and a manual check of the changed view. No secrets or `.env`
files.

## Domain reminders

- Assignees are polymorphic: `user | agent`.
- Issue statuses: `backlog → todo → in_progress → in_review → done`
  (`cancelled` exists). The release gate is always human.
- Public API: `/api/v1`, cursor pagination, `Idempotency-Key` on creating
  POSTs, stable `SCREAMING_SNAKE_CASE` error codes.
- Env booleans: do not use `z.coerce.boolean()` (`"false"` becomes `true`).
  Follow `boolFromEnv` in `apps/gateway/src/config.ts`.
- Frontend issue prefix default is `BERRY`; tracker issues are `BERR-NN`.
  Do not conflate them.
- Prefer semantic design tokens over raw palette utilities. Proposed
  status/actor aliases in the design-system doc are not implemented yet.
- Native inputs need `--foreground` and `-webkit-text-fill-color`. Fading
  placeholders with low-opacity `muted-foreground` reads as black on void.
