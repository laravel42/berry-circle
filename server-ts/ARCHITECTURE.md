# Server architecture (`server-ts`)

A map of how the Berry product server is put together, for someone reading it
for the first time. For *what the server does not serve*, see
[`SCOPE.md`](./SCOPE.md); for the public HTTP/SSE contract, see
[`../docs/api/gateway-v1.md`](../docs/api/gateway-v1.md).

## The shape in one paragraph

The server runs its TypeScript sources directly under
`node --experimental-strip-types` — **there is no build step**. A request enters
through a *mount* (one file per `/api/v1` route group), which parses and
validates the request, checks authorization, and calls a *repository* that owns
the SQL for one domain. Repositories talk to Postgres through a single `Sql`
handle. One file, `src/index.ts`, is the **composition root**: the only place
that constructs every repository and wires it into its mount. Nothing else
imports "the whole app," which is why a feature can be added or removed by
touching one mount and one line of the root.

```
HTTP request
   │
   ▼
src/index.ts ── constructs everything once (the composition root)
   │
   ▼
src/http/registry.ts ── refuses overlapping route prefixes, mounts each subtree
   │
   ▼
src/mounts/<feature>.ts ── parse · validate · authorize · serialize   (HTTP entry)
   │
   ▼
src/<domain>/<name>.ts  (a Repository) ── the SQL and rules for one domain  (domain)
   │
   ▼
src/db/pool.ts ── the postgres.js connection and transaction helper       (infra)
```

## The four layers

Every folder under `src/` belongs to one of these. Knowing the layer tells you
what a folder is allowed to do.

- **HTTP entry** — turns a request into a domain call and a domain result into
  the wire response. Never touches SQL directly.
- **Domain** — the product's rules and its SQL, one repository per domain.
  Knows nothing about HTTP.
- **Infrastructure** — cross-cutting plumbing every layer leans on (the HTTP
  framework glue, the database pool, config, logging, realtime fan-out).
- **External integration** — everything that talks to a system outside Berry
  (a model provider, GitHub, object storage, the execution sandbox).
- **Dev-script** — run by an operator or CI, not by a request (migrate, seed,
  reset).

## Folder responsibilities

| Folder | Responsibility | Layer |
| --- | --- | --- |
| `mounts/` | One file per `/api/v1` route group: parse, validate, authorize, then call a repository and serialize the result. | HTTP entry |
| `http/` | The framework glue every mount shares: the app shell, the mount `registry`, the error envelope, cursor pagination, idempotency, canonical-JSON, body reading. | infrastructure (HTTP) |
| `db/` | `pool.ts`: the postgres.js connection, the `Queryable`/`withinTx` transaction helper, UTC-pinned RFC3339 timestamps. | infrastructure |
| `config/` | `loadConfig()` — the environment parsed into one typed `Config` (note the `boolean` helper; do not use `z.coerce.boolean`). | infrastructure |
| `observability/` | The structured JSON logger and process metrics. | infrastructure |
| `realtime/` | Event fan-out: the in-process `hub`, the `distributed` relay (null for now), and `replay` from the Postgres outbox. | infrastructure |
| `identity/` | Users, workspaces, memberships, invitations; the `roles` permission matrix; `ScopedDb`/`WorkspaceContext`; the shared `NotFound`/`Forbidden`/`Conflict` errors. | domain (authorization) |
| `auth/` | Sessions, password hashing, personal-access tokens, and the `requireSession` middleware. | domain (security) |
| `core/` | The tracker itself: the `boards`, `issues`, `comments`, `dependencies`, `reviews`, `goals`, `projects`, `attachments` repositories. | domain |
| `agents/` | The agent registry and its model runtime: the `repository`, the model `catalog`, the Bedrock chat/executor, tool and checkout plumbing. | domain + integration |
| `runs/` | The run ledger: `repository`, `ledger`, and the `dispatcher` that claims a queued run (`SKIP LOCKED`) and holds a lease. | domain |
| `plans/` | The planner: `repository`, `generator`, `triage` (routing), `answers`. | domain + integration |
| `conversations/` | Conversation threads and their model-backed `responder`. | domain + integration |
| `approvals/` | The approval-gate records. | domain |
| `inbox/` | Per-user inbox notifications. | domain |
| `editor/` | Model-backed editor assistance. | integration |
| `integrations/` | Sealed provider credentials — connections, the GitHub App, OAuth, sealing. **The only place a provider secret is decrypted.** | external integration (security) |
| `scm/` | Source control: the provider interface, the GitHub providers, provisioning, sync, and inbound webhooks. | external integration |
| `agentcore/` | The AWS Bedrock AgentCore gateway client and its boot-time tool discovery. | external integration |
| `execution/` | Where an agent's commands run: the driver interface and the Docker/AgentCore drivers. | external integration |
| `storage/` | The S3/MinIO object-storage client for agent artifacts. | external integration |
| `migrate/` | The forward-only migration runner (advisory lock, SHA-256 per file). | dev-script |
| `seed/` | The idempotent development dataset. | dev-script |
| `reset/` | The development/test database reset. | dev-script |

