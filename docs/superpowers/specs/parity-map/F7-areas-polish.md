# F7 — areas polish: skills, squads, autopilots, usage, dashboard, runtimes

What this workstream owns, what the branch already had when the audit was taken, and what
was built on top of it. Every line describes behaviour in Berry's own words; the code is
Berry's own design system, component library and API clients throughout.

Audit taken on `fe/F7-areas-polish`, branched from `feat/multica-parity`.

Legend: **present** — the behaviour is there; **partial** — some of it is there, with what
is missing named; **missing** — nothing of it exists yet.

## Skills

Screens: `frontend/app/[orgId]/skills/**`, `frontend/components/common/skills/**`,
client `frontend/lib/skills.ts`, server `server-ts/src/mounts/skills.ts`.

| Behaviour | Audit | Note |
| --- | --- | --- |
| Search | **present** | Debounced `q` on the list, passed to `GET /api/v1/skills`. |
| Filter by usage (in use / unused) | **missing** | The list never learns which agents carry a skill. |
| Filter by origin (manual, GitHub, zip) | **missing** | `source.kind` is rendered as a column only. |
| Filter by agent | **partial** | The client accepts `agentId`, no screen sets it. |
| Filter by creator | **missing** | `skills.created_by` is stored but never serialized. |
| Sort | **missing** | Server orders by name; the list has no control. |
| Column picker | **missing** | Three fixed columns. |
| Row menu: add to agent (mine / others) | **missing** | No row menu at all; binding exists only in the agent's own skills tab. |
| Row menu: update from source | **partial** | Only on the detail page, GitHub only, without a warning. |
| Row menu: delete | **partial** | Only on the detail page. |
| Bulk add to agents | **missing** | No selection model. |
| Bulk update with progress | **missing** | — |
| Bulk delete | **missing** | — |
| Lock icon for skills the user cannot edit | **missing** | The workspace role is never consulted in this area. |
| New skill — manual, unique name + description | **partial** | Name shape is validated client-side; uniqueness surfaces only as a server 409 toast. |
| New skill — import a zip | **partial** | Posts the zip straight to the server; no local SKILL.md / size / count check and no preview. |
| New skill — import a folder | **missing** | — |
| New skill — from a GitHub URL | **present** | `POST /api/v1/skills/import`. |
| Detail opens as `?view=` | **missing** | Detail is a separate route, `/skills/<id>`. |
| Overview: name + description synced with the SKILL.md frontmatter | **partial** | Both are editable fields; nothing keeps them in step with the instructions' frontmatter. |
| Overview: labels | **present** | Comma-separated input. |
| Overview: agents using it | **missing** | Not served. |
| Files: a tree | **partial** | A flat list of paths. |
| Files: add by path with the path rules | **missing** | Files can only arrive by import. |
| Files: rename, delete (never the main file) | **missing** | — |
| Files: preview / edit / raw modes | **partial** | A read-only `<pre>`. |
| Save bar summarising changes | **missing** | One Save button, no summary, no discard. |
| Conflict banner | **missing** | A concurrent save is silently overwritten. |
| Update from source warns about local edits | **missing** | Refresh runs immediately. |

## Squads

Screens: `frontend/app/[orgId]/squads/**`, `frontend/components/common/squads/**`,
client `frontend/lib/squads.ts`, server `server-ts/src/mounts/squads.ts`.

| Behaviour | Audit | Note |
| --- | --- | --- |
| Create modal: name, description, leader | **present** | In `squads-list.tsx`. |
| Create modal: avatar | **missing** | No column for it. |
| Create modal: description counter | **missing** | — |
| Create modal: initial members | **missing** | The roster is set after creation. |
| Scope mine / all | **missing** | `created_by` is stored, never serialized. |
| Filters (leader, creator) | **missing** | — |
| Sort | **missing** | Server orders by name. |
| Columns | **missing** | Three fixed columns. |
| Archive, explaining that issues move to the leader | **partial** | Archive lives on the detail page; the copy talks about members, not about issues. |
| Detail: left panel with avatar, inline rename, description, details | **missing** | One column of form fields. |
| Members: leader marker, type, status, current issues, last active | **partial** | Type only. |
| Members: make leader | **partial** | Only through the leader `<select>` in the details form. |
| Members: remove, inline role edit | **present** | Both in the roster list. |
| Members: add member as a two-step search | **partial** | A single flat `<select>` of every agent and person. |
| Members: create an agent for this squad | **missing** | — |
| Instructions tab, unsaved indicator, save guard | **missing** | Squads have no instructions at all — no column, no field. |

## Autopilots

Screens: `frontend/app/[orgId]/autopilots`, `frontend/app/[orgId]/autopilot/[autopilotId]`,
`frontend/components/common/autopilots/**`, client `frontend/lib/autopilots.ts`,
server `server-ts/src/mounts/autopilots.ts`.

