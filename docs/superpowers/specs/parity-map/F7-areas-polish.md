# F7 — areas polish: skills, squads, autopilots, usage, dashboard, runtimes

What this workstream owns, what the branch already had when the audit was taken, and what
was built on top of it. Every line describes behaviour in Berry's own words; the code is
Berry's own design system, component library and API clients throughout.

Audit taken on `fe/F7-areas-polish`, branched from `feat/multica-parity`.

The *Audit* column is what the branch had when the audit was taken; *Now* is what it has
after this workstream's work. **present** — the behaviour is there; **partial** — some of it
is there, with what is missing named; **missing** — nothing of it exists yet; **not built** —
deliberately left out, with the reason under "Not built".

## Skills

Screens: `frontend/app/[orgId]/skills/**`, `frontend/components/common/skills/**`,
client `frontend/lib/skills.ts`, server `server-ts/src/mounts/skills.ts`.

| Behaviour | Audit | Now | What the audit saw |
| --- | --- | --- | --- |
| Search | **present** | **present** | Debounced `q` on the list, passed to `GET /api/v1/skills`. |
| Filter by usage (in use / unused) | **missing** | **present** | The list never learns which agents carry a skill. |
| Filter by origin (manual, GitHub, zip) | **missing** | **present** | `source.kind` is rendered as a column only. |
| Filter by agent | **partial** | **present** | The client accepts `agentId`, no screen sets it. |
| Filter by creator | **missing** | **present** | `skills.created_by` is stored but never serialized. |
| Sort | **missing** | **present** | Server orders by name; the list has no control. |
| Column picker | **missing** | **present** | Three fixed columns. |
| Row menu: add to agent (mine / others) | **missing** | **present** | No row menu at all; binding exists only in the agent's own skills tab. |
| Row menu: update from source | **partial** | **present** | Only on the detail page, GitHub only, without a warning. |
| Row menu: delete | **partial** | **present** | Only on the detail page. |
| Bulk add to agents | **missing** | **present** | No selection model. |
| Bulk update with progress | **missing** | **present** | — |
| Bulk delete | **missing** | **present** | — |
| Lock icon for skills the user cannot edit | **missing** | **present** | The workspace role is never consulted in this area. |
| New skill — manual, unique name + description | **partial** | **present** | Name shape is validated client-side; uniqueness surfaces only as a server 409 toast. |
| New skill — import a zip | **partial** | **present** | Posts the zip straight to the server; no local SKILL.md / size / count check and no preview. |
| New skill — import a folder | **missing** | **present** | — |
| New skill — from a GitHub URL | **present** | **present** | `POST /api/v1/skills/import`. |
| Detail opens as `?view=` | **missing** | **present** | Detail is a separate route, `/skills/<id>`. |
| Overview: name + description synced with the SKILL.md frontmatter | **partial** | **present** | Both are editable fields; nothing keeps them in step with the instructions' frontmatter. |
| Overview: labels | **present** | **present** | Comma-separated input. |
| Overview: agents using it | **missing** | **present** | Not served. |
| Files: a tree | **partial** | **present** | A flat list of paths. |
| Files: add by path with the path rules | **missing** | **present** | Files can only arrive by import. |
| Files: rename, delete (never the main file) | **missing** | **present** | — |
| Files: preview / edit / raw modes | **partial** | **present** | A read-only `<pre>`. |
| Save bar summarising changes | **missing** | **present** | One Save button, no summary, no discard. |
| Conflict banner | **missing** | **present** | A concurrent save is silently overwritten. |
| Update from source warns about local edits | **missing** | **present** | Refresh runs immediately. |

## Squads

Screens: `frontend/app/[orgId]/squads/**`, `frontend/components/common/squads/**`,
client `frontend/lib/squads.ts`, server `server-ts/src/mounts/squads.ts`.

