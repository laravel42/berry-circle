# F4 — agents and chat: parity map

Branch `fe/F4-agents-chat`, cut from `feat/multica-parity` at `a73d2fa`.

Surfaces owned: `frontend/app/[orgId]/agents/**`, `frontend/app/[orgId]/chat/**`,
`frontend/components/common/agents/**`, `frontend/components/common/chat/**`,
and a floating chat window.

The audit below was taken against the code as it stood on the branch, then
re-taken after the work. Every row now reads **present** or **not built** with
the reason. Nothing is marked present that a reader could not go and use.

---

## 1. Agents list

| Item | Was | Now |
| --- | --- | --- |
| Scopes: mine / all / archived, each with a count | Missing — one archived toggle | **Present.** Counts come from the loaded roster; the archived count appears once the archive has been opened, because a count of zero and a count not yet known are different answers. |
| Search | Present | **Present.** |
| Filters: availability, access, runtime, owner, model | Missing — the button was `disabled` | **Present.** Options are derived from the workspace's own roster, so no filter offers a value that matches nothing. |
| Sort by recent activity, name, runs, created | Partial — two sorts on one toggle | **Present.** Four sorts; picking the current one flips direction. |
| Column picker | Missing | **Present.** |
| Clicking a header sorts | Missing | **Present** for agent, runs and last active. |
| Row: presence | Present | **Present.** |
| Row: workload (working / queued / idle) | Missing | **Present**, from the roster's live run counts. |
| Row: runtime, or a warning when none | Missing | **Present.** |
| Row: 7-day sparkline with a tooltip | Missing | **Present.** Failures are drawn into each column; the tooltip gives runs, failures and the failure percentage per day. |
| Row: runs | Partial — counted whatever the browser held | **Present**, the agent's real total. |
| Row: last active | Missing | **Present.** |
| Row: model | Present | **Present.** |
| Row: owner | Missing — agents had no author | **Present.** Agents now record who made them; ones a workspace seeded say "the workspace" rather than naming the reader. |
| Row: access | Partial — hard-coded | **Present.** |
| Row menu: open in new tab | Missing | **Present.** |
| Row menu: duplicate → `/agents/new?duplicate=id` | Missing | **Present.** |
| Row menu: cancel all runs, counts in the confirm | Missing | **Present.** The confirm names the running and queued counts; an agent with neither says so instead of opening a dialog. |
| Row menu: archive, with a confirm, never the Orchestrator | Partial — buried in settings | **Present.** |
| Row menu: restore | Partial | **Present.** |
| Bulk restore / set access / archive, partial-failure reports | Missing | **Present.** Bulk access offers workspace-wide or admins-only; "specific people" is per-agent and stays on the agent's own settings, because a shared member list across a selection is not a thing the person means. |
| Hover card per agent | Missing | **Present** — instructions, skills, and a way into the profile. |
| States: skeleton, error with retry, empty, no matches | Partial | **Present.** |

## 2. Agent detail

