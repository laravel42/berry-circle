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

## Proving a port

There is no OpenAPI document, so the check is empirical: ask both servers the
same question and compare what comes back, key order included.

```
# with the Go server on :4000 and this one on :4100
pnpm contract:server /health /ready /api/v1/config
```

It reports one of three verdicts per path. `identical` means byte-for-byte.
`same shape, different data` means the contract matches and only values differ
— a request id, a timestamp, a capability this process does not yet provide.
`CONTRACT DIFFERS` means the shape itself differs, which is a bug unless the
mount is knowingly half-ported.

Capture the Go side before moving a mount, and run it again after.

## Database-backed tests

Gated the way Go gates its own — without the variable they skip, so the default
suite stays offline.

```
createdb berry_ts_test
docker compose exec -T postgres pg_dump -U berry -d berry --schema-only \
  --no-owner --no-privileges | psql berry_ts_test
BERRY_TEST_DATABASE_URL=postgres://berry:berry@127.0.0.1:5432/berry_ts_test pnpm test:server
```

Note that a host PostgreSQL on 5432 shadows the container's published port, so
`127.0.0.1:5432` may not be the database the Go server is using. Check before
pointing anything real at it.
