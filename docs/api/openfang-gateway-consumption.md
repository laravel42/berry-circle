# OpenFang API Contract Consumed by Berry

*Release 1 · BERR-17*

## Status and baseline

This is the source-of-truth upstream contract for the OpenFang adapter in the
Berry gateway. It narrows the upstream surface to the endpoints Berry consumes
for agent lifecycle, agent execution, memory, workflows, run reconciliation,
and streaming.

The contract was derived from the router and handlers at immutable upstream
commit [`acf2587e46be174c10200489c9a2d23a39a98aeb`](https://github.com/RightNow-AI/openfang/tree/acf2587e46be174c10200489c9a2d23a39a98aeb)
(v0.6.9). The source handlers take precedence over the upstream prose API
reference where they differ. An upstream upgrade requires this document and
the gateway adapter tests to change together.

The OpenAI-compatible `/v1/chat/completions` contract is exercised separately
by BERR-16 and is not part of this endpoint set.

## Transport, authentication, and common behavior

| Concern | Contract |
|---|---|
| Base URL | Gateway-only configuration; local default is `http://127.0.0.1:4200` |
| JSON | Requests and non-streaming responses use `application/json` |
| Streaming | Agent execution uses `text/event-stream` over the response to a `POST` request |
| Authentication | Gateway sends `Authorization: Bearer <api-key>` on every upstream request |
| Request ID | Every response includes `x-request-id`; Berry records it for diagnostics |
| Upstream errors | Handler and middleware errors are JSON objects shaped as `{ "error": string }` |
| Rate limiting | Per-IP GCRA limit; `429` returns `{ "error": "Rate limit exceeded" }` and `Retry-After: 60` |

The pinned server has nuanced authentication behavior: `GET /api/agents` and
`GET /api/workflows` are public, loopback requests are allowed without a key
when no key is configured, and `OPENFANG_ALLOW_NO_AUTH=1` can explicitly open a
non-loopback deployment. Berry does not depend on those exceptions. Production
configuration MUST set an API key, and the gateway MUST keep it server-side,
redact it from logs, and never return it to a browser. Query-string tokens and
the `X-API-Key` fallback supported upstream are not used.

Invalid or missing JSON rejected by Axum may produce a framework rejection
rather than the `{ "error": string }` handler shape. The adapter MUST normalize
every non-2xx response into Berry's stable error envelope.

All identifiers in path parameters below are UUID strings. All timestamps are
RFC 3339 strings. Upstream field names are `snake_case`; the adapter maps them
to Berry's public camel-case DTOs.

## Endpoint inventory

### Agent lifecycle

| Method | Path | Purpose | Success |
|---|---|---|---|
| `GET` | `/api/agents` | List registered agents | `200 AgentSummary[]` |
| `POST` | `/api/agents` | Spawn an agent from a TOML manifest | `201 SpawnAgentResponse` |
| `GET` | `/api/agents/{agentId}` | Read one agent's runtime configuration | `200 AgentDetail` |
| `PATCH` | `/api/agents/{agentId}` | Partially update supported agent fields | `200 PatchAgentResponse` |
| `DELETE` | `/api/agents/{agentId}` | Kill the registered runtime agent | `200 KillAgentResponse` |

Berry consumes `PATCH /api/agents/{agentId}`, not the legacy
`PUT /api/agents/{agentId}/update`. At the pinned commit, that legacy route only
parses `{ "manifest_toml": string }`, acknowledges it, and explicitly does not
apply the manifest. `DELETE` kills the active registration but does not remove
the on-disk agent definition; Berry MUST NOT describe it as permanent uninstall.

#### `GET /api/agents`

No request body or query parameters.

`AgentSummary` fields:

| Field | Type | Required | Notes |
|---|---|---:|---|
| `id` | string | yes | Agent UUID |
| `name` | string | yes | Runtime name |
| `state` | string | yes | Debug-form enum: `Created`, `Running`, `Suspended`, `Terminated`, or `Crashed` |
| `mode` | `observe \| assist \| full` | yes | Operational permission mode |
| `created_at` | string | yes | RFC 3339 |
| `last_active` | string | yes | RFC 3339 |
| `model_provider` | string | yes | Resolved provider |
| `model_name` | string | yes | Resolved model |
| `model_tier` | string | yes | Catalog tier or `unknown` |
| `auth_status` | string | yes | Provider auth status or `unknown` |
| `ready` | boolean | yes | Running and provider auth is not missing |
| `is_inferencing` | boolean | yes | Whether a kernel task is currently active |
| `profile` | string or null | yes | Manifest profile |
| `identity.emoji` | string or null | yes | Display identity |
| `identity.avatar_url` | string or null | yes | Display identity |
| `identity.color` | string or null | yes | Display identity |

#### `POST /api/agents`

Request:

| Field | Type | Required | Notes |
|---|---|---:|---|
| `manifest_toml` | string | conditionally | TOML agent manifest; maximum 1 MiB |
| `template` | string | conditionally | Used only when `manifest_toml` is empty |
| `signed_manifest` | string | no | JSON Ed25519 envelope; if present it must match `manifest_toml` |

Exactly one usable manifest source is required: a non-empty `manifest_toml`, or
a valid template name when the manifest string is empty.

```json
{
  "manifest_toml": "name = \"builder\"\n[model]\nprovider = \"vllm\"\nmodel = \"Qwen/Qwen3-Coder\""
}
```

Response `201`:

```json
{
  "agent_id": "f8957903-6534-4ca3-a218-d95e537a5076",
  "name": "builder"
}
```

Handler statuses: `400` invalid template/source, manifest, or signature
mismatch; `403` signature verification failure; `404` template not found;
`413` manifest over 1 MiB; `500` spawn failure.

#### `GET /api/agents/{agentId}`

Response `200` contains:

```json
{
  "id": "f8957903-6534-4ca3-a218-d95e537a5076",
  "name": "builder",
  "state": "Running",
  "mode": "full",
  "profile": null,
  "created_at": "2026-08-22T06:30:00Z",
  "session_id": "e4f18b99-a572-4cb2-ae60-e67ec1565a75",
  "model": { "provider": "vllm", "model": "Qwen/Qwen3-Coder" },
  "capabilities": { "tools": ["file_read"], "network": [] },
  "description": "Implements scoped changes",
  "system_prompt": "Follow the repository conventions.",
  "tags": ["engineering"],
  "identity": {
    "emoji": null,
    "avatar_url": null,
    "color": null,
    "archetype": null,
    "vibe": null,
    "greeting_style": null
  },
  "skills": [],
  "skills_mode": "all",
  "mcp_servers": [],
  "mcp_servers_mode": "all",
  "fallback_models": []
}
```

Handler statuses: `400` invalid UUID; `404` unknown agent.

#### `PATCH /api/agents/{agentId}`

The request is a partial object. Only these fields are applied; unknown fields
are silently ignored by the pinned handler.

| Field | Type | Required | Notes |
|---|---|---:|---|
| `name` | string | no | Updates registry name |
| `description` | string | no | Updates manifest description |
| `model` | string | no | Model identifier |
| `provider` | string | no | Used only with `model` |
| `system_prompt` | string | no | Updates model system prompt |

```json
{
  "description": "Handles repository changes",
  "provider": "vllm",
  "model": "Qwen/Qwen3-Coder"
}
```

Response `200`:

```json
{
  "status": "ok",
  "agent_id": "f8957903-6534-4ca3-a218-d95e537a5076",
  "name": "builder"
}
```

Handler statuses: `400` invalid UUID or invalid field value; `404` unknown
agent; `500` agent disappears during the update. Berry validates an allowlist
before dispatch so typos cannot be silently accepted.

#### `DELETE /api/agents/{agentId}`

No request body. Response `200`:

```json
{
  "status": "killed",
  "agent_id": "f8957903-6534-4ca3-a218-d95e537a5076"
}
```

Handler statuses: `400` invalid UUID; `404` unknown or already terminated.

### Agent execution, runs, and streaming

| Method | Path | Purpose | Success |
|---|---|---|---|
| `POST` | `/api/agents/{agentId}/message/stream` | Dispatch the primary Berry run and receive SSE events | `200 text/event-stream` |
| `POST` | `/api/agents/{agentId}/stop` | Cancel the agent's current execution | `200 StopAgentResponse` |
| `GET` | `/api/agents/{agentId}/session` | Reconcile conversation history | `200 AgentSession` |
| `GET` | `/api/audit/recent?n={count}` | Read recent global audit evidence | `200 AuditPage` |
| `GET` | `/api/usage` | Read current per-agent scheduler counters | `200 UsageByAgent` |

There is no durable, issue-correlated agent-run resource and no
`GET /api/runs/{runId}` endpoint at the pinned commit. Berry creates its own run
ID and persists status, events, output, usage, cost, timestamps, issue ID, and
agent ID before dispatch. Session, audit, and usage responses are reconciliation
evidence only.

#### `POST /api/agents/{agentId}/message/stream`

Request:

| Field | Type | Required | Notes |
|---|---|---:|---|
| `message` | string | yes | Maximum 64 KiB |
| `attachments` | array | no | Accepted by JSON decoding but ignored by this SSE handler at the pinned commit |
| `sender_id` | string or null | no | Optional caller identity |
| `sender_name` | string or null | no | Optional caller display name |

```json
{
  "message": "Implement the assigned issue using the attached repository context.",
  "sender_id": "berry-run:53fd2d67-cd99-4470-a328-c499bd7176e1",
  "sender_name": "Berry Gateway"
}
```

Pre-stream handler statuses: `400` invalid agent UUID; `404` unknown agent;
`413` message over 64 KiB; `500` execution could not start. Once status `200`
and the SSE body begin, failures are represented by an incomplete stream rather
than another HTTP response.

Each frame uses an explicit SSE `event` name and JSON `data`. The pinned stream
does not emit SSE `id` fields or retry hints.

| SSE event | Data schema | Berry projection |
|---|---|---|
| `chunk` | `{ "content": string, "done": false }` | Append text in arrival order |
| `tool_use` | `{ "tool": string }` | Open a tool activity; upstream omits tool-use ID and input here |
| `tool_result` | `{ "tool": string, "input": object }` | Record the tool input; despite the name, no result payload or error flag is emitted |
| `phase` | `{ "phase": string, "detail": string or null }` | Preserve as a lifecycle event |
| `done` | `{ "done": true, "usage": { "input_tokens": integer, "output_tokens": integer } }` | Close one model turn: add its usage to the run totals and record a `turn` provider event. Not the end of the stream |

The pinned stream emits `done` at the end of **every** model turn on the same
connection, not once per run: an agent that calls a tool produces
`… → done → phase → tool_use → tool_result → done → …` and the body ends with
a terminal `phase` of `done` followed by EOF. Berry therefore keeps reading
after `done`, sums the per-turn usage into the run ledger, and completes the
run when the body ends after at least one `done`. The text of the final turn
is the run result: it becomes the run summary, bounded to 5,000 bytes, and
Berry posts the full text on the issue as a comment authored by the agent, up
to the 100,000-byte comment limit with a closing note when cut (earlier turns
are progress, not the result).
Closing the connection at the first `done` leaves the agent working into a
socket nobody reads — upstream logs "Stream consumer disconnected — continuing
tool loop" — and its report never reaches Berry.

Other upstream stream events become SSE comments (`: skip`) and are not
projectable. The transport sends keep-alive comments. Berry preserves unknown
named events as raw events, treats malformed JSON or EOF before any `done` as
`interrupted`, and MUST NOT repeat the `POST` automatically because the upstream
route has no idempotency key, cursor, resume, or replay contract.

#### `POST /api/agents/{agentId}/stop`

No request body. Normal response is one of:

```json
{ "status": "ok", "message": "Run cancelled" }
```

```json
{ "status": "ok", "message": "No active run" }
```

A hand-owned agent instead returns additional `hand_deactivated`, `hand_id`, and
`instance_id` fields and message `Hand deactivated`. Handler statuses: `400`
invalid UUID; `500` stop failure. The route does not return `404` for an unknown
agent in its normal kernel path. Berry marks its run cancelled only when its
own active-run state and this response agree; `No active run` requires
reconciliation.

#### `GET /api/agents/{agentId}/session`

Optional query parameter `include_system` accepts `1`, `true`, `yes`, `TRUE`,
or `True`. Berry MUST omit it so upstream system prompts are not returned.

`AgentSession` fields:

| Field | Type | Required | Notes |
|---|---|---:|---|
| `session_id` | string | yes | UUID |
| `agent_id` | string | yes | UUID |
| `message_count` | integer | yes | Count returned after filtering |
| `raw_message_count` | integer | conditional | Present when a stored session exists |
| `context_window_tokens` | integer | yes | Current session estimate |
| `label` | string or null | conditional | Present when a stored session exists |
| `messages` | `SessionMessage[]` | yes | Conversation messages |

`SessionMessage` contains `role` (`User`, `Assistant`, or `System`) and string
`content`. It may contain `tools`, whose entries include `name`, `input`,
`running`, `expanded`, and—when a matching tool result exists—`result` and
`is_error`. It may also contain `images` entries with `file_id` and `filename`.
System messages are absent by default. Handler statuses: `400` invalid UUID;
`404` unknown agent; `500` memory load failure.

#### `GET /api/audit/recent?n={count}`

`n` defaults to `50`, invalid values also fall back to `50`, and values above
`1000` are capped. Response `200`:

```json
{
  "entries": [
    {
      "seq": 1042,
      "timestamp": "2026-08-22T06:30:00Z",
      "agent_id": "f8957903-6534-4ca3-a218-d95e537a5076",
      "action": "ToolInvoke",
      "detail": "file_read",
      "outcome": "ok",
      "hash": "a1b2c3d4e5f6"
    }
  ],
  "total": 1043,
  "tip_hash": "a1b2c3d4e5f6"
}
```

`total` is the complete log length, not the returned page size. The handler has
no cursor, lower-bound sequence, or agent filter, so Berry MUST NOT use it as a
lossless run event feed.

#### `GET /api/usage`

No request body or effective query parameters. Response `200`:

```json
{
  "agents": [
    {
      "agent_id": "f8957903-6534-4ca3-a218-d95e537a5076",
      "name": "builder",
      "total_tokens": 212000,
      "tool_calls": 87
    }
  ]
}
```

These are cumulative scheduler counters, not per-run input/output/cost totals.
Berry gets per-turn input/output tokens from each `done` and stores their sum
in its run ledger.

### Memory

| Method | Path | Purpose | Success |
|---|---|---|---|
| `GET` | `/api/memory/agents/{agentId}/kv` | List all structured KV entries | `200 { "kv_pairs": KvPair[] }` |
| `GET` | `/api/memory/agents/{agentId}/kv/{key}` | Read one entry | `200 KvPair` |
| `PUT` | `/api/memory/agents/{agentId}/kv/{key}` | Upsert one entry | `200 MemoryMutationResponse` |
| `DELETE` | `/api/memory/agents/{agentId}/kv/{key}` | Delete one entry | `200 MemoryMutationResponse` |

Critical pinned behavior: every handler ignores `{agentId}` and reads or writes
one global shared-memory namespace. The path does not validate that the agent
exists or that the ID is a UUID. Berry MUST prefix keys with its workspace and
agent binding (for example `berry:<workspaceId>:<agentId>:<logicalKey>`) and
filter list results itself. These endpoints MUST NOT be represented as isolated
per-agent storage.

`GET` list response:

```json
{
  "kv_pairs": [
    { "key": "berry:workspace:agent:preference", "value": { "tone": "brief" } }
  ]
}
```

`GET` one returns `{ "key": string, "value": any }`; a missing key returns
`404 { "error": "Key not found" }`.

`PUT` accepts any JSON body. When the body has a top-level `value`, that value
is stored; otherwise the whole body is stored. Berry always uses the explicit
wrapper:

```json
{ "value": { "tone": "brief" } }
```

Successful `PUT` returns `{ "status": "stored", "key": string }`; successful
`DELETE` returns `{ "status": "deleted", "key": string }`. Storage failures
return `500`. The pinned delete handler does not distinguish an absent key.

### Workflows

| Method | Path | Purpose | Success |
|---|---|---|---|
| `GET` | `/api/workflows` | List definitions | `200 WorkflowSummary[]` |
| `POST` | `/api/workflows` | Create a definition | `201 { "workflow_id": string }` |
| `GET` | `/api/workflows/{workflowId}` | Read a definition | `200 WorkflowDetail` |
| `PUT` | `/api/workflows/{workflowId}` | Replace a definition | `200 WorkflowMutationResponse` |
| `DELETE` | `/api/workflows/{workflowId}` | Delete a definition | `200 WorkflowMutationResponse` |
| `POST` | `/api/workflows/{workflowId}/run` | Execute synchronously | `200 WorkflowRunResponse` |
| `GET` | `/api/workflows/{workflowId}/runs` | Read workflow-run summaries, subject to pinned defect below | `200 WorkflowRunSummary[]` |

#### Workflow write request

`POST` and `PUT` accept the same shape:

| Field | Type | Required | Default/notes |
|---|---|---:|---|
| `name` | string | no | `unnamed` |
| `description` | string | no | Empty string |
| `steps` | `WorkflowStepInput[]` | yes | Missing/non-array returns `400` |

`WorkflowStepInput` is a flat write DTO:

| Field | Type | Required | Default/notes |
|---|---|---:|---|
| `name` | string | no | `step` |
| `agent_id` | string | conditionally | Preferred when both identifiers are supplied |
| `agent_name` | string | conditionally | Required when `agent_id` is absent |
| `prompt` | string | no | `{{input}}` |
| `mode` | `sequential \| fan_out \| collect \| conditional \| loop` | no | Unknown values become `sequential` |
| `condition` | string | no | Used by `conditional`; empty default |
| `max_iterations` | integer | no | Used by `loop`; default `5`, narrowed to `u32` upstream |
| `until` | string | no | Used by `loop`; empty default |
| `timeout_secs` | integer | no | Default `120` |
| `error_mode` | `fail \| skip \| retry` | no | Unknown values become `fail` |
| `max_retries` | integer | no | Used by `retry`; default `3`, narrowed to `u32` upstream |
| `output_var` | string | no | Stores the step output under a variable |

```json
{
  "name": "implement-and-review",
  "description": "Execute an issue and review the result",
  "steps": [
    {
      "name": "implement",
      "agent_id": "f8957903-6534-4ca3-a218-d95e537a5076",
      "prompt": "{{input}}",
      "mode": "sequential",
      "timeout_secs": 120,
      "error_mode": "fail",
      "output_var": "implementation"
    }
  ]
}
```

Berry validates all defaults, enums, and integer ranges before sending because
the pinned handler silently coerces several invalid or missing values.

#### Workflow responses

`GET /api/workflows` returns summaries with `id`, `name`, `description`,
integer `steps` (a count, not an array), and `created_at`.

`GET /api/workflows/{workflowId}` returns `id`, `name`, `description`, a
serialized `steps` array, and `created_at`. The read step schema is not symmetric
with the flat write DTO: `agent` is `{ "id": string }` or `{ "name": string }`,
`prompt_template` replaces `prompt`, and parameterized enum variants serialize
as nested objects (for example `{ "conditional": { "condition": "ok" } }` and
`{ "retry": { "max_retries": 3 } }`). The gateway MUST adapt this response to
its own stable DTO before exposing it.

`PUT` returns:

```json
{ "status": "updated", "workflow_id": "b09c8852-ac75-42aa-9db0-aefb8624ae91" }
```

`DELETE` returns the same shape with status `removed`. For get, update, and
delete, an invalid UUID returns `400`; an unknown workflow returns `404`.

#### `POST /api/workflows/{workflowId}/run`

Request:

```json
{ "input": "Implement BERR-17" }
```

Missing or non-string `input` becomes an empty string. Success is synchronous:

```json
{
  "run_id": "4c549821-0a7e-4374-9000-5062e24ed41a",
  "output": "Completed",
  "status": "completed"
}
```

Handler statuses: `400` invalid workflow UUID; `500` includes unknown workflow
and any execution failure. There is no asynchronous acceptance response and no
idempotency key, so Berry MUST NOT retry after an ambiguous response.

#### `GET /api/workflows/{workflowId}/runs`

The response items contain `id`, `workflow_name`, `state`
(`pending \| running \| completed \| failed`), `steps_completed`, `started_at`,
and nullable `completed_at`.

At the pinned commit, the handler ignores `{workflowId}` and calls the engine
with no filter, returning runs for every workflow. It also accepts any path
string without UUID validation. Berry MUST filter by a separately known
workflow identity where possible and MUST NOT use this endpoint as an
authorization boundary or as the durable Berry run ledger. This is an upstream
defect that adapter contract tests must pin until an upgrade fixes it.

## Error, retry, and idempotency policy

The upstream surface has no `Idempotency-Key` contract.

| Condition | Berry behavior |
|---|---|
| `400`, `403`, `404`, `413`, or JSON rejection | Normalize and do not retry |
| `401` | Treat as integration configuration failure; do not retry |
| `429` | Honor `Retry-After` only for safe reads and idempotent memory writes, with bounded attempts and jitter |
| `500` or network failure on `GET` | Bounded exponential backoff |
| `500` or ambiguous network failure on create, execute, or stream dispatch | Do not retry automatically; preserve unresolved/interrupted state for reconciliation |
| Stream EOF before any `done` | Persist partial events and mark the Berry run `interrupted` |
| Stream EOF after at least one `done` | Complete the run: sum per-turn usage, record the final turn's text as the result, post it as the agent's comment |
| Stream open past the dispatch bound | Close it, keep what arrived, and mark the run `STREAM_TIMEOUT` for reconciliation; never re-`POST`. The bound is `orchestration.DispatchStreamTimeout` (2 h), which both binaries pass to the SSE client (`openfang.WithStreamTimeout`); the Temporal dispatch activity allows a few minutes beyond it so the client's close is what ends the stream and the ledger records it before Temporal times the activity out. It covers the whole multi-turn body, not one turn |

Caveat on the EOF rule: the end of the body is the only completion signal (the
terminal `phase` of `done` is recorded like any phase but not relied on), so a
connection dropped between one turn's `done` and the next is indistinguishable
from a clean end. Such a run is recorded `succeeded` with the text of the last
turn that said anything as its result. Reading for the terminal phase would
not close the gap, because the drop can come before it too.

Memory `PUT` is safe to retry because it replaces the value at a deterministic
key. Agent patch requests are not automatically retried even when their fields
appear idempotent, because the pinned handler can partially apply fields before
returning an error. Deletes may be repeated only through an explicit
reconciliation action that understands `404`/missing semantics.

## Adapter acceptance checks

The adapter contract test suites — the Go adapter under
`server/internal/openfang`, and `apps/gateway/src/openfang` for as long as it
remains the compatibility oracle — MUST verify the pinned behavior, including:

1. bearer authentication, `x-request-id`, error normalization, and `429` handling;
2. agent list/detail state casing and agent patch allowlisting;
3. manifest size/validation failures and kill-versus-uninstall semantics;
4. incremental SSE delivery for `chunk`, `tool_use`, `tool_result`, `phase`, and `done`, across several turns on one connection;
5. interrupted-stream handling (EOF before any `done`) without automatic re-dispatch;
6. shared memory namespace behavior despite the `{agentId}` path;
7. asymmetric workflow write/read step shapes;
8. the unfiltered workflow-runs defect; and
9. the absence of a durable upstream agent-run resource.

## Versioning notes

Most mapped upstream routes use the unversioned `/api` prefix. Berry therefore
isolates all upstream shapes in one adapter and does not relay raw upstream DTOs
to clients. Any change to paths, authentication, status codes, payload fields,
enum casing, shared-memory behavior, workflow filtering, or SSE framing is a
contract change even when the upstream URL remains unchanged.