| Item | Was | Now |
| --- | --- | --- |
| `?view=` tabs | Missing — local state | **Present.** |
| Unsaved-changes guard | Missing | **Present** — a dialog on leaving a tab with unsaved text, and the browser's own prompt on leaving the page. |
| Header: chat → `/chat?agent=id` | Missing — `disabled` | **Present.** |
| Header: assign work with the agent preset | Partial — linked to the run ledger | **Present** — a two-field dialog that creates an issue already assigned to the agent. |
| Header: archive / restore | Missing from the header | **Present.** |
| Banner: read-only | Missing | **Present.** Raised when the server refuses a write, which is the only authority on whether this reader may edit. |
| Banner: archived, with restore | Partial | **Present.** |
| Banner: needs a runtime, linking to settings | Missing | **Present** — the link opens the settings tab, which the URL now allows. |
| 403 and 404 states | Partial — one line for everything | **Present.** |
| Overview: owner, access, runtime with health, model, concurrency, skill chips, 30-day stats | Partial — four of them invented | **Present**, all from the agent and the roster. |
| Overview: warning when runs are queued and the runtime is unavailable | Missing | **Present.** |
| Activity → Now: active runs with source and trigger, open issue, transcript, cancel | Partial | **Present**, except the run's own `source`: see *not built*. |
| Activity → Recent work, plain-language failures, small pages | Partial | **Present** — a sentence per failure, the raw code behind "details", and paging from the newest backwards. |
| Work: issues assigned to this agent | Missing — it listed runs | **Present.** |
| Capabilities: instructions with an unsaved indicator | Partial | **Present.** |
| Capabilities: up to 3 conversation starters, with a preview | Missing — nowhere to store them | **Present**, stored on the agent (migration 170). |
| Capabilities: skills assign dialog, toggle, remove | Partial — a flat switch list | **Present** — a searchable multi-select to assign, and removal from the assigned list. |
| Capabilities: agent MCP servers | Partial | **Present** for add, toggle, delete, replace-headers, both transports, write-only secrets. Edit/rename/raw JSON: see *not built*. |
| Capabilities: workspace MCP library | Partial | **Present** as a read-only library. Assigning one to the agent: see *not built*. |
| Settings: avatar, description | Present | **Present.** |
| Settings: rename | Missing | **Present** (`name` on `PUT /config`). |
| Settings: runtime picker (AgentCore runtimes) | Missing | **Present**, binding through the runtimes mount. |
| Settings: model picker, custom id, clear | Partial — no custom id, no clear | **Present.** Clearing needed the server to accept an explicit null pair, which it now does. |
| Settings: concurrency | Missing | **Present** (migration 170). |
| Settings: access — only me / workspace / specific people | Present as scopes | **Present** in those three words. |
| Settings: environment, owner and admin only | Partial — shown to everyone | **Present.** The UI asks the server whether this reader may see it at all. |
| Settings: values masked until "reveal and edit" | Partial — never revealable | **Present.** |
| Settings: every reveal and edit written to an audit log | Missing | **Present** — table and routes added (migration 169); the log records who, what and which variables, never values. |

## 3. Create

| Item | Was | Now |
| --- | --- | --- |
| `/agents/new`: manual or build with AI | Present as tabs | **Present** as a choice, with the builder on its own route. |
| Manual: identity, instructions | Present | **Present.** |
| Manual: skills, runtime, access | Missing | **Present.** Written after the agent exists, each against its own route, so one failure costs one setting and says which. |
| Manual: model | Present | **Present.** |
| Manual: locally saved draft | Missing | **Present.** |
| Duplicate (`?duplicate=`), instructions and skills but not env or MCP | Missing | **Present.** |
| `/agents/new/ai[/sessionId]` | Missing — a tab | **Present**; the session gets its URL as soon as it exists. |
| Two panels, builder chat and live draft, all editable | Partial — read-only draft | **Present.** Edits are applied to the created agent immediately after the draft is, because the apply route creates from what the server stored. |
| Stop generation | Missing | **Present** — the request is aborted, not ignored. |
| Discard, with a confirm | Partial | **Present.** |
| Resume unfinished drafts | Missing | **Present.** |
| Uses D's builder API | Present | **Present.** |

## 4. Chat