| Behaviour | Audit | Now | What the audit saw |
| --- | --- | --- | --- |
| Create modal: name, description, leader | **present** | **present** | In `squads-list.tsx`. |
| Create modal: avatar | **missing** | **present** | No column for it. |
| Create modal: description counter | **missing** | **present** | — |
| Create modal: initial members | **missing** | **present** | The roster is set after creation. |
| Scope mine / all | **missing** | **present** | `created_by` is stored, never serialized. |
| Filters (leader, creator) | **missing** | **present** | — |
| Sort | **missing** | **present** | Server orders by name. |
| Columns | **missing** | **present** | Three fixed columns. |
| Archive, explaining that issues move to the leader | **partial** | **present** | Archive lives on the detail page; the copy talks about members, not about issues. |
| Detail: left panel with avatar, inline rename, description, details | **missing** | **present** | One column of form fields. |
| Members: leader marker, type, status, current issues, last active | **partial** | **present** | Type only. |
| Members: make leader | **partial** | **present** | Only through the leader `<select>` in the details form. |
| Members: remove, inline role edit | **present** | **present** | Both in the roster list. |
| Members: add member as a two-step search | **partial** | **present** | A single flat `<select>` of every agent and person. |
| Members: create an agent for this squad | **missing** | **present** | — |
| Instructions tab, unsaved indicator, save guard | **missing** | **present** | Squads have no instructions at all — no column, no field. |

## Autopilots

Screens: `frontend/app/[orgId]/autopilots`, `frontend/app/[orgId]/autopilot/[autopilotId]`,
`frontend/components/common/autopilots/**`, client `frontend/lib/autopilots.ts`,
server `server-ts/src/mounts/autopilots.ts`.

| Behaviour | Audit | Now | What the audit saw |
| --- | --- | --- | --- |
| List scope all / active / paused | **missing** | **present** | One flat list. |
| Filters (assignee, mode, trigger kind, creator) | **missing** | **present** | — |
| Sort, columns | **missing** | **present** | Four fixed columns. |
| Row menu (pause/resume, delete with a confirm) | **missing** | **present** | Pause and archive exist on the detail page; archive has no confirm. |
| Bulk actions | **missing** | **present** | — |
| Starter templates in the empty state | **missing** | **present** | The empty state is one sentence. |
| Dialog: name | **present** | **present** | — |
| Dialog: markdown runbook | **partial** | **present** | A plain textarea, no markdown affordances or preview. |
| Dialog: assignee an agent or a squad | **partial** | **present** | The API takes both; the dialog offers agents only. |
| Dialog: exclude assignees without a runtime | **missing** | **present** | Runtime binding is not exposed to the client. |
| Dialog: project | **present** | **present** | Board picker for the create-an-issue mode. |
| Dialog: output mode | **partial** | **not built** — run-only needs the run ledger, see below | "New task per run" and "one standing task"; there is no run-only mode. |
| Dialog: subscribers | **missing** | **present** | `PUT /:id/members` exists, no screen uses it. |
| Dialog: trigger (schedule or webhook) at create time | **missing** | **present** | Triggers can only be added after saving. |
| Webhook URL shown once with a secret warning | **present** | **present** | `SecretsNotice`. |
| Webhook event filters | **present** | **present** | Comma-separated input. |
| Schedule editor: fixed time / every N hours or minutes / window | **missing** | **present** | A raw five-field cron input. |
| Schedule editor: days (every day, weekdays, day of month) | **missing** | **present** | — |
| Schedule editor: searchable timezone picker | **missing** | **present** | A free-text zone field. |
| Schedule editor: raw cron toggle, locking when the visual controls cannot show it | **missing** | **present** | Raw is the only mode. |
| Schedule preview with countdowns, refreshed every 30s | **partial** | **present** | Five absolute times, refreshed only while typing. |
| Detail: active switch | **partial** | **present** | A pause/resume button. |
| Detail: edit | **present** | **present** | — |
| Detail: run now with blocked reasons | **partial** | **present** | Runs and reports the reason code after the fact; nothing is disabled up front. |
| Detail: paused-because-no-runtime banner | **missing** | **present** | — |
| Detail: properties, manage access | **missing** | **present** | Members are fetched but never shown. |
| Triggers: list, delete, add | **present** | **present** | — |
| Triggers: show / hide / copy the webhook URL | **partial** | **present** | Shown once at creation; afterwards only a token hint. |
| Triggers: rotate with a confirm | **partial** | **present** | Rotates immediately. |
| Run history | **present** | **present** | A table. |
| Run history: transcripts | **missing** | **present** | No link into the run. |
| Run history: skipped runs folded into a group | **missing** | **present** | Every row is listed flat. |
| Deliveries: status, attempts, payload dialog | **partial** | **present** — attempts is the replay chain, see below | Status and an inline payload row; no attempt count, no dialog. |
| Deliveries: signature check | **missing** | **present** | Not surfaced. |
| Replay disabled for invalid signature / rejected / queued | **partial** | **present** | Hidden for `rejected` only. |
| Danger zone | **missing** | **present** | Archive is a header button. |

