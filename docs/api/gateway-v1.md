# Berry Gateway API Contract

*Draft v1 · Release 1 · BERR-11*

## Status and intent

This document is the normative HTTP and Server-Sent Events (SSE) contract for the Berry gateway. It defines Berry-owned resource names and shapes; runtime-provider payloads are adapted at the gateway boundary and are never relayed directly to clients.

The contract uses conventional resource-oriented JSON, opaque cursor pagination, and stable error envelopes. These are interoperability conventions, not a copy of another product's schema. Unless this document explicitly says otherwise, clients MUST ignore unknown response fields and unknown SSE event types.

Current implementation note: the Go product server at `server/` implements this contract, including run persistence. Where the database and this contract differ, this contract is the target public interface; storage names are not API field names.

Shipped but not yet specified here — treat the implementation as authoritative until these sections are written:

- **Inbox** — `GET /api/v1/inbox`, `GET /api/v1/inbox/unread-count`, `POST /api/v1/inbox/{itemId}/{action}` (`read`, `unread`, `archive`, `unarchive`), `POST /api/v1/inbox/bulk`. Items carry `issueIdentifier` (workspace issue prefix and issue number, for example `BER-3`), derived on read and `null` when the item references no issue.
- **Agent models** — `GET /api/v1/agents/models` returns the runtime model catalog; `PUT /api/v1/agents/{agentId}/config` sets an agent's provider, model, description, and instructions. A provider/model pair is rejected unless the runtime catalog reports it available.
- **Conversations** — `GET /api/v1/conversations`, `POST /api/v1/conversations/agents/{agentId}`, and `GET`/`POST /api/v1/conversations/{conversationId}/messages`. All require the caller to be a participant in the thread.

## Protocol conventions

| Concern | Contract |
|---|---|
| Base path | `/api/v1` |
| Transport | HTTPS in deployed environments; HTTP is permitted only on a trusted local network |
| JSON media type | `application/json` |
| SSE media type | `text/event-stream` |
| Field naming | `camelCase` |
| Identifiers | UUID strings unless a field is explicitly documented as opaque |
| Timestamps | UTC RFC 3339 strings, for example `2026-08-22T06:30:00.000Z` |
| Nullable values | Represented as JSON `null`; omitted fields mean “not requested/not available,” not null |
| Authentication | Release 1 session bearer token: `Authorization: Bearer <session-token>` |
| Request tracing | Server returns `X-Request-Id`; the same value appears in error envelopes |
| Idempotency | Mutating create/dispatch endpoints accept `Idempotency-Key`, described below |

### Versioning

- Breaking changes require a new base path such as `/api/v2`.
- Additive response fields, enum values, and SSE event types are non-breaking. Clients MUST implement an unknown-value fallback.
- Fields marked deprecated remain available for at least one minor release and include a documented replacement before removal in a future major version.

### Idempotency

`POST /boards`, `POST /issues`, `POST /issues/{issueId}/comments`, and `POST /issues/{issueId}/runs` accept an `Idempotency-Key` header.

- The key is an opaque, client-generated string of 16–128 characters.
- Keys are scoped to the authenticated actor, HTTP method, and canonical path and are retained for at least 24 hours.
- Reusing a key with the same body returns the original status code and response body.
- Reusing a key with a different body returns `409 IDEMPOTENCY_CONFLICT`.
- Dispatch clients SHOULD always supply a key to prevent duplicate agent runs.

## Common schemas

### ID and timestamp aliases

| Name | Type | Constraints |
|---|---|---|
| `Uuid` | string | RFC 4122 UUID |
| `Timestamp` | string | RFC 3339 date-time in UTC |
| `Cursor` | string | Opaque, URL-safe token; clients MUST NOT parse or construct it |

### ActorRef

An assignee or author. `id` identifies the resource in the namespace selected by `type`.

| Field | Type | Required | Notes |
|---|---|---:|---|
| `type` | `user \| agent` | yes | Discriminator |
| `id` | `Uuid` | yes | User or agent ID |
| `name` | string | yes | Display name captured at response time |
| `avatarUrl` | string or null | yes | Absolute HTTP(S) URL when present |

```json
{
  "type": "agent",
  "id": "f8957903-6534-4ca3-a218-d95e537a5076",
  "name": "Builder",
  "avatarUrl": null
}
```

### PageInfo and connection

Every collection endpoint returns a connection object. `nodes` contains resources in the documented stable sort order.

| Field | Type | Required | Notes |
|---|---|---:|---|
| `nodes` | array | yes | May be empty |
| `pageInfo.hasNextPage` | boolean | yes | Whether another forward page exists |
| `pageInfo.endCursor` | `Cursor` or null | yes | Cursor for the last node; null for an empty page |

```json
{
  "nodes": [],
  "pageInfo": {
    "hasNextPage": false,
    "endCursor": null
  }
}
```

Collection query parameters:

| Parameter | Type | Default | Constraints |
|---|---|---:|---|
| `first` | integer | `50` | 1–100 |
| `after` | `Cursor` | none | Cursor returned by the same endpoint with the same filters and sort |

Cursors encode the final stable sort tuple and the effective filters. A cursor used with another endpoint, filter set, or sort returns `400 INVALID_CURSOR`. Resources inserted before the current tuple can appear on a later request only if their sort tuple follows the cursor; duplicate nodes across adjacent pages MUST NOT be produced. Deletions may reduce page size.

### ErrorEnvelope

All non-2xx JSON responses use this envelope, including validation and upstream dependency failures.

| Field | Type | Required | Notes |
|---|---|---:|---|
| `error.code` | string | yes | Stable machine-readable code |
| `error.message` | string | yes | Safe human-readable summary; MUST NOT contain secrets |
| `error.requestId` | string | yes | Matches `X-Request-Id` |
| `error.details` | object or null | yes | Structured context safe for clients |

Validation failures set `details.fields` to an array of field errors:

| Field | Type | Required | Notes |
|---|---|---:|---|
| `path` | string | yes | JSON Pointer, or query/header name prefixed with `/query/` or `/headers/` |
| `code` | string | yes | Stable validator code |
| `message` | string | yes | Human-readable reason |

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request is invalid.",
    "requestId": "req_01J5VWDY4JF6QM6BS48Y7C8H7F",
    "details": {
      "fields": [
        {
          "path": "/title",
          "code": "too_small",
          "message": "Title must contain at least 1 character."
        }
      ]
    }
  }
}
```

| HTTP status | Default code | Meaning |
|---:|---|---|
| 400 | `INVALID_REQUEST` | Malformed JSON, parameters, or cursor |
| 401 | `UNAUTHENTICATED` | Missing, invalid, or expired session |
| 403 | `FORBIDDEN` | Authenticated actor lacks permission |
| 404 | `NOT_FOUND` | Resource does not exist or is not visible to actor |
| 409 | `CONFLICT` | State transition, active-run, or idempotency conflict |
| 422 | `VALIDATION_FAILED` | Body is well-formed but fails schema/domain validation |
| 429 | `RATE_LIMITED` | Request budget exceeded; response includes `Retry-After` |
| 502 | `DEPENDENCY_BAD_RESPONSE` | Runtime dependency returned an unusable response |
| 503 | `DEPENDENCY_UNAVAILABLE` | Runtime dependency is unavailable or timed out |
| 500 | `INTERNAL` | Unhandled server failure |

Domain-specific codes used by this contract are `INVALID_CURSOR`, `CURSOR_EXPIRED`, `INVALID_STATE_TRANSITION`, `ACTIVE_RUN_EXISTS`, `IDEMPOTENCY_CONFLICT`, `RUN_TERMINAL`, `APPROVAL_REQUIRED`, `APPROVAL_RESOLVED`, `DEPENDENCY_CYCLE`, `ISSUE_NOT_FOUND`, `GOAL_NOT_FOUND`, `GOAL_TRANSITION_INVALID`, `PLAN_FORBIDDEN`, `PLAN_INVALID`, `PLAN_NOT_OPEN`, `PLAN_BUSY`, `PLAN_OPEN_EXISTS`, `PLAN_COMPILE_FAILED`, `PLANNER_UNAVAILABLE`, `BOARD_REQUIRED`, `DEFINITION_INVALID`, `CONNECTIONS_MISSING`, `REVISION_CONFLICT`, `WORKFLOW_ACTIVE`, `WORKFLOW_NOT_ACTIVE`, `WORKFLOW_ENGINE_DISABLED`, `WORKFLOWS_DISABLED`, `AGENT_UNAVAILABLE`, and `ANSWER_INVALID`.

## Resource schemas

### Board

| Field | Type | Required | Constraints / meaning |
|---|---|---:|---|
| `id` | `Uuid` | yes | Immutable |
| `name` | string | yes | 1–100 characters |
| `slug` | string | yes | 2–12 lowercase ASCII letters/digits/hyphens; unique |
| `description` | string or null | yes | At most 5,000 characters |
| `columns` | `BoardColumn[]` | yes | Ordered, non-empty list |
| `createdAt` | `Timestamp` | yes | Immutable |
| `updatedAt` | `Timestamp` | yes | Last mutation time |

`BoardColumn`:

| Field | Type | Required | Constraints / meaning |
|---|---|---:|---|
| `id` | `IssueStatus` | yes | Status represented by the column |
| `name` | string | yes | 1–50 character display label |

```json
{
  "id": "bb99372f-88c4-44f0-914f-a343bf30e6fb",
  "name": "Berry",
  "slug": "berry",
  "description": "Release 1 workspace",
  "columns": [
    { "id": "backlog", "name": "Backlog" },
    { "id": "todo", "name": "Todo" },
    { "id": "inProgress", "name": "In progress" },
    { "id": "inReview", "name": "In review" },
    { "id": "done", "name": "Done" }
  ],
  "createdAt": "2026-08-22T06:30:00.000Z",
  "updatedAt": "2026-08-22T06:30:00.000Z"
}
```

### Issue

`IssueStatus` is one of `backlog`, `todo`, `inProgress`, `inReview`, `done`, `cancelled`. `IssuePriority` is one of `none`, `urgent`, `high`, `medium`, `low`.

| Field | Type | Required | Constraints / meaning |
|---|---|---:|---|
| `id` | `Uuid` | yes | Immutable |
| `boardId` | `Uuid` | yes | Owning board; immutable |
| `number` | integer | yes | Positive, sequential within the board; immutable |
| `identifier` | string | yes | Uppercase workspace issue prefix (first three characters of the workspace name) plus sequential number, e.g. `BER-42`; immutable |
| `title` | string | yes | 1–500 characters |
| `description` | string or null | yes | Markdown, at most 100,000 characters |
| `status` | `IssueStatus` | yes | Workflow state |
| `priority` | `IssuePriority` | yes | Scheduling priority |
| `sortOrder` | integer | yes | Relative order within a board column |
| `dueDate` | `Timestamp` or null | yes | Due instant |
| `assignee` | `ActorRef` or null | yes | Current assignee |
| `activeRunId` | `Uuid` or null | yes | Active Berry run; null when no run is active |
| `createdBy` | `ActorRef` or null | yes | Null only when the creator was removed |
| `createdAt` | `Timestamp` | yes | Immutable |
| `updatedAt` | `Timestamp` | yes | Last mutation time |

```json
{
  "id": "8138a662-f20f-41aa-bd5a-cf46e35ba952",
  "boardId": "bb99372f-88c4-44f0-914f-a343bf30e6fb",
  "number": 42,
  "identifier": "BER-42",
  "title": "Wire the board to the gateway",
  "description": "Replace fixture data with API resources.",
  "status": "inProgress",
  "priority": "high",
  "sortOrder": 1200,
  "dueDate": null,
  "assignee": {
    "type": "agent",
    "id": "f8957903-6534-4ca3-a218-d95e537a5076",
    "name": "Builder",
    "avatarUrl": null
  },
  "activeRunId": "2020836b-a055-4980-b165-50664cf402c3",
  "createdBy": {
    "type": "user",
    "id": "782a0204-2868-437e-9be8-5b17ce7f13f7",
    "name": "Andrea",
    "avatarUrl": null
  },
  "createdAt": "2026-08-22T06:30:00.000Z",
  "updatedAt": "2026-08-22T06:42:00.000Z"
}
```

An issue additionally carries its place in a plan:

| Field | Type | Required | Constraints / meaning |
|---|---|---:|---|
| `goal` | `{ "id": Uuid, "title": string }` or null | yes | The goal the issue serves (`goal_issues`) |
| `origin` | `{ "workflowId": Uuid, "workflowRunId": Uuid, "workflowStepRunId": Uuid or null }` or null | yes | The workflow run that created the issue |
| `dependsOn` | `IssueDependencyRef[]` | yes | Issues that must finish before this one starts |
| `blocks` | `IssueDependencyRef[]` | yes | Issues waiting on this one |

`IssueDependencyRef` is `{ "id": Uuid, "identifier": string, "title": string, "status": IssueStatus }`. `POST`/`PATCH` bodies accept `goalId` (`Uuid` or null; null unlinks); a goal outside the workspace answers `422 GOAL_NOT_FOUND`. `blocked` is an `IssueStatus`: a compiled issue with open blockers starts there and the dependency release moves it to `todo`.

### Comment

| Field | Type | Required | Constraints / meaning |
|---|---|---:|---|
| `id` | `Uuid` | yes | Immutable |
| `issueId` | `Uuid` | yes | Owning issue; immutable |
| `body` | string | yes | Markdown, 1–100,000 characters |
| `author` | `ActorRef` | yes | Author at creation time |
| `parentId` | `Uuid` or null | yes | Parent comment for one-level threading |
| `createdAt` | `Timestamp` | yes | Immutable |
| `updatedAt` | `Timestamp` | yes | Last edit time |

```json
{
  "id": "3299af16-2bc9-4d2d-b8b7-b76d284ec40d",
  "issueId": "8138a662-f20f-41aa-bd5a-cf46e35ba952",
  "body": "The gateway contract is ready for review.",
  "author": {
    "type": "agent",
    "id": "f8957903-6534-4ca3-a218-d95e537a5076",
    "name": "Builder",
    "avatarUrl": null
  },
  "parentId": null,
  "createdAt": "2026-08-22T06:45:00.000Z",
  "updatedAt": "2026-08-22T06:45:00.000Z"
}
```

### Agent

`AgentStatus` is one of `available`, `busy`, `offline`, `unknown`. `unknown` is the required client fallback for an unrecognized upstream state.

| Field | Type | Required | Constraints / meaning |
|---|---|---:|---|
| `id` | `Uuid` | yes | Berry-stable agent ID |
| `name` | string | yes | 1–100 characters |
| `description` | string or null | yes | At most 5,000 characters |
| `avatarUrl` | string or null | yes | Absolute HTTP(S) URL when present |
| `status` | `AgentStatus` | yes | Current normalized availability |
| `capabilities` | string[] | yes | Sorted unique capability identifiers (runtime tool names, overwritten on sync) |
| `skills` | string[] | yes | Berry-authored capability names in the planner vocabulary (`^[a-z0-9-]{1,50}$`), set through `PUT /agents/{agentId}/config` `skills` |
| `limits` | `{ "maxTokens": integer or null, "maxLLMTokensPerHour": integer or null }` or null | yes | Manifest limit snapshot refreshed on sync; null when the runtime does not report one |
| `createdAt` | `Timestamp` | yes | Creation time reported by the runtime adapter |
| `updatedAt` | `Timestamp` | yes | Last synchronized time |

The gateway MUST NOT expose provider configuration, credentials, system prompts, filesystem paths, or raw runtime payloads.

```json
{
  "id": "f8957903-6534-4ca3-a218-d95e537a5076",
  "name": "Builder",
  "description": "Implements scoped engineering tasks.",
  "avatarUrl": null,
  "status": "busy",
  "capabilities": ["code", "git", "tests"],
  "createdAt": "2026-08-20T15:00:00.000Z",
  "updatedAt": "2026-08-22T06:42:01.000Z"
}
```

### Run

`RunStatus` is one of `queued`, `running`, `succeeded`, `failed`, `cancelled`. `queued` and `running` are active; all other values are terminal.

| Field | Type | Required | Constraints / meaning |
|---|---|---:|---|
| `id` | `Uuid` | yes | Berry run ID; never a provider run ID |
| `issueId` | `Uuid` | yes | Issue that supplied the run context |
| `agentId` | `Uuid` | yes | Assigned agent |
| `status` | `RunStatus` | yes | Normalized lifecycle state |
| `sequence` | integer | yes | Latest persisted event sequence, starting at 0 |
| `summary` | string or null | yes | Safe final summary; null before available |
| `usage` | `RunUsage` | yes | Cumulative normalized usage |
| `failure` | `RunFailure` or null | yes | Present only when `status` is `failed` |
| `createdAt` | `Timestamp` | yes | Dispatch accepted time |
| `startedAt` | `Timestamp` or null | yes | Execution start time |
| `completedAt` | `Timestamp` or null | yes | Terminal transition time |

`RunUsage`:

| Field | Type | Required | Constraints / meaning |
|---|---|---:|---|
| `inputTokens` | integer | yes | Non-negative |
| `outputTokens` | integer | yes | Non-negative |
| `totalTokens` | integer | yes | Non-negative; equals input plus output when both are reported |
| `costMicros` | integer or null | yes | Non-negative millionths of the configured billing currency; null when unavailable |
| `currency` | string or null | yes | ISO 4217 uppercase code; null with unavailable cost |

`RunFailure`:

| Field | Type | Required | Constraints / meaning |
|---|---|---:|---|
| `code` | string | yes | Normalized stable failure code |
| `message` | string | yes | Safe summary; no credentials or raw provider body |
| `retryable` | boolean | yes | Whether the same dispatch may reasonably succeed later |

```json
{
  "id": "2020836b-a055-4980-b165-50664cf402c3",
  "issueId": "8138a662-f20f-41aa-bd5a-cf46e35ba952",
  "agentId": "f8957903-6534-4ca3-a218-d95e537a5076",
  "status": "running",
  "sequence": 8,
  "summary": null,
  "usage": {
    "inputTokens": 2140,
    "outputTokens": 318,
    "totalTokens": 2458,
    "costMicros": null,
    "currency": null
  },
  "failure": null,
  "createdAt": "2026-08-22T06:42:00.000Z",
  "startedAt": "2026-08-22T06:42:01.000Z",
  "completedAt": null
}
```

### Goal

`GoalStatus` is one of `draft`, `planned`, `active`, `blocked`, `completed`, `cancelled`. `blocked` is set only by the trigger dispatcher.

| Field | Type | Required | Constraints / meaning |
|---|---|---:|---|
| `id` | `Uuid` | yes | |
| `workspaceId` | `Uuid` | yes | |
| `projectId` | `Uuid` or null | yes | |
| `title` | string | yes | 1–500 characters |
| `description` | string or null | yes | At most 20,000 characters |
| `status` | `GoalStatus` | yes | |
| `source` | `manual \| ai` | yes | Who wrote the goal |
| `sourcePrompt` | string or null | yes | The prompt an AI goal came from |
| `createdBy` | `ActorRef` or null | yes | |
| `createdAt`, `updatedAt` | `Timestamp` | yes | |
| `startedAt`, `completedAt` | `Timestamp` or null | yes | |
| `progress` | `{ "issuesTotal", "issuesDone", "issuesCancelled", "workflowsActive", "approvalsPending": integer }` | on reads of one goal | Issues linked to the goal, active workflows, pending approvals on the goal or its issues |

### Plan

A generated plan (`source: "ai"`) stores a BerryPlan v1 IR until it is approved; approval compiles it. Orchestrator briefs are served by the project routes, not here.

| Field | Type | Required | Constraints / meaning |
|---|---|---:|---|
| `id`, `workspaceId` | `Uuid` | yes | |
| `goalId`, `projectId` | `Uuid` or null | yes | The project is the goal's |
| `status` | `draft \| pendingApproval \| approved \| rejected \| superseded` | yes | |
| `source` | `ai \| manual` | yes | |
| `sourcePrompt` | string or null | yes | |
| `irVersion` | string or null | yes | `"1"` |
| `version` | integer | yes | Current IR version; every save appends one |
| `plannerVersion`, `confidence` | string / number or null | yes | |
| `generation` | `{ "status": idle \| running \| succeeded \| failed, "error": string or null, "stage": string or null }` | yes | `stage` is the pipeline stage in progress while `status` is `running` (`intent`, `context`, `generate`, `validate`, `repair`, `critic`, `finalize`) and null otherwise. `error` is `PLAN_INVALID` when the bounded repairs ran out (the last IR is kept for editing), `shutdown` when the server stopped mid-generation, or `<code> at <stage>` (`timeout`, `ROLE_RATE_LIMITED`, `PLANNER_UNAVAILABLE`, `REQUEST_TOO_LARGE`, `INTENT_INVALID`, `upstream error`) |
| `validation` | `{ "status": unknown \| valid \| invalid \| blocked, "errors": FieldError[], "warnings": FieldError[], "requiredConnections": [{ "provider", "purpose", "connected" }], "ambiguities": [{ "id", "question", "blocking" }], "risk": low \| medium \| high, "needsAdminActivation": boolean }` | yes | Errors and warnings are recomputed on every read from the stored IR with the workspace's agents, issues and workflows; `path` values are JSON pointers into `plan`. `blocked` means the classifier found a blocking question: `plan` is a goal-only skeleton whose `assumptions` carry the questions (`blocking: true`) and `ambiguities` lists them; answering lands in a later phase |
| `critic` | object or null | yes | |
| `compile` | `{ "status": running \| succeeded \| failed, "error": string or null, "compiledAt": Timestamp or null, "goalId", "issueIds": Uuid[], "workflowIds": Uuid[], "approvalIds": Uuid[] }` or null | yes | Null until a compile was attempted |
| `plan` | BerryPlan or null | yes | The current IR; after compile it carries `compiled` with the temporary-id map |
| `createdAt`, `updatedAt` | `Timestamp` | yes | |

### Approval

`ApprovalKind` is one of `plan`, `issueStart`, `workflowActivation`, `workflowStep`, `integrationAction`. `ApprovalStatus` is one of `pending`, `approved`, `rejected`, `expired`.

| Field | Type | Required | Constraints / meaning |
|---|---|---:|---|
| `id`, `workspaceId` | `Uuid` | yes | |
| `kind` | `ApprovalKind` | yes | |
| `risk` | `low \| medium \| high` | yes | High risk needs `settings.write` to resolve |
| `title`, `description` | string, string or null | yes | |
| `goalId`, `planId`, `issueId`, `workflowId`, `workflowRunId`, `workflowStepRunId` | `Uuid` or null | yes | What the approval gates |
| `issue` | `{ "id", "identifier", "title" }` or null | yes | The gated issue, when any |
| `requestedFrom` | `{ "userId": Uuid or null, "role": owner \| admin \| member or null }` | yes | The addressee: one person, or anyone holding the role or a stronger one |
| `requestedBy` | `{ "type": user \| system \| agent, "id": Uuid }` or null | yes | |
| `status` | `ApprovalStatus` | yes | |
| `decisionNote`, `resolvedBy` | string or null, `Uuid` or null | yes | |
| `requestedAt` | `Timestamp` | yes | |
| `expiresAt`, `resolvedAt` | `Timestamp` or null | yes | |

### Workflow

A workflow (Go and SQL identifiers say `automation`) is a stored `WorkflowDefinition v1`: `{ "version": "1", "trigger": Trigger, "steps": Step[], "entry": [stepId] }`. Step `type` values stay snake_case: `action`, `condition`, `agent`, `create_issue`, `update_issue`, `approval`, `wait`, `switch`, `foreach`, `transform` and `subworkflow` all execute natively (a deployment that narrows the set answers `NODE_TYPE_UNSUPPORTED`). `WorkflowStatus` is one of `draft`, `active`, `paused`, `archived`.

Triggers, `{ "id", "type", ... }`:

| `type` | Fields | Fires when |
|---|---|---|
| `berry_event` | `event` (a published topic or `<aggregate>.*`), `config.filter`? | The fact is published in the workspace and the filter, evaluated over `trigger`, passes |
| `integration` | `provider`, `operation` (a registered trigger tool, e.g. `github` / `issues.opened`, `berry` / `issue_completed`), `config.filter`? | A verified provider delivery arrives on `POST /api/v1/hooks/{provider}` with that event (`trigger.payload` is the delivery), or, for `berry`, the matching Berry topic is published |
| `schedule` | `config.cron` (five fields or `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`), `config.timezone` (IANA) | Each fire instant computed on the timezone's wall clock (DST-safe; a skipped wall-clock time never fires, a repeated one fires once). One run per instant, idempotent on `schedule:<workflowId>:<instant>`; instants missed for longer than one hour are skipped, never replayed. `trigger` is `{ "scheduledAt", "cron", "timezone" }` |
| `manual` | — | `POST /workflows/{id}/runs`; `trigger.input` is the body's input |
| `webhook` | — | `POST /api/v1/hooks/workflows/{id}/{token}` |

The extended nodes, beside the MVP set:

| `type` | Fields | Semantics |
|---|---|---|
| `switch` | `value` (reference or template), `cases: [{ "equals": value, "steps": [stepId] }]`, `defaultSteps`? | The first case whose resolved `equals` is structurally equal to the resolved value hands control to its steps, else `defaultSteps`; every other branch is recorded as skipped. Output `{ "value", "case": index or null, "next": [stepId] }` |
| `foreach` | `items` (a reference resolving to an array), `steps: [stepId]` (the body), `maxItems`? (1–100, default 25) | Records `{ "count", "items" }`, then every body step B runs once per item as the step row `B[i]`, items in order and one item at a time; inside the body `item` is the current element and `steps.<body>.output` the same item's outputs; after the loop `steps.<loop>.output.results[i]` holds item i's body outputs keyed by step id. More items than `maxItems` fails the loop with `FOREACH_LIMIT_EXCEEDED`. A body step may be `action`, `agent`, `create_issue`, `update_issue`, `approval`, `wait`, `transform` or `subworkflow` (each may wait), belongs to one loop, is not an entry step, and is depended on only from inside its loop; `item` is valid only inside a body (and in an event wait's filter) |
| `transform` | `output: { field: value }` | Resolves every field through references and templates into the step output; nothing else happens |
| `subworkflow` | `workflowId` (Uuid of an active workflow in the workspace), `input`? | Starts a child run of the named workflow (`triggerType = manual`, `trigger.input` = the resolved input, `trigger.parent` = `{ workflowId, runId, stepRunId, stepId }`, `parentRunId`/`depth` on the run) and waits on `run:<childRunId>`; resumes with `{ "childRunId", "workflowId", "status", "steps": { stepId: output } }` or fails with `SUBWORKFLOW_FAILED (<child code>)` / `SUBWORKFLOW_CANCELLED`. Validation refuses a workflow calling itself or a chain that returns to it (`SUBWORKFLOW_CYCLE`), a chain deeper than 3 (`SUBWORKFLOW_DEPTH`), an unknown target (`SUBWORKFLOW_UNKNOWN`); an inactive target warns on a draft and blocks activation (`SUBWORKFLOW_NOT_ACTIVE`) |

| Field | Type | Required | Constraints / meaning |
|---|---|---:|---|
| `id`, `workspaceId` | `Uuid` | yes | |
| `projectId`, `goalId` | `Uuid` or null | yes | |
| `name` | string | yes | 1–200 characters |
| `description` | string or null | yes | |
| `status` | `WorkflowStatus` | yes | |
| `version` | integer | yes | Bumps on every definition change; each version is snapshotted |
| `revision` | integer | yes | Bumps on every write; `PATCH` must send the revision it read |
| `definition` | `WorkflowDefinition` | yes | Exactly as validated |
| `layout` | object | yes | Canvas positions keyed by node id; never business state |
| `trigger` | `{ "type": integration \| schedule \| manual \| berry_event \| webhook, "provider"?, "operation"?, "event"?, "cron"?, "timezone"? }` | yes | Indexed metadata derived from the definition |
| `risk` | `low \| medium \| high` | yes | High when a step's tool is destructive or approval-gated |
| `engine` | `native \| activepieces` | yes | |
| `activepiecesFlowId` | string | when `engine` is `activepieces` | |
| `requiredConnections` | `[{ "provider": string, "connected": boolean }]` | yes | Providers whose tools need a workspace connection; Berry's own tools need none |
| `validation` | `{ "errors": FieldError[], "warnings": FieldError[] }` | yes | Recomputed on every read; paths start with `/definition` |
| `createdBy` | `{ "type": "user", "id": Uuid }` or null | yes | |
| `createdAt`, `updatedAt` | `Timestamp` | yes | |
| `lastRun` | `{ "id", "status", "createdAt" }` or null | yes | |
| `runCounts` | `{ "total", "succeeded", "failed": integer }` | yes | |

### WorkflowRun

`WorkflowRunStatus` is one of `pending`, `running`, `waiting`, `succeeded`, `failed`, `cancelled`.

| Field | Type | Required | Constraints / meaning |
|---|---|---:|---|
| `id`, `workspaceId`, `workflowId` | `Uuid` | yes | |
| `workflowVersion` | integer | yes | The definition version the run executes |
| `goalId` | `Uuid` or null | yes | |
| `status` | `WorkflowRunStatus` | yes | |
| `triggerType` | string | yes | |
| `triggerPayload` | object | yes | |
| `currentStepId`, `waitingOn` | string or null | yes | `waitingOn` is `approval:<id>`, `run:<id>` (an agent run or a subworkflow's child run), `issue:<id>`, `timer` or `event:<topic>` |
| `failure` | `{ "code", "message" }` or null | yes | |
| `usage` | `{ "inputTokens", "outputTokens": integer, "costMicros": integer or null }` | yes | Summed inline model usage |
| `parentRunId`, `parentStepRunId` | `Uuid` or null | yes | Set on a run a `subworkflow` step started |
| `depth` | integer | yes | 0 for a run a trigger started; a child run is its parent's depth plus one, at most 3 |
| `createdAt` | `Timestamp` | yes | |
| `startedAt`, `completedAt` | `Timestamp` or null | yes | |
| `steps` | `WorkflowStepRun[]` | on reads of one run | `{ "id", "stepId", "stepType", "attempt", "status", "input", "output", "failure", "runId", "issueId", "approvalId", "usage", "startedAt", "completedAt" }`; a foreach body row's `stepId` is `<stepId>[<index>]` |

## Endpoints

Unless noted otherwise, successful resource reads return the resource directly, not a `{ "data": ... }` wrapper.

### Boards

#### `GET /api/v1/boards`

Returns boards ordered by `(createdAt DESC, id DESC)`. Supports `first` and `after`.

- `200`: connection of `Board`
- `400`: `INVALID_CURSOR`
- `401`: `UNAUTHENTICATED`

#### `POST /api/v1/boards`

Request:

| Field | Type | Required |
|---|---|---:|
| `name` | string | yes |
| `slug` | string | yes |
| `description` | string or null | no |
| `columns` | `BoardColumn[]` | no; defaults to the five non-cancelled workflow columns |

- `201`: created `Board`; `Location: /api/v1/boards/{id}`
- `409`: `CONFLICT` when the slug already exists
- `422`: `VALIDATION_FAILED`

#### `GET /api/v1/boards/{boardId}`

- `200`: `Board`
- `404`: `NOT_FOUND`

#### `PATCH /api/v1/boards/{boardId}`

Accepts any non-empty subset of `name`, `slug`, `description`, and `columns`. A status column cannot be removed while non-terminal issues use it.

- `200`: updated `Board`
- `409`: `CONFLICT` for a duplicate slug or in-use column
- `422`: `VALIDATION_FAILED`

### Issues

#### `GET /api/v1/issues`

Returns issues ordered by `(updatedAt DESC, id DESC)`. Supports `first`, `after`, and these filters:

| Parameter | Type | Meaning |
|---|---|---|
| `boardId` | `Uuid` | Required; owning board |
| `status` | comma-separated `IssueStatus` | Any matching status |
| `priority` | comma-separated `IssuePriority` | Any matching priority |
| `assigneeType` | `user \| agent` | Must be paired with `assigneeId` |
| `assigneeId` | `Uuid` | Must be paired with `assigneeType` |
| `query` | string | Case-insensitive title and identifier search; 1–200 characters |

- `200`: connection of `Issue`
- `400`: malformed filter or `INVALID_CURSOR`
- `404`: board `NOT_FOUND`

#### `POST /api/v1/issues`

Request:

| Field | Type | Required | Default |
|---|---|---:|---|
| `boardId` | `Uuid` | yes | — |
| `title` | string | yes | — |
| `description` | string or null | no | null |
| `status` | `IssueStatus` | no | `backlog` |
| `priority` | `IssuePriority` | no | `none` |
| `sortOrder` | integer | no | 0 |
| `dueDate` | `Timestamp` or null | no | null |
| `assignee` | `{ "type": "user \| agent", "id": "Uuid" }` or null | no | null |

Assignment through this general-purpose resource endpoint records assignment but does not implicitly dispatch a run. The product's atomic assign-and-dispatch action uses `POST /issues/{issueId}/runs` with `agentId`, so the user-facing assignment motion still starts work in one operation.

- `201`: created `Issue`; `Location: /api/v1/issues/{id}`
- `404`: board or assignee `NOT_FOUND`
- `422`: `VALIDATION_FAILED`

#### `GET /api/v1/issues/{issueId}`

`issueId` may be a UUID or the case-insensitive human identifier.

- `200`: `Issue`
- `404`: `NOT_FOUND`

#### `PATCH /api/v1/issues/{issueId}`

Accepts any non-empty subset of `title`, `description`, `status`, `priority`, `sortOrder`, `dueDate`, and `assignee`. Setting `assignee` to null unassigns the issue. Status transitions MUST follow the configured workflow; invalid transitions return `409 INVALID_STATE_TRANSITION` with `details.from` and `details.to`.

- `200`: updated `Issue`
- `404`: issue or assignee `NOT_FOUND`
- `409`: `INVALID_STATE_TRANSITION`
- `409`: `APPROVAL_REQUIRED` with `details.approvalId` when the issue's plan or its `issueStart` approval is not approved and the move targets `todo`
- `422`: `VALIDATION_FAILED`, `GOAL_NOT_FOUND`

#### `GET /api/v1/issues/{issueId}/dependencies`

- `200`: `{ "dependsOn": IssueDependencyRef[], "blocks": IssueDependencyRef[] }`

#### `POST /api/v1/issues/{issueId}/dependencies`

Request `{ "dependsOn": string }` naming the blocking issue by id or identifier. Adding an edge that exists is not an error.

- `201`: the dependency lists
- `404`: `ISSUE_NOT_FOUND` for a blocker outside the workspace
- `409`: `DEPENDENCY_CYCLE`

#### `DELETE /api/v1/issues/{issueId}/dependencies/{dependsOnId}`

- `204`
- `404`: `NOT_FOUND`

### Comments

#### `GET /api/v1/issues/{issueId}/comments`

Returns comments ordered by `(createdAt ASC, id ASC)`. Supports `first` and `after`. Replies are returned as ordinary nodes with `parentId`; the server does not nest them.

- `200`: connection of `Comment`
- `400`: `INVALID_CURSOR`
- `404`: issue `NOT_FOUND`

#### `POST /api/v1/issues/{issueId}/comments`

Request:

| Field | Type | Required | Notes |
|---|---|---:|---|
| `body` | string | yes | Markdown |
| `parentId` | `Uuid` or null | no | Parent MUST belong to the same issue and itself have `parentId: null` |

The authenticated actor is always the author; clients cannot supply an author.

- `201`: created `Comment`; `Location: /api/v1/comments/{id}`
- `404`: issue or parent `NOT_FOUND`
- `422`: `VALIDATION_FAILED`

#### `GET /api/v1/comments/{commentId}`

- `200`: `Comment`
- `404`: `NOT_FOUND`

#### `PATCH /api/v1/comments/{commentId}`

Request is `{ "body": "..." }`. Only the author or an authorized administrator may edit.

- `200`: updated `Comment`
- `403`: `FORBIDDEN`
- `404`: `NOT_FOUND`
- `422`: `VALIDATION_FAILED`

#### `DELETE /api/v1/comments/{commentId}`

Only the author or an authorized administrator may delete. Deleting a root comment also deletes its replies.

- `204`: no body
- `403`: `FORBIDDEN`
- `404`: `NOT_FOUND`

### Agents

Agents are read-only in the gateway v1 contract; configuration remains an adapter concern until the Release 1 crew-management surface is specified.

#### `GET /api/v1/agents`

Returns agents ordered by `(name ASC, id ASC)`. Supports `first`, `after`, and optional `status=AgentStatus`.

- `200`: connection of `Agent`
- `400`: malformed filter or `INVALID_CURSOR`
- `502`: `DEPENDENCY_BAD_RESPONSE`
- `503`: `DEPENDENCY_UNAVAILABLE`

#### `GET /api/v1/agents/{agentId}`

- `200`: `Agent`
- `404`: `NOT_FOUND`
- `502`: `DEPENDENCY_BAD_RESPONSE`
- `503`: `DEPENDENCY_UNAVAILABLE`

#### `GET /api/v1/agents/capabilities`

The registry view the planner reads, for the caller's current workspace, from the stored projection (no runtime round trip). Planner role agents Berry provisions are global and never appear here or in `GET /agents`.

- `200`: `{ "nodes": [{ "id", "name", "status", "capabilities": string[] (skills), "tools": string[] (runtime tools), "repositories": string[], "availability": { "eligible": boolean, "activeRuns": integer, "maxConcurrentRuns": 1 }, "limits": { "maxTokens", "maxLLMTokensPerHour" } or null, "costProfile": string or null, "isOrchestrator": boolean, "updatedAt" }] }`

#### `PUT /api/v1/agents/{agentId}/config`

Accepts `instructions`, `description`, `provider` + `model`, and `skills` (string[], at most 50 names matching `^[a-z0-9-]{1,50}$`; replaces the list). Skills are Berry's own vocabulary and never travel to the runtime.

- `400`: `SKILLS_INVALID`

#### `POST /api/v1/agents/{agentId}/ask`

One bounded question to a workspace agent, answered as a single JSON value (`product.write`; `Idempotency-Key` required). Request `{ "prompt": string (1–49152 bytes), "schema": object }` where `schema` is a JSON Schema in the subset Berry applies (`type`, `enum`, `const`, `required`, `properties`, `additionalProperties`, `items`, `minItems`/`maxItems`, `minLength`/`maxLength`, `pattern`, `format: uuid`, `minimum`/`maximum`, `anyOf`/`oneOf`/`allOf`, local `$ref` into `$defs`). The call is one chat completion on the runtime with the agent as the model and a JSON-object response format — a paid, unsafe call attempted exactly once and never retried; every ask, usable or not, is an `agent_asks` ledger row with its usage and cost.

- `200`: `{ "id": Uuid, "agentId": Uuid, "answer": any, "usage": { "inputTokens", "outputTokens": integer, "costMicros": integer or null, "currency": "USD" or null }, "model": { "provider", "name": string or null }, "createdAt": Timestamp }`
- `403`: `FORBIDDEN`
- `404`: `NOT_FOUND`
- `412`: `AGENT_UNAVAILABLE` with `details.status` — the agent is offline, unknown or archived on the runtime
- `422`: `VALIDATION_FAILED` (prompt or schema), `ANSWER_INVALID` with `details.hint` (why the answer did not decode or match — the answer itself is never echoed), `details.askId` and `details.usage`
- `429`: `RATE_LIMITED` when the agent's model is rate limited upstream
- `502`: `DEPENDENCY_BAD_RESPONSE`
- `503`: `DEPENDENCY_UNAVAILABLE`

### Runs

#### `GET /api/v1/boards/{boardId}/runs`

Returns runs for one board ordered by `(createdAt DESC, id DESC)`. Supports `first`, `after`, optional `status=RunStatus`, and optional `agentId=Uuid`.

- `200`: connection of `Run`
- `400`: malformed filter or `INVALID_CURSOR`
- `404`: board `NOT_FOUND`

#### `GET /api/v1/issues/{issueId}/runs`

Returns runs ordered by `(createdAt DESC, id DESC)`. Supports `first`, `after`, and optional `status=RunStatus`.

- `200`: connection of `Run`
- `400`: malformed filter or `INVALID_CURSOR`
- `404`: issue `NOT_FOUND`

#### `POST /api/v1/issues/{issueId}/runs`

Dispatches the issue to its assigned agent. Request:

| Field | Type | Required | Notes |
|---|---|---:|---|
| `agentId` | `Uuid` or null | no | When present, atomically assigns this agent before dispatch; otherwise uses the current agent assignee |
| `instructions` | string or null | no | Additional run-scoped instructions, at most 20,000 characters |

The issue MUST have an agent assignee after applying `agentId` and no active run. The assignment and `queued` run are persisted atomically before the runtime dependency is contacted, so a successful response always refers to a durable Berry run. A runtime failure after acceptance becomes a persisted `run.failed` event; it does not turn the accepted request into a later HTTP error.

- `202`: accepted `Run`; `Location: /api/v1/runs/{id}`
- `409 ACTIVE_RUN_EXISTS`: issue already has a queued or running run; `details.runId` identifies it
- `409 CONFLICT`: issue has no agent assignee
- `422`: `VALIDATION_FAILED`
- `503`: the gateway cannot durably accept a dispatch; no run or assignment change was created

```json
{
  "agentId": "f8957903-6534-4ca3-a218-d95e537a5076",
  "instructions": "Run the gateway test suite before posting the result."
}
```

#### `GET /api/v1/runs/{runId}`

- `200`: `Run`
- `404`: `NOT_FOUND`

#### `POST /api/v1/runs/{runId}/cancel`

Requests cancellation. The operation is idempotent while cancellation is pending or the run is already cancelled. It returns the latest persisted run and does not promise that an in-flight tool call has stopped at response time.

- `202`: latest `Run`
- `404`: `NOT_FOUND`
- `409 RUN_TERMINAL`: run already succeeded or failed
- `503`: dependency unavailable; run remains in its prior state

### Goals

Every creating `POST` requires `Idempotency-Key`. Reads need `product.read`, writes `product.write`, deletion `settings.write`.

#### `GET /api/v1/goals`

Query `workspaceId` (required), `query`, `status`, `projectId`, `first`, `after`. Ordered by `(updatedAt DESC, id DESC)`.

- `200`: connection of `Goal` (without `progress`)

#### `POST /api/v1/goals`

Request `{ "workspaceId", "title", "description"?, "projectId"? }`.

- `201`: `Goal`; `Location: /api/v1/goals/{id}`
- `422`: `VALIDATION_FAILED`, `PROJECT_NOT_FOUND`

#### `GET /api/v1/goals/{goalId}`

- `200`: `Goal` with `progress`

#### `PATCH /api/v1/goals/{goalId}`

Any non-empty subset of `title`, `description`, `status`, `projectId`. Status follows `draft → planned → active → completed | cancelled`; `blocked` cannot be requested.

- `200`: `Goal` with `progress`
- `422`: `VALIDATION_FAILED`, `GOAL_TRANSITION_INVALID` with `details.from`/`details.to`

#### `DELETE /api/v1/goals/{goalId}`

Archives the goal; its issues keep their links. `settings.write`.

- `204`

#### `GET /api/v1/goals/{goalId}/issues`, `/workflows`, `/approvals`, `/plans`

- `200`: `{ "nodes": [...] }` summaries

#### `PUT` / `DELETE /api/v1/goals/{goalId}/issues/{issueId}`

Links or unlinks an issue (id or identifier) in the goal's workspace. An issue belongs to at most one goal.

- `204`

### Plans

Generated plans only. Mutating routes answer `403 PLAN_FORBIDDEN` for viewers.

#### `POST /api/v1/plans/generate`

Asks the planner for a plan. Request `{ "workspaceId", "prompt" (1–20000 characters), "goalId"?, "projectId"?, "boardId"?, "hint"?: "issue" | "workflow" | "auto" }`, `Idempotency-Key` required (`product.write`). The plan row exists when the response returns; generation runs in the background through the model roles (intent → context → generate → validate → up to `PLANNER_MAX_REPAIRS` repairs → up to `PLANNER_MAX_CRITIC_ROUNDS` critic rounds) bounded by `PLANNER_TIMEOUT`. Follow it with `GET /plans/{planId}` (`generation.stage`) and the workspace stream's `plan.updated` / `plan.generated` / `plan.blocked` facts. Without `goalId` a draft goal is created for the plan; without `boardId` the workspace's oldest board is used. Nothing is created on the board until `POST /approve`.

- `202`: `Plan` with `generation.status = "running"`; `Location: /api/v1/plans/{id}`
- `403`: `PLAN_FORBIDDEN`
- `409`: `PLAN_OPEN_EXISTS` (the goal already has a draft or pending plan), `BOARD_REQUIRED` (the workspace has no board)
- `412`: `PLANNER_UNAVAILABLE` (no planner configured, or a model role is not provisioned)

#### `GET /api/v1/plans/roles`

The provisioned model roles (`settings.write`, resolved against the caller's current workspace).

- `200`: `{ "enabled": boolean, "roles": [{ "role": classifier | planner | repair | critic, "provider", "model", "promptVersion", "status": available | offline | unknown, "maxTokens", "maxLLMTokensPerHour", "lastSyncedAt" }] }`

#### `GET /api/v1/plans/{planId}`

- `200`: `Plan`

#### `GET /api/v1/plans/{planId}/versions`

- `200`: `{ "nodes": [{ "id", "version", "origin", "plan", "validation", "critic", "patch", "createdBy", "createdAt" }] }`

#### `GET /api/v1/plans/{planId}/events`

Pipeline stage records: counts, codes and ids only, never prompts.

- `200`: `{ "nodes": [{ "id", "sequence", "stage", "role", "promptVersion", "modelProvider", "modelName", "inputTokens", "outputTokens", "costMicros", "durationMs", "outcome", "detail", "occurredAt" }] }`

#### `POST /api/v1/plans/{planId}/validate`

Re-runs the deterministic checks on the stored IR and records the verdict.

- `200`: `Plan`

#### `POST /api/v1/plans/{planId}/approve`

Start Plan. Request `{ "note"? }`, `Idempotency-Key` required. Compiles the plan in one transaction: the goal is promoted to `planned`, issues are created in dependency order (`todo`; `blocked` when they depend on another issue; `backlog` with an `issueStart` approval when they require approval or match the destructive-action policy), required capabilities become labels, `goal_issues`, dependency edges and workflow drafts are written, and every fact is published. A member approving a plan whose `validation.risk` is `high` does not compile: the plan enters `pendingApproval` with a `plan` approval addressed to admins. Approving a compiled plan again is a no-op.

- `200`: `Plan` with `compile.status = "succeeded"`
- `202`: `Plan` with `status = "pendingApproval"`
- `409`: `PLAN_INVALID` (`details.fields`; also while `validation.status` is `blocked`), `PLAN_NOT_OPEN`, `PLAN_BUSY` (still generating or compiling), `PLAN_COMPILE_FAILED` with `details.stage`/`details.message` (the plan stays `approved` with `compile.status = "failed"`; retry with `POST /compile`)

#### `POST /api/v1/plans/{planId}/compile`

Retries a failed compile. Same responses as approve, never `202`.

#### `POST /api/v1/plans/{planId}/reject`

Request `{ "note"? }`. Closes an open plan; a draft AI goal the plan created with no issues is archived with it.

- `200`: `Plan`
- `409`: `PLAN_NOT_OPEN`

### Approvals

#### `GET /api/v1/approvals`

Query `workspaceId` (required), `status`, `kind`, `goalId`, `issueId`, `workflowId`, `mine` (true returns the pending approvals the caller may resolve), `first`, `after`. Ordered by `(requestedAt DESC, id DESC)`.

- `200`: connection of `Approval`

#### `POST /api/v1/approvals`

Opens a manual gate. Request `{ "workspaceId", "kind": "issueStart", "issueId", "title", "description"?, "requestedFromUserId"? | "requestedFromRole"?, "risk"?, "expiresAt"? }`; without an addressee the gate is addressed to admins. `Idempotency-Key` required.

- `201`: `Approval`; `Location: /api/v1/approvals/{id}`
- `409`: `CONFLICT` when the issue already has a pending gate

#### `GET /api/v1/approvals/{approvalId}`

- `200`: `Approval`

#### `POST /api/v1/approvals/{approvalId}/approve`, `/reject`

Request `{ "note"? }`, `Idempotency-Key` required. The caller must be the addressee, or hold the addressed role or a stronger one; `risk = high` additionally needs `settings.write`. Approving an `issueStart` gate releases the issue from `backlog` to `todo`, or to `blocked` while issues it depends on are still open. Resolution is the only path that moves a gated issue: a direct status write is refused by the database.

- `200`: `Approval`
- `403`: `FORBIDDEN` with `details.reason` `not_addressee` or `admin_required`
- `409`: `APPROVAL_RESOLVED`, `APPROVAL_REQUIRED` (another gate still holds the issue)

### Workflows

`/api/v1/workflows` serves workflows; the product noun is Workflow, the storage noun automation.

#### `GET /api/v1/workflows`

Query `workspaceId` (required), `status`, `triggerType`, `goalId`, `projectId`, `query`, `first`, `after`. Archived workflows are excluded. Ordered by `(updatedAt DESC, id DESC)`.

- `200`: connection of `Workflow`

#### `POST /api/v1/workflows`

Request `{ "workspaceId", "name", "description"?, "projectId"?, "goalId"?, "definition": WorkflowDefinition, "layout"? }`. The definition is parsed strictly and validated against the workspace's tool catalog; a missing connection is a warning on a draft.

- `201`: `Workflow` (status `draft`); `Location: /api/v1/workflows/{id}`
- `422`: `VALIDATION_FAILED`; `DEFINITION_INVALID` with `details.fields[]` of `{ "path": "/definition/…", "code", "message", "severity", "hint"? }`

#### `GET /api/v1/workflows/{workflowId}`

- `200`: `Workflow`

#### `PATCH /api/v1/workflows/{workflowId}`

Request any of `name`, `description`, `definition`, `layout`, `goalId`, `projectId`, plus the required `revision`. A definition change bumps `version` and is allowed only while `draft` or `paused`.

- `200`: `Workflow`
- `409`: `REVISION_CONFLICT`, `WORKFLOW_ACTIVE`
- `422`: `VALIDATION_FAILED`, `DEFINITION_INVALID`

#### `DELETE /api/v1/workflows/{workflowId}`

Archives; runs and versions stay readable.

- `204`

#### `POST /api/v1/workflows/{workflowId}/activate`

Validates with every required connection present and records the activation. A `risk = high` workflow needs `settings.write`. Triggers start with the status: the trigger dispatcher matches Berry events and provider deliveries only against active workflows, the hook and manual-run routes refuse inactive ones, and a `schedule` trigger is registered before the status changes — as a Temporal Schedule (`automation-schedule:<id>`, one `berry.AutomationScheduledRun` per fire) when `TEMPORAL_ENABLED`, else as a cached next fire time the in-process scheduler claims every dispatcher tick. Pausing pauses the schedule; archiving deletes it. Both paths create the same run rows.

- `200`: `Workflow`
- `403`: `FORBIDDEN` with `details.reason = "destructive_actions"`
- `409`: `WORKFLOW_ENGINE_DISABLED` for `engine = activepieces` without a configured engine
- `422`: `CONNECTIONS_MISSING` with `details.providers`; `DEFINITION_INVALID`

#### `POST /api/v1/workflows/{workflowId}/pause`

- `200`: `Workflow`
- `409`: `WORKFLOW_NOT_ACTIVE`

#### `POST /api/v1/workflows/{workflowId}/runs`

Runs the workflow by hand (`runs.dispatch`; `Idempotency-Key` required). Request `{ "input"?: any }`; any trigger type may be run this way and the input becomes `trigger.input` in the run's scope (`null` when omitted). The run is created as `trigger_type = manual` and handed to the executor — Temporal when `TEMPORAL_ENABLED`, the in-process pool otherwise.

- `202`: `WorkflowRun` (status `pending`, without `steps`); `Location: /api/v1/workflow-runs/{runId}`
- `403`: `FORBIDDEN`
- `409`: `WORKFLOW_NOT_ACTIVE` — drafts and paused workflows never run
- `412`: `WORKFLOWS_DISABLED` — the deployment does not execute workflows (`AUTOMATION_ENABLED=false`)

#### `GET /api/v1/workflows/{workflowId}/runs`

Query `status`, `first`, `after`.

- `200`: connection of `WorkflowRun` (without `steps`)

#### `GET /api/v1/workflows/{workflowId}/versions`

- `200`: `{ "nodes": [{ "id", "version", "definition", "createdBy", "createdAt" }] }`

#### `POST /api/v1/workflows/{workflowId}/webhook`

Rotates the hook token (`settings.write`). Only its digest is stored; deliveries arrive on the public hooks route below.

- `200`: `{ "url": "/api/v1/hooks/workflows/{id}/{token}", "secret": string }` returned once

### Hooks

`/api/v1/hooks` is a separate mount without a session: the token in the URL is the credential. It is mounted only where the deployment executes workflows.

#### `POST /api/v1/hooks/workflows/{workflowId}/{token}`

Receives one delivery for an active workflow whose current hook token matches (compared by digest). The body, at most 1 MiB, is JSON or empty; it becomes `trigger.input` (`null` when empty) beside `trigger.query` (first value per query parameter), `trigger.contentType`, `trigger.deliveryId` and `trigger.receivedAt`. An `X-Berry-Delivery-Id` header (at most 120 characters) makes the delivery idempotent: a redelivery answers `200` with the run it already created. Each workflow accepts 60 deliveries per minute. Every way a delivery can fail to name an active workflow with this token — unknown id, wrong token, paused or archived workflow — is the same `404`.

- `202`: `{ "runId": Uuid }`; `Location: /api/v1/workflow-runs/{runId}`; the run is `trigger_type = webhook`
- `200`: `{ "runId": Uuid }` for a redelivery
- `400`: `INVALID_BODY`, `INVALID_REQUEST`
- `404`: `NOT_FOUND`
- `413`: `PAYLOAD_TOO_LARGE`
- `429`: `RATE_LIMITED` with `Retry-After`

#### `POST /api/v1/hooks/{provider}`

Provider webhook ingestors for `github`, `slack` and `linear`, mounted beside the workflow hook route when at least one provider secret is configured (`GITHUB_WEBHOOK_SECRET`, `SLACK_SIGNING_SECRET`, `LINEAR_WEBHOOK_SECRET`). The signature is verified over the raw body before anything is parsed: GitHub `X-Hub-Signature-256` (HMAC-SHA256, the SHA-1 header is not accepted), Slack `X-Slack-Signature` v0 with `X-Slack-Request-Timestamp` inside a five-minute window, Linear `Linear-Signature` (hex HMAC-SHA256). A verified delivery is deduplicated on the provider's delivery id (`X-GitHub-Delivery`; Slack `event_id`; `Linear-Delivery`, else `webhookId:webhookTimestamp`), recorded in `integration_webhook_deliveries`, and written once as the fact `integration.webhook.received { "provider", "event", "deliveryId", "payload" }` scoped to the workspace that owns the delivery; the trigger dispatcher then starts every active workflow whose `integration` trigger names `provider` and `event`, with the fact as `trigger` (`trigger.payload` is the provider's body). Nothing is retried: a redelivery is answered and dropped.

The event is normalised as the `X-GitHub-Event` header joined with the payload `action` (`issues.opened`, `pull_request.closed`, `push`), the Slack `event.type` (`message`, `app_mention`), or the Linear `type.action` in lowercase (`issue.create`). The workspace is resolved from the delivery: Slack by `team_id` against the connection's account; GitHub by `repository.id` against a project's linked repository, then by the installation or owner id against the connection's account; Linear by `organizationId` against the connection's account. Because GitHub and Linear connections carry no account id at authorisation time, register those webhooks with `?workspaceId=<uuid>` on the URL: the delivery is then accepted only if that workspace holds a live connection to the provider. A Slack `url_verification` handshake answers `{ "challenge" }` after the signature check and is never ingested. Every way a delivery can fail to be trusted or routed — an unconfigured secret, a bad signature, an unknown provider, no workspace — is the same `404`, never a `500`. Each provider accepts 600 deliveries per minute per replica.

- `202`: `{ "deliveryId", "eventId": Uuid, "event" }` — one `integration.webhook.received` fact was written
- `200`: `{ "deliveryId", "status": "duplicate" }` for a redelivery, or `{ "challenge" }` for a Slack handshake
- `400`: `INVALID_BODY` — not JSON, or the provider's required headers or fields are missing
- `404`: `NOT_FOUND`
- `413`: `PAYLOAD_TOO_LARGE` (256 KiB)
- `429`: `RATE_LIMITED` with `Retry-After`
- `503`: `DEPENDENCY_UNAVAILABLE` — the delivery could not be recorded; the provider should redeliver

### Workflow runs

#### `GET /api/v1/workflow-runs`

Query `workspaceId` (required), `status`, `workflowId`, `first`, `after`. Ordered by `(createdAt DESC, id DESC)`.

- `200`: connection of `WorkflowRun` (without `steps`)

#### `GET /api/v1/workflow-runs/{runId}`

- `200`: `WorkflowRun` with `steps`

#### `POST /api/v1/workflow-runs/{runId}/cancel`

`runs.dispatch`. Cancels the run row, then tells the executor to stop waiting: with `TEMPORAL_ENABLED` the orchestration is signalled; in-process, the runner refuses the next step of a cancelled run on its own. A step already executing finishes recording its own outcome; nothing after it starts.

- `200`: `WorkflowRun`
- `409`: `RUN_TERMINAL`

## SSE contracts

### Stream endpoints

#### `GET /api/v1/runs/{runId}/events`

Replays and follows one run. The client may send `Last-Event-ID` or `after` (opaque event cursor); supplying both returns `400 INVALID_REQUEST`.

#### `GET /api/v1/workflow-runs/{runId}/events`

Replays and follows one workflow run through its own ledger. Same cursor rules as the run stream. Frames carry `{ "id", "type", "occurredAt", "workspaceId", "workflowId", "workflowRunId", "stepId"?, "sequence", "payload" }`; the stream terminates after `workflow.run.succeeded`, `workflow.run.failed` or `workflow.run.cancelled`. Sequences start at 0.

#### `GET /api/v1/events`

Follows product changes in one scope. Exactly one of `boardId` or `workspaceId` is required (both or neither is `400 INVALID_REQUEST`); optional `after` cursor.

With `boardId`, the stream emits every `issue.*` mutation on the board — whether a person, a batch edit, project planning or a run made it — plus `comment.created` and the run lifecycle events for issues on that board. Replay filters on the event's stored board scope, so a comment posted by a run and a comment posted by a person appear on the same stream.

With `workspaceId` (`product.read`), the stream replays the facts that belong to no board beside the workspace-wide issue and agent moments: `goal.*`, `workflow.*` (definitions, runs and steps), `approval.*`, `plan.*`, `issue.created`, `issue.completed`, `issue.deleted`, `agent.*` and `artifact.created`. Frames use the same envelope with `boardId` and `issueId` null when the aggregate has none. A cursor from one scope is refused on the other.

All three endpoints:

- return `200 Content-Type: text/event-stream; charset=utf-8` and `Cache-Control: no-cache, no-transform`;
- send a `retry: 3000` directive at connection start;
- replay retained events after the supplied cursor, then remain open;
- retain resumable events for at least 24 hours;
- return `409 CURSOR_EXPIRED` as a JSON `ErrorEnvelope` before opening the stream when the cursor is older than retention;
- emit an SSE comment line `: heartbeat` at least every 15 seconds of inactivity; heartbeats have no event ID or JSON payload;
- terminate after sending a terminal event on the run-specific stream;
- may close at any time; clients reconnect with the latest `id` using exponential backoff capped at 30 seconds.

Event frame:

```text
id: evt_01J5VXZ6J93DPTW7XEF27MS7SB
event: run.started
data: {"id":"evt_01J5VXZ6J93DPTW7XEF27MS7SB","type":"run.started","occurredAt":"2026-08-22T06:42:01.000Z","workspaceId":"4d5e0f77-2f4b-4f0c-9b1c-6f0a1c2d3e4f","boardId":"bb99372f-88c4-44f0-914f-a343bf30e6fb","issueId":"8138a662-f20f-41aa-bd5a-cf46e35ba952","runId":"2020836b-a055-4980-b165-50664cf402c3","sequence":1,"payload":{"startedAt":"2026-08-22T06:42:01.000Z"}}