| Item | Was | Now |
| --- | --- | --- |
| `?session=` and `?agent=` in sync with the URL | Missing / one-way | **Present.** |
| Pinned-agents strip (up to 5, stored on the server) | Partial — no cap | **Present.** |
| New-chat picker grouped into mine and others | Partial — one flat list | **Present.** |
| Agents without a runtime flagged | Missing | **Present.** |
| Row: status | Partial | **Present** for working; typing and failed: see *not built*. |
| Row: unread count | Present | **Present.** |
| Row: last message preview | Missing — not on the wire | **Present**; the conversations list grew a truncated preview rather than the browser fetching every thread. |
| Pinned rows first, then by recency | Missing | **Present.** |
| Row hover actions: pin, archive, stop | Partial | **Present**, with a confirm on stop. |
| Archived view with unarchive and permanent delete | Partial | **Present**, and the delete confirm says it cannot be undone. |
| Header: inline rename, menu (open agent, archive, delete) | Missing | **Present.** |
| Composer: @mentions of issues and projects | Missing | **Present**, inserting the identifier Berry uses elsewhere. |
| Composer: attachments; long pasted text becomes a file | Missing | **Not built** — see below. |
| Composer: project context | Missing | **Not built** — see below. |
| Composer: stop | Missing | **Present.** |
| Composer: messages queue behind a running reply | Present | **Present.** |
| Composer: per-session drafts | Present | **Present.** |
| Queue: list, remove, clear all | Partial | **Present**, plus "run next". |
| Queue: steer, edit | Missing | **Not built** — see below. |
| Messages: markdown | Missing | **Present** — parsed to elements, never to HTML. |
| Messages: collapsible step groups with counts | Partial — a separate sheet | **Present**, loaded only when opened. |
| Messages: duration and failure lines, friendly text, details on demand | Missing | **Present**, from the run's own events (so they appear with the steps). |
| Messages: copy | Missing | **Present.** |
| Messages: live stage status | Missing | **Present.** |
| Messages: suggested follow-ups, with regenerate | Partial | **Present.** |
| Messages: load on scroll-up, view pinned to the bottom | Partial — a button | **Present**, and loading older messages does not move the view. |
| Empty states with conversation starters | Partial | **Present**, using the agent's own starters. |
| Banners: no agents, archived, no permission, no runtime, offline | Missing | **Present.** |

## 5. Floating chat window

| Item | Now |
| --- | --- |
| On every page except `/chat` | **Present.** |
| Toggled with mod+J | **Present**, via a local handler — see merge wiring. |
| Expand, restore, minimise, resize | **Present**; the size is remembered per browser. |
| History dropdown and agent picker | **Present.** |
| Full-screen sheet on narrow widths | **Present.** |

---

## Not built, and why

1. **Chat attachments, and long pasted text becoming a file.** There is no
   endpoint that attaches a file to a conversation; attachments exist only on
   issues. Building this means a storage surface for conversations, which is
   not this workstream's to design.
2. **Project context on a message.** Neither a conversation nor a message has a
   project field. Prefixing the body with a line of prose would look like the
   feature without being it.
3. **Steering a running reply.** Nothing in the runtime accepts input into a
   run that is already executing; a "steer" that merely queued another message
   would be the queue with a different label.
4. **Editing a queued message.** The session's task list carries ids, status and
   timestamps, not the text that was sent, so there is nothing to edit. Removing
   and re-sending is the honest equivalent and is present.
5. **Typing and failed row status in the conversation list.** The list reports a
   run being active, which is "working". There is no typing signal, and a
   failed reply is a property of a run rather than of the conversation.
6. **A run's `source` on agent activity.** The runs mount does not serialize
   `runs.source`; activity says whether the work came from an issue or a chat,
   which is what the payload supports. Widening `serializeRun` belongs to the
   runs workstream.
7. **MCP edit/rename/raw-JSON, and assigning a workspace server to an agent.**
   The MCP mount supports create, patch and delete per server; there is no route
   that copies or binds a workspace-library server onto an agent, and the
   existing manager covers the rest. Left as-is rather than forked into a
   parallel editor.

## Endpoints and schema added

All inside this workstream's migration block (169–172).

- `GET /api/v1/agents/roster?days=` — owner, runtime and its health, running and
  queued counts, run total, last activity and a filled day series, for every
  agent at once. The list draws a workload cell and a sparkline per row; the
  alternative was one request per row.
- `POST /api/v1/agents/:id/env/reveal` and `GET /api/v1/agents/:id/env/audit` —
  opening a sealed environment is a named act with a record. Migration **169**
  adds `agent_env_audit` (workspace-scoped, names only, never values) and
  `agents.created_by`, so an agent has an author.
- Migration **170** adds `agents.conversation_starters` and
  `agents.max_concurrency`, both written through `PUT /config`, which also now
  accepts `name` (rename) and an explicit null model pair (clear).
- The conversations list carries a truncated `lastMessage` and its author.

Tests: `agents.roster.test.ts`, `agents.env-audit.test.ts`,
`agents.config-extras.test.ts`, and an agents block in
`cross-tenant-leakage.test.ts` (the roster never carries another workspace's
agents; revealing or auditing a foreign agent's environment is the same 404 as
one that does not exist, and leaves no audit row behind).
