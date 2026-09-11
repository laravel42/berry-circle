# F4 — agents and chat: parity map

Audited on branch `fe/F4-agents-chat`, cut from `feat/multica-parity` at `a73d2fa`.

The surfaces this workstream owns: `frontend/app/[orgId]/agents/**`,
`frontend/app/[orgId]/chat/**`, `frontend/components/common/agents/**`,
`frontend/components/common/chat/**`, and a floating chat window (which did not
exist at all).

Each row says what the code on the branch actually does — components, stores,
`frontend/lib` clients and the server routes behind them — not what the
checklist asks for. "Partial" always names the missing half.

---

## 1. Agents list

Code read: `components/common/agents/agents.tsx`, `agent-line.tsx`,
`layout/headers/agents/{header,header-nav,header-options}.tsx`,
`store/agents-list-store.ts`, `store/agents-store.ts`, `lib/agents.ts`, and the
`/api/v1/agents` mount.

| Item | State | Notes |
| --- | --- | --- |
| Scopes: mine / all / archived, each with a count | **Missing** | Only a two-state `showArchived` toggle. No ownership axis and no counts anywhere. |
| Search | **Present** | Client-side over name and description, held in `agents-list-store`. |
| Filters: availability, access, runtime, owner, model | **Missing** | The "Filter" button in `header-options.tsx` is rendered `disabled`. |
| Sort by recent activity, name, runs, created | **Partial** | Only two sorts (`last-active-desc`, `name-asc`), and they are cycled by one button rather than chosen. No runs or created sort. |
| Column picker | **Missing** | The column set is hard-coded in `agents.tsx`. |
| Clicking a header sorts | **Missing** | The header row is plain `div`s. |
| Row: presence | **Present** | Status dot from `agentStatusDisplay`. |
| Row: workload (working / queued / idle) | **Missing** | Nothing reads active or queued run counts per row. `/api/v1/agents/capabilities` has the number but the list never calls it. |
| Row: runtime, or a warning when none | **Missing** | No runtime data reaches the list; the detail page prints a literal "Berry". |
| Row: 7-day sparkline with a tooltip | **Missing** | A 7-day bar chart exists on agent *detail*, computed from whatever runs happen to be in the runs store; the list has nothing, and no endpoint serves per-agent daily counts. |
| Row: runs | **Partial** | A count derived from `useRunsStore`, which holds only the runs the current board happened to hydrate — not the agent's run total. |
| Row: last active | **Missing** | `updatedAt` is used to sort but never shown. |
| Row: model | **Present** | Bare model name plus a provider-qualified tooltip. |
| Row: owner | **Missing** | Agents carry no owner on the wire. |
| Row: access | **Partial** | A hard-coded "Workspace" string. The real scopes live at `GET /api/v1/agents/:id/access`. |
| Row menu: open in new tab | **Missing** | The row is one `<Link>`; there is no menu. |
| Row menu: duplicate → `/agents/new?duplicate=id` | **Missing** | `copyAgent` exists but only as a button on the settings tab, and it copies server-side rather than pre-filling the create form. |
| Row menu: cancel all runs, with counts in the confirm | **Missing** | `cancelAgentTasks` exists and is wired to a button on the (old) tasks tab, with no counts and no confirm. |
| Row menu: archive, with a confirm, never the Orchestrator | **Partial** | Archive with a `window.confirm` exists on the settings tab, and the protected agent is detected by the `orchestrate` capability rather than by a protected flag. Not in the list. |
| Row menu: restore | **Partial** | Only from the archived agent's own settings tab. |
| Bulk restore / set access / archive, with partial-failure reports | **Missing** | No selection model at all. |
| Hover card per agent | **Missing** | — |
| States: skeleton, error with retry, empty, no matches | **Partial** | Loading and error are one muted line each; the error has no retry. Empty and no-matches are present. |

## 2. Agent detail

Code read: `components/common/agents/agent-details.tsx` and the tab components
beside it, `app/[orgId]/agents/[agentId]/page.tsx`, the `@drawer` intercept.

