# Cache layer (BERR-25)

Cache-aside over Valkey for the gateway's hot reads, per
[ADR-0002](../../../../docs/adr/0002-valkey-for-ephemeral-state.md). Valkey is a
**disposable performance cache** — never a system of record. Every operation
fails open: a Valkey error, timeout, or malformed value is logged and treated as
a miss, so callers always fall through to the authoritative Postgres/OpenFang
loader. A clean, freshly-flushed Valkey requires no restore; the gateway
reconstructs entries from source on demand.

## Layout

| File | Responsibility |
|------|----------------|
| `config.ts` | Env-driven config: enable switch, Valkey URL, key prefix, schema version, per-family TTLs, op timeout. |
| `keys.ts` | Logical key builders + invalidation prefixes + parameter fingerprint. The key registry (below). |
| `store.ts` | `CacheStore` contract, `ValkeyStore` (Bun native client), `NullStore` (disabled/no-op). |
| `cache.ts` | The `Cache` class: cache-aside `getOrLoad`, `get`/`set`, invalidation, single-flight, serialization, stats. |
| `index.ts` | Wired singleton + domain helpers (`cacheBoard`, `cacheIssueList`, …) and invalidation hooks. |

## Using it

Read paths wrap their loader; write paths call the matching invalidation hook
after a successful commit:

```ts
import { cacheBoard, cacheIssueList, invalidateBoard, invalidateIssuesForBoard } from "~/cache";

// read (cache-aside)
const board = await cacheBoard(boardId, () => db.loadBoard(boardId));
const page = await cacheIssueList(boardId, { first, after, status }, () =>
  db.listIssues(boardId, { first, after, status }),
);

// write → invalidate after the DB commit succeeds
await db.updateBoard(boardId, patch);
await invalidateBoard(boardId);

await db.createIssue(boardId, input);
await invalidateIssuesForBoard(boardId);
```

The lower-level `cache` instance (`cache.getOrLoad` / `get` / `set` /
`invalidate` / `invalidateByPrefix` / `getStats`) is exported for any read that
does not fit a domain helper.

## Key registry (ADR-0002)

Every key is namespaced and versioned. The effective Valkey key is
`<CACHE_KEY_PREFIX>:cache:v<CACHE_SCHEMA_VERSION>:<logical key>`, e.g.
`berry:cache:v1:issues:list:<boardId>:<fp>`. Bumping `CACHE_SCHEMA_VERSION`
atomically abandons the old keyspace (old keys are never read again and expire).

| Namespace | Logical key | Owner | TTL env (default) | Invalidated on |
|-----------|-------------|-------|-------------------|----------------|
| `board` | `board:<boardId>` | boards read path (BERR-23) | `CACHE_TTL_BOARD_SECONDS` (60s) | board update → `invalidateBoard` |
| `boards:list` | `boards:list:<fp>` | boards read path (BERR-23) | `CACHE_TTL_BOARDS_LIST_SECONDS` (30s) | any board create/update → `invalidateBoard` / `invalidateBoardsList` |
| `issue` | `issue:<issueId>` | issues read path (BERR-23) | `CACHE_TTL_ISSUE_SECONDS` (30s) | issue update → `invalidateIssue` |
| `issues:list` | `issues:list:<boardId>:<fp>` | issues read path (BERR-23) | `CACHE_TTL_ISSUE_LIST_SECONDS` (15s) | any issue create/update on the board → `invalidateIssue` / `invalidateIssuesForBoard` |

`<fp>` is a 128-bit SHA-256 fingerprint of the request's query parameters
(order-independent; absent and null filters collapse to the same page). SHA-256
rather than a fast lossy hash so two different filter sets can never collide onto
one cached page. `boardId` is kept in the clear in `issues:list` keys so a single
board's pages can be dropped with one prefix scan.

**Tenant boundary.** Boards are the product's top-level tenant/authorization
boundary; issue-list keys are board-scoped. When a broader workspace/tenant
dimension is introduced, add it to `CACHE_KEY_PREFIX` or the key head so tenants
never share cache entries.

## Configuration

All optional; every value has a working default (see `config.ts` and
`.env.example`).

| Env | Default | Meaning |
|-----|---------|---------|
| `CACHE_ENABLED` | `true` | Master switch. `false` → behaves as a permanent cache outage (all miss / all no-op). |
| `VALKEY_URL` | `redis://127.0.0.1:6379` | Valkey connection (Redis wire protocol). |
| `CACHE_KEY_PREFIX` | `berry` | Namespace root. |
| `CACHE_SCHEMA_VERSION` | `1` | Version tag in every key/envelope; bump to invalidate everything. |
| `CACHE_OP_TIMEOUT_MS` | `250` | Per-op timeout; a slower op is abandoned as a miss. |
| `CACHE_TTL_DEFAULT_SECONDS` | `30` | Fallback TTL. |
| `CACHE_TTL_BOARD_SECONDS` | `60` | Single board. |
| `CACHE_TTL_BOARDS_LIST_SECONDS` | `30` | Boards list pages. |
| `CACHE_TTL_ISSUE_SECONDS` | `30` | Single issue. |
| `CACHE_TTL_ISSUE_LIST_SECONDS` | `15` | Issue-list pages (shortest — most write-churned). |

## Failure & correctness model

- **Fail-open.** Read/write/invalidate errors are swallowed and counted in
  `cache.getStats()`; the loader result is authoritative.
- **Fail-fast backend.** `ValkeyStore` disables the offline queue and bounds
  every command with `CACHE_OP_TIMEOUT_MS`, so a down/slow Valkey never stalls a
  request; background auto-reconnect heals the store.
- **Stale within TTL.** Reads may be up to their TTL stale. Anything
  correctness- or security-sensitive (authorization, run status, audit) MUST read
  the authoritative record, per ADR-0002 — do not cache it here.
- **Single-flight.** `getOrLoad` coalesces concurrent identical cold loads in a
  process, so a hot cold-key does not stampede the database.

## Tests

`bun test src/cache` covers hit, miss, TTL expiry, exact + prefix invalidation,
malformed values, wrong-version envelopes, Valkey-unavailable (fail-open),
single-flight, disabled mode, and schema-version rollover. `store.test.ts` runs
live round-trip/TTL/scan tests against Valkey when one is reachable at
`VALKEY_URL` and skips them (with a logged note) otherwise.
