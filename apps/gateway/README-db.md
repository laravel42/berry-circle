# Database

Berry-owned product state lives in PostgreSQL. Agent execution state (runs, tool calls, costs, audit trail) lives in OpenFang — these tables hold only what Berry owns.

## Tables

| Table | Purpose |
| --- | --- |
| `users` | Human members of the workspace (email uniqueness is case-insensitive; `role` is `admin`/`member`) |
| `sessions` | Login sessions (SHA-256 token hash, expiry) — see gateway auth (BERR-24) |
| `boards` | Issue boards (Linear-shaped columns config, per-board issue number counter) |
| `issues` | Issues: status, priority, current assignee (human or agent), OpenFang run link |
| `assignments` | Assignment history per issue |
| `comments` | Issue comments, authored by users or agents (threaded via self-referencing `parent_id`) |

## Integrity guarantees

- `issues.number` is allocated server-side via `boards.issue_counter` (`UPDATE boards SET issue_counter = issue_counter + 1 WHERE id = $1 RETURNING issue_counter`, in the same transaction as the issue insert) — never `MAX(number)+1`, which races under concurrent creation.
- `comments.parent_id` is a self-referencing FK (`ON DELETE CASCADE`); dangling parents are rejected at the DB and deleting a comment cascades to its replies. (Same-issue threading — parent and reply sharing an `issue_id` — is not DB-enforced; validate it on the write path.)
- `updated_at` on `users`/`boards`/`issues`/`comments` is maintained by a `BEFORE UPDATE` trigger (`set_updated_at()`), not just `defaultNow()` at insert time.
- `issues.assignee_type`/`assignee_id` are enforced both-or-neither via a CHECK constraint.
- `users.email` uniqueness is case-insensitive (`lower(email)`).
- `boards.columns` is CHECKed to be a JSON array at the DB level; validate with Zod on the write path too.

## Migrations

Schema is defined in `src/db/schema.ts` (drizzle-orm). SQL migrations are generated with drizzle-kit into `drizzle/` and applied at deploy time by `src/db/migrate.ts`.

```bash
bun install
bun run db:generate   # generate a new migration after editing schema.ts
bun run db:migrate    # apply pending migrations (uses DATABASE_URL)
```

`DATABASE_URL` is required — copy `.env.example` to `.env` and adjust. Both `db:generate` and `db:migrate` fail fast with a clear error if it's unset, rather than silently attempting a connection to a placeholder DSN.

## Status of this schema

Modeled from the M0 domain plan before the BERR-11 API contract lands — expect a refinement migration once the contract is signed off.
