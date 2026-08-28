# ADR-0002: Use Valkey for cache and ephemeral coordination state

- **Status:** Accepted
- **Date:** 2026-08-22
- **Deciders:** Berry architecture team
- **Related:** [Product brief](../product-brief.md),
  ADR-0001 (withdrawn)

> **Amended 2026-08-28.** The decision stands — PostgreSQL is the system of
> record and anything ephemeral belongs elsewhere — but Valkey is not in the
> Compose stack. The relay is implemented (`server-ts/src/realtime/relay.ts`)
> and the broadcaster is constructed with it set to null, so events replay from
> `outbox_events` and reach other processes on the next poll rather than
> instantly. `capabilities.valkey` reports false.

## Context

The gateway will repeatedly read upstream and product data, fan out live state,
and coordinate work across more than one process. Keeping every transient value
in a process-local map prevents safe horizontal scaling, while putting
short-lived coordination data into PostgreSQL creates avoidable database load.

Berry also has durable product facts—issues, comments, workflow state, review
decisions, and its run ledger—that must survive cache loss. A cache outage or
eviction must never change those facts.

## Decision drivers

- Shared, low-latency access from multiple gateway instances.
- Explicit expiry for values that become stale quickly.
- Atomic primitives for bounded coordination use cases.
- A permissively licensed, self-hostable component.
- Clear separation between disposable state and durable product records.

## Considered options

1. Valkey for shared cache and ephemeral coordination, with PostgreSQL as the
   durable system of record.
2. PostgreSQL for both durable and transient state.
3. Per-process in-memory caches.

## Decision

Use Valkey for shared cache entries and ephemeral coordination state. Every key
must have a documented owner, namespace, serialization version, and expiry or
an explicit justification for having none. Cache keys must include the Berry
workspace or equivalent tenant boundary where applicable.

PostgreSQL remains authoritative for Berry-owned product and run data. Valkey
must not be the only store for issues, comments, assignments, permissions,
review decisions, audit evidence, run status, run events, or usage/cost
records. Cached authorization data must be invalidated on writes and retain a
short TTL; security-sensitive operations must be able to read the authoritative
record.

The application must tolerate cache misses, eviction, and temporary Valkey
unavailability. Coordination primitives may prevent concurrent duplicate work,
but they are not an end-to-end idempotency guarantee for upstream execution.

## Consequences

### Positive

- Gateway instances share hot data and coordination state.
- TTLs bound staleness and storage growth.
- PostgreSQL is protected from avoidable high-frequency transient reads and
  writes.
- Losing or flushing Valkey does not destroy durable product state.

### Negative

- Deployment and local development gain another stateful service.
- Invalidation and serialization versioning add application complexity.
- Reads may be stale within their documented TTL.

### Risks and mitigations

- **Risk:** Code accidentally treats a cached value as authoritative.
  **Mitigation:** Keep cache access behind typed modules that expose fallback and
  invalidation behavior; test cold-cache paths.
- **Risk:** Stale permissions allow an invalid action. **Mitigation:** Invalidate
  on writes, use short TTLs, and verify authoritative state for sensitive
  operations.
- **Risk:** A lock expires while work continues. **Mitigation:** Use ownership
  tokens and compare-before-release; design durable operations to remain safe if
  coordination is lost.
- **Risk:** Valkey is unavailable. **Mitigation:** Fail open only for optional
  performance caches; fail closed or use PostgreSQL for correctness-sensitive
  coordination.

## Validation

- Tests cover cache hit, cache miss, expiry, invalidation, malformed values, and
  Valkey unavailability.
- A clean Valkey instance can be introduced without data restoration and Berry
  reconstructs cache entries from authoritative sources.
- Repository review finds no durable product category stored only in Valkey.

## Follow-up

- Define key namespaces, TTLs, invalidation triggers, and outage behavior in the
  implementation specification for each cache-backed feature.
