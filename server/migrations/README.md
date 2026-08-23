# Migration ranges

Migrations are forward-only, embedded into `cmd/migrate`, and applied in one
transaction each while a PostgreSQL advisory lock is held. Never edit an
applied migration; add a new one.

- `000-099`: platform, Berry core compatibility, and run-ledger foundation
- `100-199`: identity, workspaces, teams, and authorization
- `200-299`: projects, initiatives, cycles, and issue extensions
- `300-399`: integrations and workflow definitions
- `400-499`: review, audit, and artifact surfaces
- `500-899`: reserved for later product phases
- `900-999`: operational repair migrations and future squashes

Names use `NNN_description.up.sql`. Down migrations are intentionally not
supported. The migration ledger stores a SHA-256 checksum and the runner
refuses missing files, renamed files, or checksum drift.