## Usage (`/usage`)

Screens: `frontend/components/common/usage/**`, client `frontend/lib/usage.ts`,
server `server-ts/src/mounts/usage.ts` and `server-ts/src/usage/queries.ts`.

| Behaviour | Audit | Now | What the audit saw |
| --- | --- | --- | --- |
| Tabs via `?tab=` | **missing** | **present** | One page. |
| Period filter | **partial** | **present** | 7/30/90 buttons; the server refuses more than 90. |
| Project filter | **missing** | **present** | No board dimension in the reads. |
| Bucketing timezone | **missing** | **present** | Days are cut in UTC, silently. |
| Last updated, refresh | **partial** | **present** | A live-refresh hook, but nothing says when or lets you ask. |
| Usage tab: cost, tokens | **present** | **present** | Tiles. |
| Usage tab: run time, runs | **missing** | **present** | The usage reads never count runs. |
| Trend chart switchable metric | **partial** | **present** | A cost-only bar chart. |
| Trend chart daily or weekly | **missing** | **present** | — |
| Leaderboard | **partial** | **present** | A by-agent table, not ranked as a leaderboard. |
| Errors tab | **missing** | **present** | Nothing of it: no failed-run counts, rate, agents affected, chart, breakdown by type, offenders, or low-sample warning. |

## Dashboard

| Behaviour | Audit | Now | What the audit saw |
| --- | --- | --- | --- |
| Working agents | **present** | **present** | `workingAgents` with links. |
| 30-day activity | **present** | **present** | Runs-by-day and cost-by-day. |
| Run counts | **present** | **present** | Five tiles. |
| Failures by agent | **present** | **present** | A ranked list. |

## Runtimes

Screens: `frontend/components/common/runtimes/**`, client `frontend/lib/runtimes.ts`,
server `server-ts/src/mounts/runtimes.ts`.

| Behaviour | Audit | Now | What the audit saw |
| --- | --- | --- | --- |
| List: health levels (online, recently lost, offline, long offline) | **partial** | **present** | The raw status string only. |
| List: active counts | **present** | **present** | `activeRuns`. |
| List: last seen | **partial** | **present** | `lastHealthAt` is fetched but not shown on the list. |
| Detail usage: period 7/30/90/180 | **partial** | **present** | Hard-coded 30 days, and the server caps at 90. |
| Detail usage: cost and tokens charts | **present** | **present** | By day and by hour. |
| Detail usage: 26-week heatmap | **missing** | **present** | — |
| Detail usage: cost by agent or model | **partial** | **present** | By agent only. |
| Detail usage: day-by-model table | **missing** | **present** | Not served. |
| Detail usage: unpriced-model warning | **present** | **present** | In the tiles. |
| Serving agents | **missing** | **present** | Not served. |
| Visibility private / public, owner only | **missing** | **present** | The column and the PATCH exist; no screen. |
| Delete with a confirm listing affected agents and a checkbox | **missing** | **present** | No delete in the UI at all. |

---

## What was built

Everything the audit found *partial* or *missing* was built, except the two items under
"Not built". This section says where it landed.

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
  `servingAgents`, every runtime now carries its `ownerId` so the visibility control can be
  the registrant's alone, and a new `GET /api/v1/runtimes/agent-coverage` says which of the
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

## Verification

- `pnpm lint` in `frontend` — clean.
- `pnpm exec prettier --check` on every file this workstream touched — clean.
- `pnpm build:check` in `frontend` — compiles, types check, every route builds.
- `python3 scripts/check-locale-catalogues.py` — 4 locales x 10 namespaces agree.
- `pnpm typecheck:server` — clean.
- The server tests behind these screens, on a private database
  (`berry_test_f7_areas_polish`): `mounts/runtimes`, `mounts/usage`, `mounts/skills`,
  `mounts/squads`, `mounts/autopilots`, `mounts/cross-tenant-leakage` and `usage/queries` —
  81 tests, all passing.
