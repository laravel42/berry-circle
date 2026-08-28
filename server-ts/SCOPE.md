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

These prefixes are not served. Requests to them answer 404 until AUTOMATE is
rebuilt.

## What that leaves entangled

Excluding a section does not excuse the rest from knowing about it, and three
places still reach across the line:

- **`/api/v1/boards/:boardId/runs`** and **`/api/v1/issues/:issueRef/runs`** are
  nested under mounts that *are* served. The parent mounts answer their own
  routes; these two nested paths are not among them.
- **`/api/v1/events`** is the shared realtime stream, used by runs as well as by
  boards and issues. It is served: it replays `outbox_events` from PostgreSQL
  and is only *woken* by Valkey, so it carries the excluded lane's run events
  without depending on any of the excluded code.
- **`issue.activeRunId`** appears on the issue resource and is served by the
  TypeScript issues mount. It is a plain column read; nothing in the run
  machinery is needed to return it.

## Deferred, not excluded

| | Why |
|---|---|
| `POST /api/v1/projects/:id/generated-issues` | decomposes a project with an agent; waits for ADK |
| `POST /api/v1/agents/:id/ask` | a chat completion passed through to the old runtime; nothing in the product calls it, and what it should mean now is its own decision |
| `/api/v1/plans` | the planner is being refactored, so porting it first would be work thrown away twice — the same reason AUTOMATE is excluded |
| `GET\|POST /api/v1/issues/:ref/attachments` | the upload is a multipart body staged to disk with an idempotency fingerprint taken over the file's own bytes — ~700 lines nothing in the product calls. The four routes that reach an attachment by its own id are served. |

## Nothing still open

`/api/v1/issues/:issueRef/reviews` — the AutoGate peer review — was the last
undecided entry. It is served: it belongs to the auto-gate loop, which is not
AUTOMATE and is live, and it reads `issue_auto_reviews` directly.