## Following one request: `PATCH /api/v1/issues/{ref}`

1. **`src/index.ts`** has already constructed `new IssueRepository(sql)` and
   passed it into `issueMounts({ issues, boards, ... })`, registered on the
   `Registry`.
2. **`src/http/registry.ts`** mounted that subtree at `/api/v1/issues`, having
   refused at startup any prefix that could overlap another.
3. **`src/mounts/issues.ts`** runs `requireSession`, reads the bounded body,
   resolves the issue by reference, calls `issues.authorize(user, id,
   'product.write')`, validates the patch into `FieldError[]`, then calls
   `issues.update(...)`, publishes the resulting events, and serializes the
   response. Domain errors are translated to the wire envelope here.
4. **`src/core/issues.ts`** — `IssueRepository.update` opens a transaction,
   locks the row `FOR UPDATE`, checks the status transition is legal, writes
   the `UPDATE`, and records outbox events **in the same transaction**.
5. **`src/db/pool.ts`** — the `Sql` handle runs it; the broadcaster publishes
   the already-durable outbox events after the transaction commits (best
   effort — a failed publish costs a live update, never the write).

The layering is the same for every feature: **mount → repository → db**, with
`http/`, `auth/`, and `identity/errors.ts` as the cross-cutting support the
mounts lean on.

## Conventions worth knowing before you edit

- **No build step.** Imports are relative with explicit `.ts` extensions
  (`import { x } from '../core/issues.ts'`). There are **no path aliases and no
  barrel `index.ts` re-exports** on the server — they would need a bundler that
  does not exist here. The only `index.ts` files are the entrypoints
  (`src/index.ts`, `migrate/`, `seed/`, `reset/`).
- **`erasableSyntaxOnly`.** No `enum`, no `namespace`, no TypeScript
  parameter-properties — nothing that emits code. Use `const` maps and union
  types (see `STATUS_TO_DB` in `mounts/issues.ts`).
- **One class per file, named for its role** (`repository.ts`, `ledger.ts`,
  `dispatcher.ts`), with its test co-located as `*.test.ts`.
- **Raw SQL, no ORM.** Repositories use postgres.js tagged templates with
  deliberate concurrency semantics (`FOR UPDATE`, `SKIP LOCKED`, the
  `berry_next_issue_number` function). Timestamps stay strings for wire
  fidelity.
- **The `/api/v1` wire shape is a contract.** The error envelope, cursor
  pagination, `Idempotency-Key`, token shapes and serialized field order must
  keep decoding for clients that already hold them.
- **The composition root wires by hand.** `src/index.ts` constructs everything;
  there is no DI container (decorators/reflection collide with
  `erasableSyntaxOnly` and the no-build rule).
