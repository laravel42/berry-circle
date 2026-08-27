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
  boards and issues. It was not on the excluded list and is still to be decided.
- **`issue.activeRunId`** appears on the issue resource and is served by the
  TypeScript issues mount. It is a plain column read; nothing in the run
  machinery is needed to return it.

## Still open

`/api/v1/reviews` — the AutoGate peer review, reached at
`/api/v1/issues/:issueRef/reviews`. It belongs to the automation flow but was
not named in the exclusion, so it is neither ported nor formally excluded yet.