```

The SSE `id` line MUST equal data field `id`; the SSE `event` line MUST equal data field `type`. Each `data` value is one compact JSON object on one line.

### EventEnvelope

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `id` | string | yes | Opaque, globally unique event cursor |
| `type` | `EventType` | yes | Discriminator matching the SSE event name |
| `occurredAt` | `Timestamp` | yes | Gateway persistence time |
| `workspaceId` | `Uuid` | yes | Workspace scope; always the real workspace |
| `boardId` | `Uuid` | yes | Board scope; the board the aggregate lives on |
| `issueId` | `Uuid` | yes | Issue scope |
| `runId` | `Uuid` or null | yes | Run scope; null for events no run produced (`issue.*` from a person or batch edit, `comment.*` from a person) |
| `sequence` | integer or null | yes | Strictly increasing within a run; null for events without a run |
| `payload` | object | yes | Shape selected by `type` |

Run sequences start at 0 and MUST be contiguous in the persisted stream. Delivery is at least once after reconnect; clients deduplicate by event `id`. Clients MUST apply run events only when `sequence` is greater than their last applied sequence for that run. Clients MUST tolerate null `runId`/`sequence`: the board stream carries facts that no run produced.

### Event types and payloads

| Event type | Payload | Notes |
|---|---|---|
| `run.created` | `{ "run": Run }` | Sequence 0; durable queued run |
| `run.started` | `{ "startedAt": Timestamp }` | Run entered `running` |
| `run.output.delta` | `{ "channel": "progress" \| "final", "text": string }` | Incremental safe display text; not a complete message |
| `run.tool.started` | `{ "toolCallId": string, "name": string, "inputSummary": string or null }` | Input summary MUST be redacted and size-limited |
| `run.tool.completed` | `{ "toolCallId": string, "status": "succeeded" \| "failed", "outputSummary": string or null }` | Output summary MUST be redacted and size-limited |
| `run.usage.updated` | `{ "usage": RunUsage }` | Cumulative, never a delta |
| `run.completed` | `{ "run": Run }` | Terminal `succeeded` snapshot |
| `run.failed` | `{ "run": Run }` | Terminal `failed` snapshot with `failure` |
| `run.cancelled` | `{ "run": Run }` | Terminal `cancelled` snapshot |
| `issue.created` | `IssueMutation` | Emitted by `POST /issues`, project planning and plan compilation |
| `issue.updated` | `IssueMutation` | Every change; `changedFields` names the wire fields touched. `runId` is the causing run when a run completion moved the issue |
| `issue.assigned` | `IssueMutation` | Emitted beside `issue.updated` when the assignee changed to someone |
| `issue.started` | `IssueMutation` | Emitted beside `issue.updated` when `status` moved to `inProgress` |
| `issue.completed` | `IssueMutation` | Emitted beside `issue.updated` when `status` moved to `done` |
| `issue.deleted` | `IssueMutation` | Soft delete; the `issue` snapshot is the row as it was |
| `comment.created` | `{ "comment": Comment }` | `runId` is the authoring run when applicable |
| `goal.created`, `goal.updated`, `goal.started`, `goal.completed`, `goal.cancelled`, `goal.archived` | `{ "goal": Goal, "changedFields": string[], "actor"? }` | Workspace stream; `goal.archived` is a topic no consumer dispatches or projects on |
| `approval.requested`, `approval.approved`, `approval.rejected`, `approval.expired` | `{ "approval": Approval, "issueId"?, "actor"? }` | On the board stream too when the approval gates an issue |
| `workflow.created`, `workflow.activated`, `workflow.paused`, `workflow.archived` | `{ "workflow": { "id", "workspaceId", "projectId", "goalId", "name", "status", "version", "revision", "triggerType", "risk", "engine", "updatedAt" }, "actor"? }` | Workspace stream |
| `workflow.run.started`, `workflow.run.waiting`, `workflow.run.resumed`, `workflow.run.succeeded`, `workflow.run.failed`, `workflow.run.cancelled` | `{ "workflowId", "workflowRunId", "stepId"?, "waitingOn"?, "run": WorkflowRun summary, "actor"? }` | Also on the run's own ledger stream with `sequence` |
| `workflow.step.started`, `workflow.step.succeeded`, `workflow.step.failed`, `workflow.step.skipped`, `workflow.step.waiting` | `{ "workflowId", "workflowRunId", "stepId", "waitingOn"?, "step": WorkflowStepRun summary }` | Input and output are omitted from the frame; a foreach body row's `stepId` carries its index (`note[2]`) |
| `integration.webhook.received` | `{ "provider", "event", "deliveryId", "payload" }` | Written once per verified provider delivery by `POST /api/v1/hooks/{provider}`; consumed by the trigger dispatcher, subscribable as a `berry_event` |
| `plan.approved`, `plan.compiled`, `plan.compile_failed` | `{ "plan": { "id", "workspaceId", "goalId", "status", "compileStatus", "validationStatus" }, ... }` | `plan.compiled` carries `compiled` (the id map); `plan.compile_failed` carries `stage` and `message`. `plan.patched` arrives with conversational editing |
| `plan.updated`, `plan.generated`, `plan.blocked` | `{ "plan": { "id", "workspaceId", "goalId", "status", "compileStatus", "validationStatus" }, "stage", "status", ... }` | Workspace stream. `plan.updated` is emitted when each pipeline stage starts (`status: "running"`) and once more when generation fails (`status: "failed"`, `error`, `outcome`, `errors` codes when `PLAN_INVALID`); `plan.generated` closes a valid generation with `version`, `confidence`, `repairs`, `warnings` codes and `risk`; `plan.blocked` carries `questions: [{ "id", "question" }]`. None carries prompt text |

`IssueMutation` is `{ "issue": Issue, "changedFields": string[], "previousStatus"?: IssueStatus, "actor"?: { "type": "user" | "agent", "id": Uuid } }`. `changedFields` is empty for `issue.created` and `issue.deleted`; `previousStatus` is present only when `status` changed; `actor` is the user who made the change and is absent when a run made it. The derived topics (`assigned`, `started`, `completed`) carry the same payload as the `issue.updated` they accompany and are ordered after it.

Raw prompts, hidden reasoning, credentials, unredacted tool inputs/outputs, provider errors, and filesystem paths MUST NOT appear in any event payload. A provider event that has no safe public equivalent is recorded internally but not emitted.

Terminal event example:

```text
id: evt_01J5W0BBZM6S8G8P7XYAHQHN2C
event: run.completed
data: {"id":"evt_01J5W0BBZM6S8G8P7XYAHQHN2C","type":"run.completed","occurredAt":"2026-08-22T06:48:22.000Z","workspaceId":"4d5e0f77-2f4b-4f0c-9b1c-6f0a1c2d3e4f","boardId":"bb99372f-88c4-44f0-914f-a343bf30e6fb","issueId":"8138a662-f20f-41aa-bd5a-cf46e35ba952","runId":"2020836b-a055-4980-b165-50664cf402c3","sequence":19,"payload":{"run":{"id":"2020836b-a055-4980-b165-50664cf402c3","issueId":"8138a662-f20f-41aa-bd5a-cf46e35ba952","agentId":"f8957903-6534-4ca3-a218-d95e537a5076","status":"succeeded","sequence":19,"summary":"Gateway wiring completed and tests passed.","usage":{"inputTokens":2140,"outputTokens":901,"totalTokens":3041,"costMicros":null,"currency":null},"failure":null,"createdAt":"2026-08-22T06:42:00.000Z","startedAt":"2026-08-22T06:42:01.000Z","completedAt":"2026-08-22T06:48:22.000Z"}}}

