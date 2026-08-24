# Berry Gateway API Contract

*Draft v1 · Release 1 · BERR-11*

## Status and intent

This document is the normative HTTP and Server-Sent Events (SSE) contract for the Berry gateway. It defines Berry-owned resource names and shapes; runtime-provider payloads are adapted at the gateway boundary and are never relayed directly to clients.

The contract uses conventional resource-oriented JSON, opaque cursor pagination, and stable error envelopes. These are interoperability conventions, not a copy of another product's schema. Unless this document explicitly says otherwise, clients MUST ignore unknown response fields and unknown SSE event types.

Current implementation note: the Go product server at `server/` implements this contract, including run persistence. Where the database and this contract differ, this contract is the target public interface; storage names are not API field names.

Shipped but not yet specified here — treat the implementation as authoritative until these sections are written:

- **Inbox** — `GET /api/v1/inbox`, `GET /api/v1/inbox/unread-count`, `POST /api/v1/inbox/{itemId}/{action}` (`read`, `unread`, `archive`, `unarchive`), `POST /api/v1/inbox/bulk`. Items carry `issueIdentifier` (board slug and issue number, for example `PLATFORM-3`), derived on read and `null` when the item references no issue.
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

Domain-specific codes used by this contract are `INVALID_CURSOR`, `CURSOR_EXPIRED`, `INVALID_STATE_TRANSITION`, `ACTIVE_RUN_EXISTS`, `IDEMPOTENCY_CONFLICT`, and `RUN_TERMINAL`.

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
| `identifier` | string | yes | Uppercase board slug plus number, e.g. `BERRY-42`; immutable |
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
  "identifier": "BERRY-42",
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
| `capabilities` | string[] | yes | Sorted unique capability identifiers |
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
- `422`: `VALIDATION_FAILED`

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

## SSE contracts

### Stream endpoints

#### `GET /api/v1/runs/{runId}/events`

Replays and follows one run. The client may send `Last-Event-ID` or `after` (opaque event cursor); supplying both returns `400 INVALID_REQUEST`.

#### `GET /api/v1/events`

Follows board-level product changes. Required query parameter `boardId`; optional `after` cursor. This stream emits `issue.updated` and `comment.created`, plus run lifecycle events for issues on that board.

Both endpoints:

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
data: {"id":"evt_01J5VXZ6J93DPTW7XEF27MS7SB","type":"run.started","occurredAt":"2026-08-22T06:42:01.000Z","boardId":"bb99372f-88c4-44f0-914f-a343bf30e6fb","issueId":"8138a662-f20f-41aa-bd5a-cf46e35ba952","runId":"2020836b-a055-4980-b165-50664cf402c3","sequence":1,"payload":{"startedAt":"2026-08-22T06:42:01.000Z"}}

```

The SSE `id` line MUST equal data field `id`; the SSE `event` line MUST equal data field `type`. Each `data` value is one compact JSON object on one line.

### EventEnvelope

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `id` | string | yes | Opaque, globally unique event cursor |
| `type` | `EventType` | yes | Discriminator matching the SSE event name |
| `occurredAt` | `Timestamp` | yes | Gateway persistence time |
| `boardId` | `Uuid` | yes | Board scope |
| `issueId` | `Uuid` | yes | Issue scope |
| `runId` | `Uuid` or null | yes | Run scope; null for comment-only events |
| `sequence` | integer or null | yes | Strictly increasing within a run; null for events without a run |
| `payload` | object | yes | Shape selected by `type` |

Run sequences start at 0 and MUST be contiguous in the persisted stream. Delivery is at least once after reconnect; clients deduplicate by event `id`. Clients MUST apply run events only when `sequence` is greater than their last applied sequence for that run.

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
| `issue.updated` | `{ "issue": Issue, "changedFields": string[] }` | `runId` is the causing run when applicable |
| `comment.created` | `{ "comment": Comment }` | `runId` is the authoring run when applicable |

Raw prompts, hidden reasoning, credentials, unredacted tool inputs/outputs, provider errors, and filesystem paths MUST NOT appear in any event payload. A provider event that has no safe public equivalent is recorded internally but not emitted.

Terminal event example:

```text
id: evt_01J5W0BBZM6S8G8P7XYAHQHN2C
event: run.completed
data: {"id":"evt_01J5W0BBZM6S8G8P7XYAHQHN2C","type":"run.completed","occurredAt":"2026-08-22T06:48:22.000Z","boardId":"bb99372f-88c4-44f0-914f-a343bf30e6fb","issueId":"8138a662-f20f-41aa-bd5a-cf46e35ba952","runId":"2020836b-a055-4980-b165-50664cf402c3","sequence":19,"payload":{"run":{"id":"2020836b-a055-4980-b165-50664cf402c3","issueId":"8138a662-f20f-41aa-bd5a-cf46e35ba952","agentId":"f8957903-6534-4ca3-a218-d95e537a5076","status":"succeeded","sequence":19,"summary":"Gateway wiring completed and tests passed.","usage":{"inputTokens":2140,"outputTokens":901,"totalTokens":3041,"costMicros":null,"currency":null},"failure":null,"createdAt":"2026-08-22T06:42:00.000Z","startedAt":"2026-08-22T06:42:01.000Z","completedAt":"2026-08-22T06:48:22.000Z"}}}

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

- Resource shapes: `Board`, `Issue`, `Comment`, `Agent`, and `Run` are defined with constraints and JSON examples.
- Pagination: connection envelope, cursor rules, limits, stable ordering, invalid and expired cursor behavior are defined.
- Errors: one stable envelope, validation details, HTTP mappings, and domain codes are defined.
- SSE: endpoints, reconnection/replay behavior, envelope, ordering/deduplication, redaction rules, event types, payload shapes, and examples are defined.
- Versioning, authentication, authorization, idempotency, status codes, and implementation gaps are explicit.
