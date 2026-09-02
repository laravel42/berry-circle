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
| Working on the server at all | [`server-ts/SCOPE.md`](server-ts/SCOPE.md), [`server-ts/ROUTING.md`](server-ts/ROUTING.md) |
| Changing the stack or the schema | [`docs/adr/`](docs/adr/) |
| Changing UI tokens or visual language | [`docs/design-system.md`](docs/design-system.md) |
| Shipping a notable change | [`docs/changelog-process.md`](docs/changelog-process.md) |

## What Berry is

Berry is a self-hosted, multi-workspace web product where humans and AI coding
agents plan, execute, and review work together. Berry owns the product, its
durable state, and agent execution: agents run in-process on the Google Agent
Development Kit ([ADR-0008](docs/adr/0008-adk-agent-runtime.md)), not on a
separate substrate.

Core loop: issue → assign to a human or agent → work on the issue → human
review gate → done. The approved direction is phased full web parity; desktop
and mobile remain excluded.

## Repository shape

One Git repo, two pnpm workspaces. They do **not** share a formatter, lint
config, or validation workflow. Know which workspace you are in before you
write code. Never run one workspace's tools over another.

| | `server-ts/` | `frontend/` |
| --- | --- | --- |
| Role | Product server, migrations, agent runtime | Next.js App Router UI (Circle, MIT) |
| Package | `@berry/server` | `berry-frontend` |
| Paths | relative, `.ts` extensions kept | `@/*` → frontend root |
| Format + lint | none configured; match surrounding style | Prettier **3-space**, single quotes + ESLint |
| Tests | `node --test` | none yet — lint + `next build` |
| Validation | Zod v4 | Zod v4 |

Also in the repo: `docs/`, `docker-compose.yml` (server + Postgres + MinIO),
and `scripts/` (Python repository checks).

The server runs its `.ts` sources directly under `--experimental-strip-types`.
There is no build step, so nothing that emits code — enums, namespaces,
parameter properties — is allowed; `erasableSyntaxOnly` enforces it.

## Hard boundaries

- **Browsers call Berry only.** Never send a provider credential to a client,
  log it, persist it in product rows, or call a model provider from the
  frontend. `NEXT_PUBLIC_*` is the browser bundle: nothing secret may use that
  prefix.
- **Provider secrets are sealed, in one place.** Connection tokens and the
  GitHub App's private key are encrypted with `INTEGRATION_ENCRYPTION_KEY` and
  opened only in `src/integrations/`. That key is the one credential that must
  stay in the environment — it is what everything else is encrypted with, so
  it cannot live in the database it protects. A deployment without it holds no
  provider credential at all rather than holding one in the clear.
- **Berry owns product state.** Postgres is authoritative for users, sessions,
  boards, issues, assignments, comments, review decisions, and the run ledger.
  Valkey (ADR-0002) is cache and ephemeral coordination only, and the current
  Compose stack does not run it — the realtime hub is built with a null relay,
  so events replay from Postgres and arrive on the next poll rather than
  instantly.
- **Migrations are forward-only and immutable.** `server-ts/migrations/` is
  applied by `src/migrate` under an advisory lock, and the ledger stores a
  SHA-256 per file. Never edit an applied migration; add a new one. The runner
  exits non-zero on checksum or name drift rather than migrating over it.
- **The wire shape is a contract.** `/api/v1`, the error envelope, cursor
  pagination, `Idempotency-Key`, opaque session tokens and `berry_pat_` tokens
  keep their exact shapes. Cursors and idempotency fingerprints already issued
  must keep decoding, so the canonical JSON form and the cursor envelope are
  not free to change.
- **Licenses.** Shipped dependencies must be MIT / Apache-2.0 (or equivalently
  permissive). Retain Circle MIT notices. Do not copy another product's schema,
  brand, or marks. Do not use "Linear" as Berry product branding or in new code
  identifiers. Existing Circle comments that say "Linear-style" are legacy — do
  not spread that into new APIs.
- **TypeScript `strict` stays on. No `any`.** Narrow instead of `!`. The only
  `any` exemption is vendored `frontend/components/data-table-filter/**`.

## Current implementation (do not invent the missing layer)

**The server is incomplete on purpose.** It serves identity, workspaces,
boards, issues, comments, dependencies, reviews, goals, projects,
attachments-by-id, agents and the realtime streams. It does **not** serve
`/runtime`. Everything the frontend calls is served. Read
[`server-ts/SCOPE.md`](server-ts/SCOPE.md) before assuming a prefix is missing
by accident.

