# Database

Berry-owned product state lives in PostgreSQL. Agent execution state (runs, tool calls, costs, audit trail) lives in OpenFang — these tables hold only what Berry owns.

## Tables

| Table | Purpose |
| --- | --- |
| `users` | Human members of the workspace |
| `sessions` | Login sessions (token hash, expiry) |
| `boards` | Issue boards (Linear-shaped columns config) |
| `issues` | Issues: status, priority, current assignee (human or agent), OpenFang run link |
| `assignments` | Assignment history per issue |
| `comments` | Issue comments, authored by users or agents |

## Migrations

Schema is defined in `src/db/schema.ts` (drizzle-orm). SQL migrations are generated with drizzle-kit into `drizzle/` and applied at deploy time by `src/db/migrate.ts`.

```bash
bun install
bun run db:generate   # generate a new migration after editing schema.ts
bun run db:migrate    # apply pending migrations (uses DATABASE_URL)
```

`DATABASE_URL` defaults to `postgres://berry:berry@localhost:5432/berry`.

## Status of this schema

Modeled from the M0 domain plan before the BERR-11 API contract lands — expect a refinement migration once the contract is signed off.