| Item | State | Notes |
| --- | --- | --- |
| `?view=` tabs | **Missing** | The tab is `useState` only; it is not in the URL, so a tab cannot be linked or restored. |
| Unsaved-changes guard | **Missing** | — |
| Header: chat → `/chat?agent=id` | **Missing** | The "DM" button is rendered `disabled`. |
| Header: assign work (quick-create with the agent preset) | **Partial** | Links to `/runs?agent=id` instead of opening a create dialog. |
| Header: archive | **Missing** | Archive lives at the bottom of the settings tab. |
| Banner: read-only | **Missing** | — |
| Banner: archived, with restore | **Partial** | A restore strip exists inside the settings tab, not as a page banner. |
| Banner: needs a runtime, linking to settings | **Missing** | — |
| 403 and 404 states | **Partial** | One generic "This agent is unavailable" line for every failure. |
| Overview: owner | **Partial** | Prints the *signed-in* user, which is wrong for any agent somebody else made. |
| Overview: access | **Partial** | Hard-coded "Workspace". |
| Overview: runtime with health | **Missing** | Hard-coded "Berry". |
| Overview: model | **Present** | — |
| Overview: concurrency | **Partial** | Hard-coded `3`. |
| Overview: skill chips | **Missing** | Hard-coded "No skills assigned". |
| Overview: 30-day stats | **Present** | Runs, success rate, average duration, failures — from the runs store. |
| Overview: warning when runs are queued and the runtime is unavailable | **Missing** | — |
| Activity → Now: active runs with source and trigger | **Partial** | Active runs are listed with status and a link, and can be cancelled. Source and trigger are not on the wire (`serializeRun` omits `runs.source`). |
| Activity → Now: open issue, transcript | **Partial** | Issue link present. No transcript link. |
| Activity → Recent work, plain-language failure reasons, small pages | **Partial** | Eight most recent runs from the store, status word only, no paging, no failure explanation. |
| Work: issues assigned to this agent | **Missing** | The "work" tab lists *runs*, which is what the overview already shows. |
| Capabilities: instructions with an unsaved indicator | **Partial** | Saves on commit and shows "Saving…/Saved"; there is no dirty marker before a save. |
| Capabilities: up to 3 conversation starters with a preview | **Missing** | Chat suggestions are generated server-side; an agent cannot author its own. |
| Capabilities: skills assign dialog, toggle, remove | **Partial** | A flat list of every workspace skill with a switch. No search/multi-select assign, no remove. |
| Capabilities: agent MCP servers (add, edit, rename, delete; visual or raw JSON; transports; name rules; write-only secrets) | **Partial** | `McpServerManager` adds, deletes, toggles and replaces headers, with both transports and write-only header values. No edit or rename of an existing server, no raw-JSON editor, no name validation. |
| Capabilities: workspace MCP library (assign, toggle) | **Partial** | Workspace servers are shown read-only; they cannot be assigned to the agent. |
| Settings: avatar | **Present** | — |
| Settings: rename | **Missing** | Name is not editable anywhere after creation. |
| Settings: description | **Present** | — |
| Settings: runtime picker (AgentCore runtimes) | **Missing** | `agents.runtime_id` exists in the schema and `PUT /api/v1/runtimes/:id/agents/:agentId` binds it, but no screen calls it and the agent payload never says which runtime it is on. |
| Settings: model picker from the Bedrock catalogue | **Present** | Searchable, grouped by provider, with prices. |
| Settings: custom model id and clear | **Missing** | Only catalogue entries can be chosen, and a choice cannot be undone. |
| Settings: concurrency | **Missing** | — |
| Settings: access (only me / workspace / specific people) | **Present** | Assign and mention scopes with a member picker. |
| Settings: environment, owner and admin only | **Partial** | The route is `workspace.admin`-gated server-side, but the UI shows the section to everyone and only fails on save. |
| Settings: values masked until "reveal and edit" | **Partial** | Values are never shown (they are sealed), but there is no reveal: editing means retyping every value. |
| Settings: every reveal and edit written to an audit log | **Missing** | No audit table, no endpoint. |

## 3. Create

| Item | State | Notes |
| --- | --- | --- |
| `/agents/new`: manual or build with AI | **Present** | Two tabs on one page. |
| Manual: identity, instructions | **Present** | Name, description, instructions. |
| Manual: skills, runtime, access | **Missing** | — |
| Manual: model | **Present** | A plain select of the catalogue. |
| Manual: locally saved draft | **Missing** | A reload loses the form. |
| Duplicate (`?duplicate=`) copying instructions and skills but not env or MCP | **Missing** | The query parameter is not read; duplication is a server-side copy of everything. |
| `/agents/new/ai[/sessionId]` | **Missing** | The builder is a tab, not a route, so a session has no URL. |
| Two panels, builder chat and live draft, all editable | **Partial** | Two panels exist; the draft is read-only. |
| Stop generation | **Missing** | — |
| Discard with a confirm | **Partial** | "Start over" discards without a confirm. |
| Resume unfinished drafts | **Missing** | `GET /api/v1/agent-builder/sessions/:id` exists and is never called. |
| Uses D's builder API | **Present** | `lib/agent-builder.ts` against `/api/v1/agent-builder`. |

