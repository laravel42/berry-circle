# Berry product server (TypeScript)

Berry's server, being reimplemented in TypeScript ([ADR-0009](../docs/adr/0009-typescript-product-server.md)).

It is grown by strangling the Go server at `../server`, not by replacing it in
one step. `frontend/next.config.ts` proxies `/api/:path*` to a configurable
origin and the Go router enforces disjoint prefix mounts, so prefixes move here
one at a time while both servers run against the same database and the same
migrations. Berry stays usable throughout.

## What that means for code here

**The Go server is the specification.** There is no OpenAPI document — the
contract in `docs/api/gateway-v1.md` covers about half the surface in prose and
disclaims the rest. So a port starts by reading the Go implementation and its
tests, and finishes by comparing responses against the running Go server.

**The wire shape does not change.** `/api/v1`, the error envelope, cursor
pagination, `Idempotency-Key`, opaque session tokens and `berry_pat_` personal
access tokens keep their exact shapes. Anything a browser can observe is
already a contract. Assertions here are pinned against captured Go responses
rather than transcribed from Go source, because the point is what goes on the
wire, not what the source says should.

**Migrations belong to `../server/migrations`.** Same files, same
`berry_schema_migrations` table, same checksums and advisory lock. One schema,
two servers.

## Running

```
pnpm typecheck:server
pnpm test:server
```
