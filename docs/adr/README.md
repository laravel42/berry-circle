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
| [0002](0002-valkey-for-ephemeral-state.md) | Use Valkey for cache and ephemeral coordination state | Accepted | 2026-08-22 |
| [0006](0006-agent-run-artifacts.md) | Store agent run artifacts in object storage, indexed as attachments | Accepted | 2026-08-24 |
| [0008](0008-adk-agent-runtime.md) | Run agents in-process with the Google Agent Development Kit | Accepted | 2026-08-27 |
| [0009](0009-typescript-product-server.md) | Reimplement the product server in TypeScript | Accepted | 2026-08-27 |
| [0010](0010-goals-as-derived-task-groups.md) | Goals are derived groups of a project's tasks | Proposed | 2026-09-01 |

### Withdrawn records

0001, 0003, 0004, 0005 and 0007 were removed on 2026-08-28 together with the
subjects they decided — the Bun/Hono gateway, the pinned OpenFang runtime, the
Go product server, Temporal orchestration, and the Activepieces adapter. The
numbers are not reused. What replaced them is recorded in
[0008](0008-adk-agent-runtime.md) and [0009](0009-typescript-product-server.md);
this is the only case in which a record is deleted rather than superseded, and
it happens because the code it described no longer exists to conform to it.

## Adding a record

1. Copy [the template](0000-template.md) to the next zero-padded number.
2. Use a short, action-oriented filename and fill every section. Write “None”
   where a section has no content rather than deleting it.
3. Add the record to the decision log above.
4. Link related requirements, contracts, and ADRs with repository-relative
   links.
