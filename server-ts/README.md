# Berry product server

Berry's server, in TypeScript ([ADR-0009](../docs/adr/0009-typescript-product-server.md)).

It was grown by strangling the previous implementation rather than replacing it
in one step, and that history still shapes the code: the wire shape is a contract, and
assertions here are pinned against captured responses rather than transcribed
from source, because the point is what goes on the wire.

## What that means for code here

**The wire shape does not change.** `/api/v1`, the error envelope, cursor
pagination, `Idempotency-Key`, opaque session tokens and `berry_pat_` personal
access tokens keep their exact shapes. Anything a browser can observe is
already a contract — and cursors and idempotency fingerprints that clients and
the database already hold have to keep decoding.

**This server owns the schema.** `migrations/` is forward-only and immutable,
applied by `src/migrate` under an advisory lock with a SHA-256 per file
recorded in `berry_schema_migrations`. Never edit an applied migration; add a
new one.

**It is not finished.** `SCOPE.md` lists what was deliberately left out.
`ROUTING.md` records what was verified and how, and the gaps that remain.

## Running

```
pnpm typecheck:server
pnpm test:server
pnpm dev:server
```

The server runs its `.ts` sources directly under `--experimental-strip-types`,
so there is no build step and nothing that emits code — enums, namespaces,
parameter properties — is allowed. `erasableSyntaxOnly` enforces that.

## Migrations and seed

```
export DATABASE_URL=postgres://berry:berry@127.0.0.1:5432/berry?sslmode=disable

pnpm migrate:server   # forward-only, idempotent, exits non-zero on drift
pnpm seed:server      # local development dataset, idempotent
```

Compose runs both before starting the server, so a clean volume comes up
migrated and with something to log into.

## Database-backed tests

Gated on `BERRY_TEST_DATABASE_URL` — without it they skip, so the default suite
stays offline.

```
createdb berry_ts_test
docker compose exec -T postgres pg_dump -U berry -d berry --schema-only \
  --no-owner --no-privileges | psql berry_ts_test
BERRY_TEST_DATABASE_URL=postgres://berry:berry@127.0.0.1:5432/berry_ts_test pnpm test:server
```

Note that a host PostgreSQL on 5432 shadows the container's published port, so
`127.0.0.1:5432` may not be the database the stack is using. Check before
pointing anything real at it. `ROUTING.md` has a socat bridge for the case
where it is not.
