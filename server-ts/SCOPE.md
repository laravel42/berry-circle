# What the server does not serve

Last checked against `src/index.ts` on 2026-09-01.

This file was written on 2026-08-27, when AUTOMATE was excluded from the
TypeScript migration and most of this list was accurate. It has drifted: four of
the prefixes it called unserved have since been built, and a reader trusting it
would conclude the product is smaller than it is. What follows is the mount
table as it stands, not the plan as it was.

## Served

Every prefix `src/index.ts` registers:

```
/api/v1/agents        /api/v1/approvals     /api/v1/attachments   /api/v1/auth
/api/v1/boards        /api/v1/catalogs      /api/v1/comments      /api/v1/config
/api/v1/conversations /api/v1/events        /api/v1/goals         /api/v1/inbox
/api/v1/integrations  /api/v1/invitations   /api/v1/issues        /api/v1/me
/api/v1/plans         /api/v1/projects      /api/v1/runs          /api/v1/search
/api/v1/tokens        /api/v1/views         /api/v1/workspaces
/health  /metrics  /ready  /readyz
```

Four of those — `conversations`, `runs`, `approvals` and `plans` — were listed
here as excluded or deferred long after they began answering. If a prefix in
this block ever stops working, that is a bug, not scope.

## Not served

| Section | API prefixes | Note |
|---|---|---|
| Automations | `/api/v1/workflows`, `/api/v1/workflow-runs`, `/api/v1/hooks` | no mount; includes the `workflows`, `workflow` and `workflow-runs` screens |
| Meetings | — | no section or prefix exists |
| Analytics | — | the rail links it, but no prefix exists |

## Deferred routes inside served mounts

A mount answering does not mean every route under it does.

| | Why |
|---|---|
| `POST /api/v1/projects/:id/generated-issues` | decomposed a project with an agent. Not registered. Its frontend button was removed on 2026-09-01: planning a project produces the same tasks through a plan, which also produces the goal that groups them. `loadGitHubRepositories`' sibling client remains in `frontend/lib/projects.ts`, marked unused |
| `POST /api/v1/agents/:id/ask` | a chat completion passed through to the old runtime. Not registered, and nothing in the product calls it |

## What stays entangled

Excluding a section does not excuse the rest from knowing about it:

- **`/api/v1/events`** is the shared realtime stream. It replays
  `outbox_events` from PostgreSQL and is only *woken* by Valkey, so it carries
  every lane's events without depending on any of their code.
- **`issue.activeRunId`** is a plain column read on the issue resource; none of
  the run machinery is needed to return it.
