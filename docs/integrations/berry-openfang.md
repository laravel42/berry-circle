# Berry ↔ OpenFang Integration Specification

This document maps Berry's product features to the underlying OpenFang APIs that power them. Berry acts as a product layer and gateway over OpenFang, adapting its execution substrate into a Linear-shaped team workspace.

## Feature Mapping

| Berry Feature | OpenFang Endpoint(s) | Gaps / Notes |
|---|---|---|
| **Agents** | `GET /api/agents`<br>`POST /api/agents`<br>`GET /api/agents/{id}`<br>`PUT /api/agents/{id}/update`<br>`DELETE /api/agents/{id}` | None. OpenFang provides full lifecycle management for agents. |
| **Runs** | ⚠️ *No backing endpoint for agent runs* | **GAP FLAGGED:** OpenFang does not have a concept of an "agent run" as a distinct historical entity. It provides workflow runs (`GET /api/workflows/{id}/runs`), agent conversation history (`GET /api/agents/{id}/session`), and global audit trails (`GET /api/audit/recent`), but no direct `GET /api/agents/{id}/runs` endpoint. Berry must construct and persist its own run records (tracking steps, tool calls, tokens, and cost against an issue) in its own PostgreSQL database by listening to the SSE execution stream. |
| **Memory** | `GET /api/memory/agents/{id}/kv`<br>`GET /api/memory/agents/{id}/kv/{key}`<br>`PUT /api/memory/agents/{id}/kv/{key}`<br>`DELETE /api/memory/agents/{id}/kv/{key}` | None. Direct mapping to OpenFang's KV memory substrate. |
| **Workflows** | `GET /api/workflows`<br>`POST /api/workflows`<br>`POST /api/workflows/{id}/run`<br>`GET /api/workflows/{id}/runs` | None. |
| **chat/completions** | `POST /v1/chat/completions`<br>`GET /v1/models` | None. OpenFang exposes a standard OpenAI-compatible API. |
| **SSE streams** | `POST /api/agents/{id}/message/stream` | None. The stream provides real-time `chunk`, `tool_use`, `tool_result`, and `done` (with token usage) events, which Berry consumes to track run progress. |

## Data Flow & Integration Behavior

- **Trigger:** A user assigns an issue to an agent in Berry.
- **Data Flow:** Berry Gateway → OpenFang API. The gateway translates the issue context into a prompt/message and dispatches it to the assigned OpenFang agent.
- **Authentication:** The gateway communicates with OpenFang using a Bearer token (`OPENFANG_API_KEY`) set in its environment, passed via the `Authorization: Bearer <key>` header.
- **Run Tracking:** Since OpenFang does not natively store agent run objects, Berry's gateway POSTs to `/api/agents/{id}/message/stream`, processes the SSE events (`tool_use`, `tool_result`, `chunk`, `done`), and stores this structured run data in its PostgreSQL database to display on the issue board.
