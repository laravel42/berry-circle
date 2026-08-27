# What is not being migrated

Decided 2026-08-27. Everything under **AUTOMATE** is being reimplemented rather
than ported, so porting it to TypeScript first would be work thrown away twice.

## Excluded

| Section | API prefixes | Note |
|---|---|---|
| Chat | `/api/v1/conversations` | |
| Automations | `/api/v1/workflows`, `/api/v1/workflow-runs`, `/api/v1/hooks` | includes the `workflows`, `workflow` and `workflow-runs` screens |
| Runs | `/api/v1/runs` | the run ledger and its SSE stream |
| Approvals | `/api/v1/approvals` | |
| Meetings | — | no section or prefix exists yet |
| Analytics | — | no section or prefix exists yet |

These prefixes stay on the Go server until AUTOMATE is rebuilt. They are not
listed in `TYPESCRIPT_ROUTES`, and the proxy's catch-all sends them to Go.

## What that leaves entangled

Excluding a section does not excuse the rest from knowing about it, and three
places still reach across the line:

- **`/api/v1/boards/:boardId/runs`** and **`/api/v1/issues/:issueRef/runs`** are
  nested under mounts that *are* migrated. The routing map matches a single
  path segment for those prefixes so anything deeper falls through to Go.
- **`/api/v1/events`** is the shared realtime stream, used by runs as well as by
  boards and issues. It is ported and routed: it replays `outbox_events` from
  PostgreSQL and is only *woken* by Valkey, so it carries the excluded lane's
  run events without depending on any of the excluded code.
- **`issue.activeRunId`** appears on the issue resource and is served by the
  TypeScript issues mount. It is a plain column read; nothing in the run
  machinery is needed to return it.

## Deferred, not excluded

| | Why |
|---|---|
| `POST /api/v1/projects/:id/generated-issues` | decomposes a project with an agent; waits for ADK |
| `POST /api/v1/agents/:id/ask` | a chat completion through OpenFang; nothing in the product calls it, and what it should mean under ADK is its own decision |
| `/api/v1/plans` | the planner is being refactored, so porting it first would be work thrown away twice — the same reason AUTOMATE is excluded |
| `GET\|POST /api/v1/issues/:ref/attachments` | routing that path moves the upload with it, and the upload is a multipart body staged to disk with an idempotency fingerprint taken over the file's own bytes — ~700 lines nothing in the product calls. The four routes that reach an attachment by its own id did move. |

## Nothing still open

`/api/v1/issues/:issueRef/reviews` — the AutoGate peer review — was the last
undecided entry. It is ported: it belongs to the auto-gate loop, which is not
AUTOMATE and is live, and it reads `issue_auto_reviews` directly.