**Runs are dispatched in process.** `POST /api/v1/issues/{ref}/runs` writes a
queued run; `runs/dispatcher.ts` claims it with `SKIP LOCKED`, holds a lease it
renews, executes it, and sweeps runs whose lease expired. There is no external
worker and no `/internal/` surface.

**GitHub is an App Berry creates, not a credential it is given.** The manifest
flow posts what the App may do, and the conversion returns the id, both halves
of the OAuth credential, the private key and the webhook secret at once — which
is also what registers the callback URLs, so a `redirect_uri` mismatch is not a
failure mode. Repository work runs on installation tokens minted per run
(`src/integrations/github-app.ts`); the older user-token connection remains only
as a fallback for a deployment with no App, and is never preferred when one
exists.

**`GET /api/v1/config` is how the browser learns what works.** It reports only
capabilities this process actually has. A capability reported true that the
server cannot deliver is worse than one reported false.

**Frontend is wired to the API** through `lib/api.ts` (`apiUrl` / `apiFetch`).
Do not reintroduce demo/mock datasets. `NEXT_PUBLIC_BERRY_API_URL` empty means
same-origin through the Next.js rewrites, which is the normal case.

**Removed, do not re-add:** the Crew/team module. Crew was a board with a
client-side roster that never persisted; boards are the issue container and
routing is the orchestrator's job. `teamIds` on User and `teamId` on
Project/Cycle/View survive as unread vestiges pending a type cleanup.

**Descriptions are plain-text fields.** A rich editor round-tripped markdown
through parse/serialize, which rewrote untouched content — bullet markers,
blank lines, and `web_search` escaped to `web\_search` — including agent
system prompts. `DescriptionTextarea` saves the exact bytes it was given.

Schema notes that can bite you:

- Allocate `issues.number` via atomic `boards.issue_counter` in the same
  transaction — never `MAX(number)+1`.
- `assignee_type` / `assignee_id` are both-or-neither.
- Validate `boards.columns` with Zod on every write (DB only checks JSON array).
- Same-issue comment threading is not DB-enforced; validate on the write path.
- Storage names are not API field names (`camelCase` over the wire).

Do not port a legacy feature that Berry has replaced or excluded; the product
brief records the approved web direction.

## Commands

```bash
# Local stack (from repo root)
cp .env.example .env && docker compose up -d --build

# Repository checks
python3 scripts/check-compose-config.py

# Server
pnpm typecheck:server
pnpm test:server
pnpm migrate:server         # needs DATABASE_URL
pnpm seed:server            # development dataset; idempotent
pnpm dev:server

# Frontend
cd frontend && pnpm lint && pnpm build
```

`pnpm build` in `frontend/` and `next dev` share `.next/`, so a build while the
dev server runs corrupts its manifests. Use `pnpm build:check`, which writes to
`.next-verify` instead.

Database-backed server tests self-skip when `BERRY_TEST_DATABASE_URL` is unset,
so a fresh `pnpm test:server` stays green offline. Keep it that way.

## Commits, branches, review

```
type(scope): imperative summary (BERR-NN)
```

- Scopes: `server-ts`, `frontend`, or omit for docs-only.
- Agent runtime branches: stay on `agent/<name>/<hash>`. Hand-authored:
  `fix/berr-NN-short-slug`. One issue per branch and PR.
- Reviewers: **Sentinel** (frontend), **Backend PR Adversary** (backend).
  Zero blocking findings is merge authority; re-review the full PR after
  fixes. On a clean review, merge and move the issue to **done**.

Definition of done: server typecheck and tests; frontend lint + build and a
manual check of the changed view. No secrets or `.env` files.

## Domain reminders

- Assignees are polymorphic: `user | agent`.
- Issue statuses: `backlog → todo → in_progress → in_review → done`
  (`blocked` and `cancelled` also exist; `blocked` was added in migration 008).
  The release gate is always human.
- Public API: `/api/v1`, cursor pagination, `Idempotency-Key` on creating
  POSTs, stable `SCREAMING_SNAKE_CASE` error codes.
- Env booleans: do not use `z.coerce.boolean()` (`"false"` becomes `true`).
  Follow the `boolean` helper in `server-ts/src/config/config.ts`.
- Frontend issue prefixes are the first three characters of the workspace name
  (stored as `settings.issuePrefix`); tracker issues are `BERR-NN`.
  Do not conflate them.
- Prefer semantic design tokens over raw palette utilities. Proposed
  status/actor aliases in the design-system doc are not implemented yet.
- Native inputs need `--foreground` and `-webkit-text-fill-color`. Fading
  placeholders with low-opacity `muted-foreground` reads as black on void.