## 4. Chat (`/chat`)

Code read: `components/common/chat/{chat,chat-sidebar,chat-sessions,chat-thread,chat-tasks-panel}.tsx`,
`lib/chat.ts`, and the `/api/v1/conversations` mount.

| Item | State | Notes |
| --- | --- | --- |
| `?session=` in sync with the URL | **Missing** | The open session is component state only. |
| `?agent=` in sync with the URL | **Partial** | Read on mount to open a session; never written back, and switching sessions leaves a stale `?agent=`. |
| Pinned-agents strip (up to 5, stored on the server) | **Partial** | Server-stored pins are listed in the sidebar; no cap, and the server accepts 20. |
| New-chat picker grouped into mine and others | **Partial** | One flat dropdown of agents whose status is `available`. |
| Agents without a runtime flagged in the picker | **Missing** | — |
| Row: status (typing/working, waiting, failed) | **Partial** | A pulsing dot when a run is active; nothing else. |
| Row: unread count | **Present** | — |
| Row: last message preview | **Missing** | Not on the wire. |
| Pinned rows first, then by recency | **Missing** | Rows are rendered in whatever order the server returned. |
| Row hover actions: pin, archive, stop | **Partial** | A hover menu with rename, pin, archive and delete. No stop, and delete's confirm does not say it is permanent. |
| Archived view with unarchive and permanent delete | **Partial** | An inline "Archived" disclosure reusing the same rows. |
| Header: inline rename | **Missing** | Renaming is in the sidebar row menu. |
| Header menu: open agent, archive, delete | **Missing** | The header is a title and a subtitle. |
| Composer: @mentions of issues and projects | **Missing** | — |
| Composer: attachments by paste or drag; long paste becomes a file | **Missing** | — |
| Composer: project context | **Missing** | — |
| Composer: stop | **Missing** | Cancel exists only per task in the queue panel. |
| Composer: messages sent while a reply runs are queued | **Present** | Server-side: every message becomes a task on the agent. |
| Composer: per-session drafts | **Present** | Debounced `PUT /draft`, restored on select. |
| Queue: list | **Present** | Queued and running tasks above the composer. |
| Queue: steer (send into the running reply) | **Missing** | — |
| Queue: edit, remove, clear all | **Partial** | Cancel per task and "Run next". No edit, no clear all. |
| Messages: markdown | **Missing** | Bodies render as pre-wrapped plain text. |
| Messages: collapsible step groups with counts | **Partial** | A separate "Task steps" sheet listing raw event types. |
| Messages: duration and failure status lines, friendly messages, details on demand | **Missing** | — |
| Messages: copy | **Missing** | — |
| Messages: live stage status | **Missing** | — |
| Messages: suggested follow-ups, with regenerate | **Partial** | Suggestions are fetched per agent and shown only while the thread is empty; no regenerate. |
| Messages: older messages load on scroll-up; view pinned to the bottom | **Partial** | A "Load earlier" button; the view scrolls to the newest message on change. |
| Empty states with conversation starters | **Partial** | One sentence plus the agent suggestions. |
| Banners: no agents, archived, no permission, no runtime, offline | **Missing** | One red error line covers everything. |

## 5. Floating chat window

| Item | State |
| --- | --- |
| On every page except `/chat` | **Missing** |
| Toggled with mod+J | **Missing** |
| Registered with F6's shortcut registry | **Missing** (no registry exists on this branch) |
| Expand, restore, minimise, resize | **Missing** |
| History dropdown and agent picker | **Missing** |
| Full-screen sheet on narrow widths | **Missing** |

---

## Endpoints this workstream needs and did not have

1. **Per-agent roster facts for the list** — workload, the bound runtime and its
   health, a run total, last activity, and seven days of run counts with
   failures. Nothing served this; the list would otherwise need one request per
   row plus a runtimes request.
2. **Environment reveal with an audit trail** — the checklist requires values to
   stay masked until an explicit "reveal and edit", and every reveal and every
   edit to be recorded. Neither the reveal route nor the audit table existed.

Everything else on the checklist is reachable with routes that are already
mounted.
