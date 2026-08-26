# ADR-0007: Workflows, AI planning, and an optional Activepieces adapter

- **Status:** Proposed
- **Date:** 2026-08-25
- **Deciders:** Berry architecture team
- **Related:** [ADR-0004](0004-go-product-server.md),
  [ADR-0005](0005-temporal-run-orchestration.md),
  [ADR-0003](0003-pin-openfang-by-commit.md),
  [gateway v1 contract](../api/gateway-v1.md),
  [OpenFang integration specification](../integrations/berry-openfang.md),
  [repository guidelines](../../AGENTS.md)

## Context

Berry's core loop is issue → agent → human review → done. The next product
step lets a user type an outcome and receive **one plan**: a goal, finite
tasks on a board with agents assigned, repeatable automations with typed steps,
and explicit approvals — shown as a preview, edited conversationally, and
persisted only when the user presses Start Plan. "Issues track work. Workflows
automate processes."

Three forces shape how that lands.

**Naming is constrained twice.** AGENTS.md forbids OpenFang- and Linear-derived
identifiers in new code, and ADR-0005 already reserved the word *workflow* away
from Go symbols because OpenFang exposes its own `workflows` API and Temporal's
SDK owns the term. The product, however, needs to say **Workflow** to users:
it is the word they know and the word the spec uses.

**Execution has a substrate question.** Berry-native step execution (condition,
wait, approval, create/update issue, agent, provider action) runs through the
same admission pool and Temporal orchestration that runs agents today. A large
catalogue of third-party integrations ("pieces": Stripe, Google Sheets, Slack)
exists in Activepieces, an open-source automation engine. Its core is MIT, but
the repository also ships enterprise packages under a separate licence, and
Berry's licensing posture requires shipped dependencies to be MIT or
Apache-2.0.

**Planning calls a model, and the model is sometimes wrong.** Berry's rule for
paid upstream calls is at-most-once: `internal/openfang/transport.go` attempts
an unsafe POST exactly once, and ADR-0005 pins `MaximumAttempts: 1` on the
dispatch activity. A planner whose output must pass a deterministic validator
needs a bounded way to ask for a corrected plan when the first answer fails
validation — which is a second paid call by design, not by accident.

Durable domain events are the foundation everything above triggers from.
`outbox_events` already exists, but its `workspace_id` column held a board id
for run-lane rows and a workspace id for everything else, so the board stream
silently dropped comments and no `issue.*` topic existed for a person's edits.
That is repaired first (migration `019_outbox_scope`), before any new topic is
added.

## Decision drivers

- Say **Workflow** to users without a Go symbol named `workflow`.
- Nothing runs before approval; LLM output is never a database write.
- Optional modules must be disabled by default and fail closed (ADR-0004).
- Shipped dependencies are MIT / Apache-2.0; nothing from an enterprise-only
  package is exercised.
- Preserve at-most-once upstream dispatch; every deliberate exception is
  recorded and bounded.
- Pin every external substrate by an immutable reference (ADR-0003).
- Self-hosted deployments stay complete without the adapter.

## Considered options

1. Berry-native execution for a small step vocabulary, with Activepieces
   behind an adapter interface, disabled by default, gated by a licence audit.
2. Activepieces as the only execution engine, with Berry as a thin front.
3. Berry-native execution only, with no third-party catalogue.
4. Naming: package `workflow` with the product noun (rejected by ADR-0005 and
   AGENTS.md); package `automation` with **Workflow** as the wire/UI noun.

## Decision

### D1 — Naming map

The product, API and UI noun is **Workflow**. Go, SQL and Temporal use the
`automation` vocabulary. The mapping is fixed:

| Surface | Name |
|---|---|
| Product / UI | Workflow, Workflow run, Workflow step |
| HTTP routes | `/api/v1/workflows`, `/api/v1/workflow-runs` |
| JSON fields | `workflowId`, `workflowRunId`, `workflowVersion`, `workflow*` |
| Error codes | `WORKFLOW_ENGINE_DISABLED`, `WORKFLOW_*` |
| Outbox topics | `workflow.created\|activated\|paused\|archived`, `workflow.run.*`, `workflow.step.*` |
| Go package | `internal/automation` |
| Go types | `Automation`, `AutomationVersion`, `AutomationRun`, `AutomationStepRun`, `Definition` |
| SQL tables | `automations`, `automation_versions`, `automation_runs`, `automation_step_runs`, `automation_run_events`, `automation_trigger_receipts` |
| Temporal | `berry.AutomationOrchestration` |

Storage and Go names never leak onto the wire; wire names never appear in Go
identifiers. No Berry Go symbol is named `workflow`, and no new identifier
contains `OpenFang` or `Linear`.

### D2 — Execution substrate: native first, adapter optional, fail closed

Berry-native step types run through `automationrun.Runner`, driven by Temporal
when `TEMPORAL_ENABLED` and by the in-process pool otherwise — the same split
ADR-0005 established for runs.

Activepieces is reachable only through the `automation.Engine` interface. It is
**disabled by default**. When disabled, the bound implementation is
`NoopEngine`, and any operation that needs the engine (activating a workflow
that uses a piece, receiving an engine run callback) answers
`409 WORKFLOW_ENGINE_DISABLED` and writes nothing. The adapter talks to the
**community edition over HTTP only**; Berry never imports, vendors, builds or
executes Activepieces code, and `packages/ee` is never exercised — not at
build time, not at run time, not in tests.

Activepieces state never becomes Berry domain state. Berry stores only foreign
references — `engine_flow_id`, `engine_run_id` — and a normalised run status.
PostgreSQL remains authoritative for workflows, runs and steps (ADR-0004);
deleting the engine's database must not lose a Berry fact.

### D6 — The planner repair loop is a recorded exception

Planner roles (classifier, planner, repair, critic) are lean agents Berry
provisions on the runtime and calls for JSON-object responses that are
schema-checked in Go. When a generated plan fails the deterministic validator,
Berry asks the repair role for a corrected plan; when it passes, the critic
role reviews it once.

This is a deliberate exception to "never retry a paid call", and it is
bounded: **at most three repair calls and at most one critic call per plan**,
each a distinct request with a distinct request id, each recorded in
`planner_events` with its usage, none of them a re-send of a request whose
outcome is unknown. The at-most-once rule for agent dispatch is unchanged; the
exception applies only to planner-role completions, whose failure mode is a
wasted call, not duplicated work in the world.

### Licence audit plan

The adapter (and every phase that depends on it) is gated on a written audit,
recorded before the first adapter commit:

1. Identify the exact Activepieces release and its licence files; confirm the
   community edition core is MIT and enumerate the paths under `packages/ee`.
2. Confirm Berry's integration surface is HTTP only: no Activepieces source,
   package, container layer or generated client is compiled into or shipped
   with Berry.
3. Confirm the pinned image is the community edition and that no `ee` feature
   flag, licence key or enterprise endpoint is set, called or required by the
   compose profile, the adapter or its tests.
4. Record the result in `docs/provenance/` with the audited commit, image
   digest and date; the audit is re-run on every pin upgrade.

Until the audit passes, `ACTIVEPIECES_ENABLED` has no effect beyond the
fail-closed 409.

### Pin shape

Like OpenFang (ADR-0003), Activepieces is pinned by an immutable reference in
`deploy/activepieces.pin.json`, validated by
`scripts/check-deploy-pins.py::check_activepieces()`:

```json
{
  "$comment": "Authoritative pin for the optional Activepieces engine. The compose profile MUST use imageDigest; upgrade the pin, the compose default and the adapter contract in one reviewed change.",
  "repository": "https://github.com/activepieces/activepieces.git",
  "commit": "<full 40-character commit>",
  "shortCommit": "<8 characters>",
  "tag": "<release tag or null>",
  "image": "ghcr.io/activepieces/activepieces",
  "imageDigest": "sha256:<64 hex characters>",
  "edition": "community",
  "license": ["MIT"],
  "enterprisePackagesExercised": false,
  "licenseAuditRecord": "docs/provenance/activepieces-license-audit.md",
  "contractVerifiedAgainst": "docs/integrations/berry-activepieces.md",
  "verifiedOn": "YYYY-MM-DD",
  "apiBaseUrl": "http://127.0.0.1:8080",
  "healthCheckPath": "/api/v1/flags"
}
```

`imageDigest` is required, not optional as it still is for OpenFang: the
engine runs as a container, so the digest is the reproducibility boundary.
`commit` must be the full SHA and must match the digest's source.

### Events foundation

`outbox_events.workspace_id` always holds the workspace and the new
`board_id` column the board (migration 019). Every issue mutation — from the
issue routes, the batch routes, project planning and plan compilation — writes
`issue.created|updated|assigned|started|completed|deleted` inside its
transaction and publishes after commit. Realtime events carry both scopes and
fan out to subscribers of either. New topics (`goal.*`, `workflow.*`,
`approval.*`, `plan.*`, `agent.*`) follow the same envelope.

## Consequences

### Positive

- Users see one word — Workflow — while the codebase keeps its existing
  discipline about reserved names.
- Self-hosted deployments are complete without Activepieces; the adapter adds
  catalogue breadth, never a dependency.
- The licence boundary is a review gate with a written artefact, not a hope.
- The repair loop is bounded and auditable; usage per plan is visible.
- The board stream is finally truthful: comments and human edits appear on it.

### Negative

- Two vocabularies to keep aligned (product versus Go/SQL); the mapping table
  is the only place the translation is allowed to live.
- An optional engine is one more container, pin, healthcheck and upgrade path
  for operators who enable it.
- Every planner run may cost up to five model calls; budgets and caps are a
  product setting rather than an emergent property.
- An adapter that fails closed means a workflow using a piece cannot be
  activated until an operator turns the engine on — deliberately.

### Risks and mitigations

- **Risk:** A contributor names a Go symbol `workflow` or imports Activepieces
  code. **Mitigation:** The naming table above, the AGENTS.md rule, and a
  review checklist item; the adapter package compiles against an HTTP client
  only.
- **Risk:** Enterprise-only behaviour is exercised without noticing.
  **Mitigation:** The audit enumerates `packages/ee`; the compose profile pins
  the community image by digest; contract tests run offline against recorded
  fixtures.
- **Risk:** The repair loop grows into unbounded retries. **Mitigation:**
  Hard caps in configuration with an assertion test; every call recorded.
- **Risk:** Engine data drifts into domain tables. **Mitigation:** Only
  `engine_flow_id`/`engine_run_id` and a normalised status are stored; a
  schema review rejects anything else.

## Validation

- `go vet` and a grep gate find no Go identifier containing `workflow`,
  `OpenFang` or `Linear` in new packages.
- With the adapter disabled, activating a piece-backed workflow returns
  `409 WORKFLOW_ENGINE_DISABLED` and writes no rows; every native flow passes.
- `scripts/check-deploy-pins.py` fails on a missing or malformed
  `imageDigest` or a short `commit`.
- A test asserts the repair and critic caps; `planner_events` rows carry
  usage for every call.
- Migration 019's backfill matrix and the board-stream replay of
  `comment.created` and `issue.completed` are covered by database-gated tests.

## Follow-up

- Write and record the Activepieces licence audit before any adapter code.
- Add `check_activepieces()` and `deploy/activepieces.pin.json` when the
  adapter phase starts.
- Decide the planner budget defaults (repairs, critic, tokens) as product
  settings.
- Revisit this record for **Accepted** once the native execution phase ships
  and the audit outcome is known.
