# ADR-0004: Adopt a Go product server

- **Status:** Superseded by [ADR-0009](0009-typescript-product-server.md)
- **Date:** 2026-08-22
- **Deciders:** Berry architecture team
- **Related:** [Product brief](../product-brief.md),
  [Multica reuse provenance](../provenance/multica-server-reuse.md),
  [web parity matrix](../parity/multica-web.md),
  [gateway API contract](../api/gateway-v1.md),
  [OpenFang integration specification](../integrations/berry-openfang.md),
  [ADR-0001](0001-bun-hono-gateway.md),
  [ADR-0002](0002-valkey-for-ephemeral-state.md)
- **Supersedes:** [ADR-0001](0001-bun-hono-gateway.md)

## Context

Berry's approved direction now covers phased parity with the pinned Multica web
product, including multi-workspace collaboration, issue and project workflows,
agent product surfaces, realtime updates, integrations, and optional hosted
modules. The initial Bun/Hono gateway was selected for a much narrower
single-workspace Release 1 and has already established useful public-contract,
database, error, observability, and OpenFang adapter behavior.

The Multica owner has authorized reuse and relicensing of relevant first-party
server material, with the limits recorded in the
[provenance record](../provenance/multica-server-reuse.md). Its Go
product/control-plane implementation demonstrates patterns for the expanded
surface, but it also contains daemon, local execution, provider, desktop,
mobile, and hosted concerns that Berry must not inherit.

Berry therefore needs a server architecture that can absorb the approved
product patterns without changing its public API or crossing the OpenFang
execution boundary.

## Decision drivers

- Deliver the complete classified web surface in
  [phases](../parity/multica-web.md) without importing excluded runtimes or
  clients.
- Keep PostgreSQL authoritative for durable product state and Valkey limited to
  cache and ephemeral coordination.
- Preserve one stable browser-facing Berry contract while the implementation is
  replaced.
- Support HTTP, WebSocket, and incremental SSE behavior with explicit
  authorization and backpressure.
- Reuse only owner-authorized, provenance-audited Go product/control-plane
  material.
- Keep self-hosted deployments complete without requiring Berry-hosted
  services.

## Considered options

1. Build a Go product server with Chi, pgx/sqlc, PostgreSQL, and Valkey, adapting
   only approved product/control-plane material.
2. Continue expanding the Bun/Hono gateway into the full product server.
3. Port the complete legacy server, daemon, and execution stack.

## Decision

Berry will build its product/control-plane server as an independent Go module
under `server/`.

- HTTP routing and middleware use Chi.
- PostgreSQL access uses pgx and sqlc; PostgreSQL remains the system of record
  for Berry-owned product state and the run ledger.
- Valkey remains a disposable cache and ephemeral coordination layer under
  [ADR-0002](0002-valkey-for-ephemeral-state.md).
- Browser realtime delivery may use WebSocket for subscribed product updates
  and SSE for ordered run/event streams. Durable facts are persisted before
  they are projected to either transport.

The implementation change does not change Berry's public contract. The Go
server keeps:

- the `/api/v1` base path;
- the central `{ "error": { "code", "message", ... } }` envelope and stable
  `SCREAMING_SNAKE_CASE` error codes;
- opaque cursor pagination;
- `Idempotency-Key` behavior for creating or dispatching `POST` requests;
- Berry session authentication and authorization; and
- `camelCase` JSON fields.

The existing [gateway v1 contract](../api/gateway-v1.md) remains normative and
will be extended deliberately for parity. Storage and generated sqlc names do
not become wire names.

Browsers call Berry only. They never call OpenFang directly and never receive
`OPENFANG_API_KEY`. OpenFang remains the sole substrate for agent execution,
sandboxing, scheduling, model/provider access, and execution-side tools. Berry
owns product state, authorization, collaboration, review gates, the
issue-correlated run ledger, and the browser projections of OpenFang activity.

Berry will **not** port Multica's daemon, daemon WebSocket protocol, local
launchers, provider adapters, agent execution loop, or filesystem execution.
Web runtime and execution-log experiences are reimplemented as Berry product
views over the Berry run ledger and the pinned OpenFang adapter.

Full web parity is delivered in the phases and classifications defined by the
[parity matrix](../parity/multica-web.md). Hosted billing, subscriptions, cloud
runtime fleet, and similar deployment services are optional modules. They are
disabled by default in self-hosted builds and fail closed when their explicit
configuration or entitlement is absent; core self-hosted flows must not call
them implicitly.

During migration, `apps/gateway` is a compatibility oracle for public DTOs,
status codes, error mapping, idempotency, auth behavior, and OpenFang edge
cases. New Go contract tests must run the same fixtures against both
implementations where practical. The Bun gateway must not become a second
authoritative writer. After the Go server satisfies the required matrix and
cutover checks, `apps/gateway` is removed.

## Consequences

### Positive

- The expanded product surface has one server architecture and one durable
  ownership model.
- Approved Go patterns can be adapted with path-level provenance instead of
  rebuilding every control-plane concern from scratch.
- The browser contract and OpenFang boundary survive the implementation
  migration.
- Optional hosted services cannot silently become self-hosted dependencies.
- The Bun implementation provides executable compatibility evidence during
  cutover.

### Negative

- Berry temporarily carries two server implementations and two backend
  toolchains.
- Contract fixtures and database behavior must be reconciled across
  TypeScript/Drizzle and Go/sqlc during migration.
- The broader parity scope requires multiple phases before the Bun gateway can
  be deleted.
- Adapted source and every new Go dependency require provenance and license
  review.

### Risks and mitigations

- **Risk:** Legacy execution code crosses into Berry. **Mitigation:** Treat the
  parity classifications and provenance exclusions as merge gates; route all
  execution through the OpenFang adapter.
- **Risk:** Public behavior drifts during the rewrite. **Mitigation:** Keep
  `/api/v1` normative and run shared compatibility fixtures against Bun and Go.
- **Risk:** Dual writes diverge. **Mitigation:** Use one authoritative writer
  per environment and perform an explicit cutover; never active-active the two
  implementations.
- **Risk:** Optional hosted modules leak into self-hosted boot or core flows.
  **Mitigation:** Require explicit enablement, fail closed, and test with every
  hosted credential absent.
- **Risk:** Imported code carries incompatible third-party material.
  **Mitigation:** Require the path-level audit in the provenance record before
  merge.

## Validation

- `server/` is a self-contained Go module whose scaffold defines formatting,
  static-analysis, generation, and test gates.
- Shared contract tests prove the Go server preserves `/api/v1`, error,
  cursor, idempotency, auth, and `camelCase` behavior.
- Integration tests prove WebSocket/SSE disconnect, ordering, replay, and
  backpressure behavior without duplicate OpenFang dispatch.
- Repository review finds no daemon protocol, local launcher, provider adapter,
  sandbox, or filesystem execution implementation in `server/`.
- A self-hosted test environment boots and completes every required-core flow
  with hosted/cloud modules disabled and their credentials absent.
- Every completed parity row links API, UI, and test evidence in the matrix.
- Go server cutover and Bun removal occur only after the compatibility and
  migration evidence is reviewed.

## Follow-up

- Land the `server/` scaffold and its exact commands before enforcing Go gates.
- Extend the Berry API contract by parity phase rather than exposing legacy
  wire shapes.
- Add shared Bun/Go compatibility fixtures and a one-writer cutover plan.
- Record every Multica-derived implementation path in the provenance ledger.