| Behaviour | Audit | Note |
| --- | --- | --- |
| List scope all / active / paused | **missing** | One flat list. |
| Filters (assignee, mode, trigger kind, creator) | **missing** | — |
| Sort, columns | **missing** | Four fixed columns. |
| Row menu (pause/resume, delete with a confirm) | **missing** | Pause and archive exist on the detail page; archive has no confirm. |
| Bulk actions | **missing** | — |
| Starter templates in the empty state | **missing** | The empty state is one sentence. |
| Dialog: name | **present** | — |
| Dialog: markdown runbook | **partial** | A plain textarea, no markdown affordances or preview. |
| Dialog: assignee an agent or a squad | **partial** | The API takes both; the dialog offers agents only. |
| Dialog: exclude assignees without a runtime | **missing** | Runtime binding is not exposed to the client. |
| Dialog: project | **present** | Board picker for the create-an-issue mode. |
| Dialog: output mode | **partial** | "New task per run" and "one standing task"; there is no run-only mode. |
| Dialog: subscribers | **missing** | `PUT /:id/members` exists, no screen uses it. |
| Dialog: trigger (schedule or webhook) at create time | **missing** | Triggers can only be added after saving. |
| Webhook URL shown once with a secret warning | **present** | `SecretsNotice`. |
| Webhook event filters | **present** | Comma-separated input. |
| Schedule editor: fixed time / every N hours or minutes / window | **missing** | A raw five-field cron input. |
| Schedule editor: days (every day, weekdays, day of month) | **missing** | — |
| Schedule editor: searchable timezone picker | **missing** | A free-text zone field. |
| Schedule editor: raw cron toggle, locking when the visual controls cannot show it | **missing** | Raw is the only mode. |
| Schedule preview with countdowns, refreshed every 30s | **partial** | Five absolute times, refreshed only while typing. |
| Detail: active switch | **partial** | A pause/resume button. |
| Detail: edit | **present** | — |
| Detail: run now with blocked reasons | **partial** | Runs and reports the reason code after the fact; nothing is disabled up front. |
| Detail: paused-because-no-runtime banner | **missing** | — |
| Detail: properties, manage access | **missing** | Members are fetched but never shown. |
| Triggers: list, delete, add | **present** | — |
| Triggers: show / hide / copy the webhook URL | **partial** | Shown once at creation; afterwards only a token hint. |
| Triggers: rotate with a confirm | **partial** | Rotates immediately. |
| Run history | **present** | A table. |
| Run history: transcripts | **missing** | No link into the run. |
| Run history: skipped runs folded into a group | **missing** | Every row is listed flat. |
| Deliveries: status, attempts, payload dialog | **partial** | Status and an inline payload row; no attempt count, no dialog. |
| Deliveries: signature check | **missing** | Not surfaced. |
| Replay disabled for invalid signature / rejected / queued | **partial** | Hidden for `rejected` only. |
| Danger zone | **missing** | Archive is a header button. |

## Usage (`/usage`)

Screens: `frontend/components/common/usage/**`, client `frontend/lib/usage.ts`,
server `server-ts/src/mounts/usage.ts` and `server-ts/src/usage/queries.ts`.

| Behaviour | Audit | Note |
| --- | --- | --- |
| Tabs via `?tab=` | **missing** | One page. |
| Period filter | **partial** | 7/30/90 buttons; the server refuses more than 90. |
| Project filter | **missing** | No board dimension in the reads. |
| Bucketing timezone | **missing** | Days are cut in UTC, silently. |
| Last updated, refresh | **partial** | A live-refresh hook, but nothing says when or lets you ask. |
| Usage tab: cost, tokens | **present** | Tiles. |
| Usage tab: run time, runs | **missing** | The usage reads never count runs. |
| Trend chart switchable metric | **partial** | A cost-only bar chart. |
| Trend chart daily or weekly | **missing** | — |
| Leaderboard | **partial** | A by-agent table, not ranked as a leaderboard. |
| Errors tab | **missing** | Nothing of it: no failed-run counts, rate, agents affected, chart, breakdown by type, offenders, or low-sample warning. |

## Dashboard

| Behaviour | Audit | Note |
| --- | --- | --- |
| Working agents | **present** | `workingAgents` with links. |
| 30-day activity | **present** | Runs-by-day and cost-by-day. |
| Run counts | **present** | Five tiles. |
| Failures by agent | **present** | A ranked list. |

## Runtimes

Screens: `frontend/components/common/runtimes/**`, client `frontend/lib/runtimes.ts`,
server `server-ts/src/mounts/runtimes.ts`.

