# Berry ↔ OpenFang Integration Specification

This document maps every OpenFang-backed Berry capability in the BERR-10 scope to the upstream API. Berry is the product and persistence layer; OpenFang remains the execution substrate.

## Scope and source baseline

In scope: agents, agent runs, memory, workflows, OpenAI-compatible chat/completions, and SSE execution streams. Berry-native issues, projects, cycles, comments, team roles, and review gates have no OpenFang mapping by design and remain in Berry's PostgreSQL product model.

Endpoint names and shapes were checked against the upstream API reference and router at OpenFang commit [`acf2587e`](https://github.com/RightNow-AI/openfang/tree/acf2587e46be174c10200489c9a2d23a39a98aeb). Revalidate this contract before upgrading the deployed OpenFang version.

## Feature mapping

| Berry feature | OpenFang endpoint(s) | Gaps / Berry responsibility |
|---|---|---|
| **Agents** | `GET /api/agents`<br>`POST /api/agents`<br>`GET /api/agents/{id}`<br>`PATCH /api/agents/{id}`<br>`DELETE /api/agents/{id}` | No endpoint gap for the required lifecycle. Berry stores its product-facing agent identity, workspace/team bindings, and the OpenFang agent ID. `DELETE` kills the runtime registration but does not permanently uninstall its on-disk definition. |
| **Runs** | Dispatch: `POST /api/agents/{id}/message/stream`<br>Cancel active execution: `POST /api/agents/{id}/stop`<br>Conversation evidence: `GET /api/agents/{id}/session`<br>Global audit evidence: `GET /api/audit/recent`<br>Usage evidence: `GET /api/usage`<br>Unfiltered workflow-run evidence: `GET /api/workflows/{id}/runs` | **GAP — no durable agent-run resource.** OpenFang exposes an active execution and supporting evidence, but no issue-correlated `GET /api/agents/{id}/runs` or `GET /api/runs/{id}` resource. Berry must assign its own run ID before dispatch and persist status, steps/tool activity, output, token usage, cost, timestamps, issue ID, and agent ID. Audit, session, usage, and the pinned unfiltered workflow-runs API are reconciliation evidence, not substitutes for that record. |
| **Memory** | `GET /api/memory/agents/{id}/kv`<br>`GET /api/memory/agents/{id}/kv/{key}`<br>`PUT /api/memory/agents/{id}/kv/{key}`<br>`DELETE /api/memory/agents/{id}/kv/{key}` | **GAP — the pinned handlers ignore `{id}` and use one shared namespace.** Berry prefixes and filters keys by workspace/agent. Berry-owned issue/project context remains in Berry and is included explicitly at dispatch. |
| **Workflows** | `GET /api/workflows`<br>`POST /api/workflows`<br>`GET /api/workflows/{id}`<br>`PUT /api/workflows/{id}`<br>`DELETE /api/workflows/{id}`<br>`POST /api/workflows/{id}/run`<br>`GET /api/workflows/{id}/runs` | Definition lifecycle and synchronous execution are available. **GAP — the pinned runs handler ignores `{id}` and returns all workflow runs.** The pinned router exposes get/update/delete even though its endpoint summary omits them; adapter tests must cover router behavior. |
| **Chat/completions** | `POST /v1/chat/completions`<br>`GET /v1/models` | No endpoint gap for OpenAI-compatible chat and agent-backed model discovery. This surface is for compatibility clients; Berry's issue execution path uses the agent SSE endpoint so tool events remain visible. |
| **SSE streams** | `POST /api/agents/{id}/message/stream` | The stream provides `chunk`, `tool_use`, `tool_result`, `phase`, and `done` events; `done` closes each model turn, and the body ends after the last one. **GAP — no documented resume cursor or replay endpoint.** Berry must persist events as received and must not re-POST automatically after an ambiguous disconnect. |

Coverage check: all six capability groups named by BERR-10 appear above, and every capability without a complete backing endpoint is explicitly marked **GAP**.

### Agent workspace ownership

OpenFang exposes one flat agent list; Berry scopes agents to a workspace. Those
models do not reconcile, because `agents.openfang_agent_id` is globally unique
and the projection upsert only applies within the owning workspace:

```sql
ON CONFLICT (openfang_agent_id) DO UPDATE ...
  WHERE agents.workspace_id = EXCLUDED.workspace_id
```

A conflict originating in a different workspace is therefore skipped silently —
no error, no row. **A runtime agent can belong to exactly one Berry workspace:
whichever projected it first.**

Decision, 2026-08-24: accept one owning workspace. Berry is single-workspace in
this release, so the constraint costs nothing today, and a global unique id
keeps the mapping between a Berry agent and its upstream agent unambiguous.

Consequences to know:

- Startup seeding reports what a workspace actually holds, not what the runtime
  offered, and says so when a workspace receives nothing because another owns
  those agents. Reporting the offered count would claim a successful seed for a
  workspace with no agents.
- A second workspace will have no runtime agents and falls back to its built-in
  orchestrator for all intake. That is correct under this decision, not a
  failure.
- Making agents usable from every workspace requires re-keying the unique index
  to `(workspace_id, openfang_agent_id)` so each workspace holds its own
  projection. That is a schema change touching run admission, which validates
  `agents.workspace_id` against the run's workspace, and needs its own record.

## Trigger and data flow

1. Assignment or an agent-owned workflow transition creates a Berry run in `queued` state with a Berry-generated run ID.
2. The gateway resolves the bound OpenFang agent ID, builds the issue-context message, and calls `POST /api/agents/{id}/message/stream`.
3. After OpenFang accepts the request, Berry marks the run `running` and consumes the SSE response.
4. Berry appends stream events to the run and derives step/tool activity. Each `done` closes one model turn: Berry adds that turn's usage to the run totals, records a `turn` provider event, and keeps reading, because the pinned upstream starts the next turn on the same connection whenever the agent called a tool.
5. The stream ending after at least one `done` makes the run `succeeded`. The final turn's text is the run result: it becomes the run summary and is posted on the issue as a comment authored by the agent. A stream ending before any `done` is `interrupted`. An HTTP/stream error makes the run `failed` or `interrupted` according to whether the failure is definitive. The whole stream is bounded end to end by `orchestration.DispatchStreamTimeout` (2 h), which both binaries pass to the SSE client; the Temporal dispatch activity allows a few minutes beyond it so the client's close is what ends an overlong stream, and past it the run is `STREAM_TIMEOUT` and reconcilable. A user cancellation calls `POST /api/agents/{id}/stop` and records `cancelled` only after the response confirms cancellation; a stream that ends cleanly while that cancellation is pending is left to the cancellation rather than recorded as success.
6. Session, audit, and usage endpoints may support operator reconciliation, but they do not replace Berry's run ledger because they lack the Berry issue/run correlation.

Direction is Berry Gateway → OpenFang for requests and OpenFang → Berry Gateway for HTTP responses/SSE events. Browsers call the Berry gateway only; they do not receive the upstream credential or call OpenFang directly.

## Authentication

When the deployed OpenFang instance has an API key configured, the gateway sends it as:

```http
Authorization: Bearer <configured-api-key>
```

The credential is server-side configuration, must be redacted from logs, and must never be persisted in Berry product records or returned to a browser. The pinned middleware exposes some reads publicly, including `/api/health`, `GET /api/agents`, and `GET /api/workflows`, and permits unauthenticated loopback traffic when no API key is configured. Berry does not depend on those exceptions: it sends the bearer credential on every upstream call and proxies access through its own authorization rules. Protected routes return `401` for a missing or invalid credential.

## Payload contracts

These are the minimum upstream shapes Berry depends on. The normative field-level contract, including pinned-source discrepancies and status codes, is [OpenFang API Contract Consumed by Berry](../api/openfang-gateway-consumption.md). Fields not listed are passed through only after an explicit contract update.

| Operation | Request | Success response Berry consumes |
|---|---|---|
| Spawn agent | `POST /api/agents` with `{ "manifest_toml": string }` | `201` with `{ "agent_id": string, "name": string }` |
| Update agent | `PATCH /api/agents/{id}` with any supported subset of `{ "name"?: string, "description"?: string, "model"?: string, "provider"?: string, "system_prompt"?: string }` | `200` with `{ "status": "ok", "agent_id": string, "name": string }` |
| Dispatch blocking agent message | `POST /api/agents/{id}/message` with `{ "message": string }` | `200` with `{ "response": string, "input_tokens": number, "output_tokens": number, "iterations": number }` |
| Dispatch streaming agent message | `POST /api/agents/{id}/message/stream` with `{ "message": string }`; response content type is `text/event-stream` | SSE events defined below |
| Set memory value | `PUT /api/memory/agents/{id}/kv/{key}` with `{ "value": JSON value }` | `200` with `{ "status": "stored", "key": string }` |
| Create workflow | `POST /api/workflows` with `{ "name": string, "description"?: string, "steps": WorkflowStep[] }` | `201` with `{ "workflow_id": string }` |
| Read workflow | `GET /api/workflows/{id}` | `200` with `{ "id": string, "name": string, "description": string, "steps": WorkflowStep[], "created_at": string }` |
| Replace workflow | `PUT /api/workflows/{id}` with `{ "name": string, "description"?: string, "steps": WorkflowStep[] }` | `200` with `{ "status": "updated", "workflow_id": string }` |
| Delete workflow | `DELETE /api/workflows/{id}` | `200` with `{ "status": "removed", "workflow_id": string }` |
| Run workflow | `POST /api/workflows/{id}/run` with `{ "input": string }` | `200` with `{ "run_id": string, "output": string, "status": string }` |
| Chat completion | `POST /v1/chat/completions` with OpenAI-compatible `{ "model": string, "messages": Message[], "stream"?: boolean }` | OpenAI-compatible completion JSON, or SSE chunks when `stream: true` |

A workflow step may identify an agent by `agent_id` or `agent_name` and includes `name`, `prompt`, `mode`, `timeout_secs`, `error_mode`, and optional retry/flow-control fields. Berry must validate its authored workflow payload against the upstream version before sending it.

## SSE event contract and run projection

| Event | Minimum data used by Berry | Berry projection |
|---|---|---|
| `chunk` | `{ "content": string, "done": false }` | Append output delta in arrival order. |
| `tool_use` | `{ "tool": string }` | Open a tool step/event. |
| `tool_result` | `{ "tool": string, "input": object }` | Close or enrich the matching tool step. The current upstream example exposes tool input, not a guaranteed full tool output; Berry must not assume a result body exists. |
| `phase` | `{ "phase": string, "detail": string or null }` | Preserve the execution lifecycle transition. |
| `done` | `{ "done": true, "usage": { "input_tokens": number, "output_tokens": number } }` | Close the current model turn: add its usage to the run totals and start a new output turn. Emitted once per turn; not terminal on its own. |

The run completes when the stream ends after at least one `done`. Usage is summed over turns, and the final turn's text is the run result: the run summary, bounded to 5,000 bytes, and the body of a comment Berry posts on the issue authored as the agent, carrying the full text up to the 100,000-byte comment limit with a closing note when cut. Because the end of the body is the only completion signal, a connection dropped between one turn's `done` and the next reads the same as a clean end and is recorded as success with the text of the last turn that said anything; the terminal `phase` of `done` is kept as a phase event but cannot close that gap. Unknown event names or additional fields are preserved as raw run events and ignored by the projection until this contract is updated. Malformed JSON or a stream ending before any `done` marks the Berry run `interrupted`; it must not be reported as successful.

## Errors, retries, and idempotency

OpenFang handler and middleware errors use `{ "error": string }`; malformed JSON rejected by the framework can use a different rejection body. Berry maps every non-2xx upstream response into its stable gateway error envelope and records the upstream `x-request-id` for operators without exposing credentials or sensitive payloads.

| Upstream result | Gateway behavior |
|---|---|
| `400` | Reject as a validation/request error; do not retry. |
| `401` | Fail as integration authentication/configuration error; do not retry. |
| `404` | Report the missing mapped resource; do not retry. |
| `429` | For safe operations only, retry after the `Retry-After` delay with bounded attempts and jitter. |
| `500` or network failure | Retry boundedly only when the operation is known not to create/execute work; otherwise leave the Berry operation unresolved/interrupted for reconciliation. |

The upstream reference documents no idempotency-key contract. Therefore:

- Berry may retry `GET` requests and idempotent memory `PUT` requests using bounded exponential backoff.
- Berry must not automatically retry `POST /api/agents`, `POST /api/workflows`, workflow execution, agent message/stream dispatch, or chat completion after an ambiguous response; doing so may duplicate a resource or execution.
- Berry must not reconnect an interrupted agent stream by repeating the POST. It preserves partial events, marks the run `interrupted`, and offers an explicit new-run action after reconciliation.
- Berry-generated run IDs provide product-level deduplication inside Berry, but they are not sent as an upstream idempotency guarantee.

## Versioning notes

OpenFang's mapped REST paths use `/api` without a version segment, while the compatibility surface uses `/v1`. Berry isolates these paths behind its gateway adapter, pins the deployed upstream revision, and treats changes to paths, payloads, SSE event shapes, status codes, or authentication as contract changes requiring this document and adapter tests to be updated together.
