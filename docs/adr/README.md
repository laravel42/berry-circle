# Architecture Decision Records

This directory records consequential technical decisions for Berry. An ADR
captures the context and trade-offs known when a decision is made; it is not a
substitute for an API or integration contract.

## Status vocabulary

- **Proposed** — under discussion and not yet binding.
- **Accepted** — the current direction; implementations and contracts should
  conform.
- **Deprecated** — retained for history but no longer recommended.
- **Superseded** — replaced by another ADR, which must be linked from both
  records.

Accepted ADRs are immutable apart from typo and link fixes. When a decision
changes materially, add a new ADR and mark the old one **Superseded**.

## Decision log

| ADR | Decision | Status | Date |
|---|---|---|---|
| [0001](0001-bun-hono-gateway.md) | Use Bun and Hono for the gateway | Accepted | 2026-08-22 |
| [0002](0002-valkey-for-ephemeral-state.md) | Use Valkey for cache and ephemeral coordination state | Accepted | 2026-08-22 |
| [0003](0003-pin-openfang-by-commit.md) | Pin and validate the OpenFang integration by commit | Accepted | 2026-08-22 |

## Adding a record

1. Copy [the template](0000-template.md) to the next zero-padded number.
2. Use a short, action-oriented filename and fill every section. Write “None”
   where a section has no content rather than deleting it.
3. Add the record to the decision log above.
4. Link related requirements, contracts, and ADRs with repository-relative
   links.