| Behaviour | Audit | Note |
| --- | --- | --- |
| List: health levels (online, recently lost, offline, long offline) | **partial** | The raw status string only. |
| List: active counts | **present** | `activeRuns`. |
| List: last seen | **partial** | `lastHealthAt` is fetched but not shown on the list. |
| Detail usage: period 7/30/90/180 | **partial** | Hard-coded 30 days, and the server caps at 90. |
| Detail usage: cost and tokens charts | **present** | By day and by hour. |
| Detail usage: 26-week heatmap | **missing** | — |
| Detail usage: cost by agent or model | **partial** | By agent only. |
| Detail usage: day-by-model table | **missing** | Not served. |
| Detail usage: unpriced-model warning | **present** | In the tiles. |
| Serving agents | **missing** | Not served. |
| Visibility private / public, owner only | **missing** | The column and the PATCH exist; no screen. |
| Delete with a confirm listing affected agents and a checkbox | **missing** | No delete in the UI at all. |

---

## Plan

Everything above that reads *partial* or *missing* is to be built, except the items listed
under "Not built" at the end. This section is rewritten as the work lands, so the next
reader can find it.

### Server

One migration, `server-ts/migrations/179_areas_polish.up.sql` (with its `.down.sql`), inside
this workstream's block: `squads.instructions` and `squads.avatar_url`.

New or widened reads, each through the workspace guard and the find-before-permission
helpers, each covered by tests and by `cross-tenant-leakage.test.ts`:

- **Skills** (`mounts/skills.ts`, `skills/repository.ts`) now serialize `createdBy`,
  `creatorName` and `agents` (the agents that carry the skill, with their `enabled` flag),
  so the list can filter by usage, agent and creator, and the detail page can show who uses
  a skill. The list read takes `source`, `agentId`, `createdBy` and `inUse` filters.
- **Squads** (`mounts/squads.ts`, `squads/repository.ts`) gained `instructions`,
  `avatarUrl` and `createdBy`, the members roster now carries each member's `status` and
  `lastActiveAt`, and create accepts an initial roster.
- **Runtimes** (`mounts/runtimes.ts`, `runtime/runtimes.ts`): `GET /:id` answers
  `servingAgents`, and a new `GET /api/v1/runtimes/agent-coverage` says which of the
  workspace's agents have a runtime, which the autopilot dialog needs.
- **Usage** (`mounts/usage.ts`, `usage/queries.ts`): windows now go to 180 days; every
  windowed read takes an IANA `tz` for bucketing and an optional `boardId` project filter;
  totals carry `runs` and `runSeconds`; runtime usage carries `byDayModel`; and
  `GET /api/v1/usage/:workspaceId/errors` answers the errors tab — failed and total runs,
  the failure rate, agents affected, a daily failure series, a breakdown by failure code,
  and offenders with the sample size each rate is computed from.

### Frontend

New namespace `areas` in all four locales (`frontend/messages/*/areas.json`), owned by this
workstream so the other builders' catalogue edits cannot collide with it.

- `frontend/components/common/skills/**` — the list gained a filter/sort/column bar, a row
  menu, selection with bulk add/update/delete (the update reports progress), and a lock
  marker; the new-skill dialog gained the manual/zip/folder/GitHub paths with local
  validation and a preview; the detail page became a `?view=` panel with an overview, a file
  tree with the full path rules, preview/edit/raw modes, a save bar, a conflict banner and a
  warned refresh.
- `frontend/components/common/squads/**` — list scope, filters, sort, columns and archive
  with the leader explanation; a create modal with avatar, a description counter and initial
  members; a detail page with a left panel, a members tab and an instructions tab.
- `frontend/components/common/autopilots/**` — list scope, filters, sort, columns, a row
  menu, bulk actions and starter templates; the dialog gained a markdown runbook, squad
  assignees, runtime exclusion, subscribers and a first trigger; a full visual schedule
  editor (`schedule-editor.tsx`); a detail page with an active switch, blocked reasons, a
  no-runtime banner, properties, access, webhook URL handling with a rotate confirm, folded
  skipped runs, delivery details and a danger zone.
- `frontend/components/common/usage/**` — `?tab=` tabs, period/project/timezone filters,
  last-updated and refresh, run and run-time tiles, a switchable daily/weekly trend chart, a
  leaderboard, and the errors tab.
- `frontend/components/common/runtimes/**` — health levels, last seen, the 7/30/90/180
  usage period, a 26-week heatmap, cost by agent or model, the day-by-model table, serving
  agents, visibility and the stronger delete.

### Not built

- **Autopilot "run only" output mode.** Berry's run ledger admits a run against a task or a
  chat session (`runs_task_target_ck`), and the autopilot fire path creates or names an
  issue for every firing. A third mode would be a change to the ledger and the dispatcher,
  which are another workstream's, not a screen. The two existing modes are offered.
- **Webhook delivery attempt counts beyond replays.** The server stores one row per
  delivery and links replays through `replay_of`; there is no retry counter to show. The
  deliveries table shows the replay chain length instead, which is what Berry actually knows.