```

## State and consistency rules

1. The gateway owns public IDs, state normalization, authorization, redaction, pagination, and idempotency. Provider identifiers remain internal mappings.
2. Creating an agent assignment and dispatching a run are separate operations. This avoids writes with hidden execution side effects.
3. At most one `queued` or `running` run may exist per issue. The database MUST enforce this invariant, not only application code.
4. A terminal run is immutable except for late-arriving cumulative usage reconciliation. Such reconciliation emits `run.usage.updated` but does not change the terminal status.
5. `Issue.activeRunId` is set atomically with run creation and cleared atomically with the terminal run event.
6. Every SSE event is persisted before delivery. Replayed and live delivery use the same serialized event shape.
7. Comment and issue responses resolve display names but retain stable actor IDs. Deleted actors remain referentially displayable using their last known name.

## Authorization baseline

Release 1 is self-hosted but still enforces authorization at the gateway:

- authenticated board members may read boards, issues, comments, agents, runs, and streams;
- members with issue-write permission may create/edit issues and comments;
- dispatch permission is required to create or cancel runs;
- administrator permission is required to edit/delete another actor's comment;
- unauthorized resource existence is hidden with `404 NOT_FOUND` where revealing it would cross a board boundary.

The public API never accepts a runtime credential from a browser and never returns one.

## Open questions for implementation planning

These do not weaken the wire contract above, but require a product decision before their associated surface expands:

1. Agent creation and editing are intentionally excluded from v1 until crew-management permissions and secret handling are specified.
2. Run replay currently exposes safe text/tool summaries and usage. Artifact and audit-proof attachment schemas need a separate contract before the Release 1 review-gate milestone.
3. Board membership endpoints are outside this issue's five-resource scope; authorization claims are therefore policy requirements, not yet client-facing resources.

## Contract self-check

- Resource shapes: `Board`, `Issue`, `Comment`, `Agent`, `Run`, `Goal`, `Plan`, `Approval`, `Workflow`, and `WorkflowRun` are defined with constraints; the first five with JSON examples.
- Pagination: connection envelope, cursor rules, limits, stable ordering, invalid and expired cursor behavior are defined.
- Errors: one stable envelope, validation details, HTTP mappings, and domain codes are defined.
- SSE: endpoints (run, workflow run, board and workspace scopes), reconnection/replay behavior, envelope, ordering/deduplication, redaction rules, event types, payload shapes, and examples are defined.
- Versioning, authentication, authorization, idempotency, status codes, and implementation gaps are explicit.
