# What the server serves, and what it does not

The authoritative list is always `src/index.ts` — the composition root
registers exactly the mounts below. This file is a reader's index to it. If the
two ever disagree, `src/index.ts` is right and this file is stale; regenerate
the served list from the mount prefixes with:

```bash
grep -rhoE "prefix: '/[^']+'" src/mounts/*.ts | sort -u
```

For how the server is laid out, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Served

Every prefix `src/index.ts` registers today:

```
/api/v1/agents        /api/v1/approvals     /api/v1/attachments   /api/v1/auth
/api/v1/boards        /api/v1/catalogs      /api/v1/comments      /api/v1/config
/api/v1/conversations /api/v1/editor        /api/v1/events        /api/v1/goals
/api/v1/inbox         /api/v1/integrations  /api/v1/invitations   /api/v1/issues
/api/v1/me            /api/v1/plans         /api/v1/projects      /api/v1/runs
/api/v1/search        /api/v1/tokens        /api/v1/views         /api/v1/webhooks
/api/v1/workspaces    /api/v1/github
/health  /metrics  /ready  /readyz
```

If a prefix in this block stops answering, that is a bug, not a scope decision.

## Not served

These have no mount and answer 404. They are product areas the server does not
implement, not routes that broke.

| Section | API prefixes | Note |
| --- | --- | --- |
| Automations | `/api/v1/workflows`, `/api/v1/workflow-runs`, `/api/v1/hooks` | No mount. Includes the `workflows`, `workflow`, and `workflow-runs` screens. |
| Meetings | — | No section or prefix exists. |
| Analytics | — | The rail links it, but no prefix exists. |

## Deferred routes inside served mounts

A mount answering does not mean every route under its prefix does.

| Route | Why it is not registered |
| --- | --- |
| `POST /api/v1/projects/:id/generated-issues` | Decomposed a project with an agent. Planning a project now produces the same tasks through a plan, which also produces the goal that groups them, so the route and its frontend button were retired. |
| `POST /api/v1/agents/:id/ask` | A chat completion passed through to the old runtime. Nothing in the product calls it, and what it should mean now that agents run in-process is undecided. |

## What stays entangled across scope lines

Excluding a section does not excuse the rest from knowing about it:

- **`/api/v1/events`** is the shared realtime stream. It replays `outbox_events`
  from Postgres and is only *woken* by the relay, so it carries every feature's
  events without depending on any of their code.
- **`issue.activeRunId`** is a plain column read on the issue resource; none of
  the run machinery is needed to return it.
