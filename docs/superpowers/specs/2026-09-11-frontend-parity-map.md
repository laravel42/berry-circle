# Frontend parity map — 2026-09-11

The seven frontend workstreams, in one place, as merged into
`feat/multica-parity`.

Each workstream audited its own surface against the behaviour checklist before
building, then re-read the audit against what it shipped. The per-area files
under `docs/superpowers/specs/parity-map/` are the working records and stay
where they are; this document is the whole picture and the order the branches
were merged in.

A word on the three columns below. **Present** is what the branch already did
before the work started — inherited behaviour that needed nothing. **Built** is
what the workstream added or finished. **Not built** is what it deliberately
left, each with a reason recorded in its own section: almost always that the
behaviour needs a server surface, a ledger shape or a component another
workstream owns, and that a screen which *looked* like the feature without
being it would be worse than its absence.

## Summary

| Area | Present | Built | Not built |
| --- | --- | --- | --- |
| **F6** shell, navigation, palette, shortcuts | Work and Manage rail sections, the workspace list and log-out, mod+K and Escape, copy-link and copy-identifier | Personal rail section with live counts, pinned section (status icons, drag, unpin, truncation), the new-task draft dot, a help menu with the server's own version, unread dots per workspace, pending invitations with inline join and decline, palette recents / member and page matching / highlights / theme commands / open-in-new-tab, the rebindable shortcut registry with its settings page, the attachment preview | — (every audited row landed) |
| **F2** task detail | Routing to a task, the description editor, sub-task list, the comment thread | The properties panel (due date, stage, labels, custom and archived properties), the shared run transcript, find-in-task, the subscriber popover, the run-confirm dialog, and the rebuilt create-task modal with a persisted draft and "create another" | Squads as an assignee and the run-confirm on assignee/status changes — both go through `AssigneeUser` / `StatusSelector`, which F1 shares and which expose no seam to intercept a write; disabling agents with no runtime, which the agent resource does not report; subscribing *another* person, for which there is no route |
| **F1** task lists, views and projects | The lists themselves, filters, saved views, drag and drop, the gantt | Date-range shortcuts, inline edits, the context menu, bulk selection with a batch toolbar, honest load and retry states, creator and updated-at on a row, per-layout display settings, the projects list controls | Scope switching on the project task tab and saved views, ordering by a custom property, load-more and per-group fetching, pre-filling a non-status value from a group header, custom-property editing on cards, a project card grid, a project emoji picker |
| **F3** inbox | The notification rows and their drawer | The full inbox page: two lists, facet filters with counts, keyboard navigation, archive and unarchive, read/unread, and a detail pane that renders the real task | Snooze — no screen in the checklist snoozes anything, so the endpoint would have no caller |
| **F4** agents and chat | The agent roster and the conversation list | The rebuilt agent detail (activity, work, capabilities), agent creation with a restorable draft, chat with threads and queued messages, and the floating chat window | Chat attachments, project context on a message, steering a running reply, editing a queued message, typing and failed-row status, a run's `source` on activity, and MCP editing — each needs a server surface that does not exist, and is named with its reason |
| **F5** workspace administration | The settings shell and its existing pages | Profile, preferences, tokens, workspace general, members, statuses, labels, properties and quick actions, plus workspace creation, joining, onboarding and the no-access state | Distinct expired / revoked / already-accepted invite screens, which would leak whether an invitation exists; declining, for which there is no endpoint; seat errors, which are billing |
| **F7** skills, squads, autopilots, usage, dashboard, runtimes | The six screens in outline | Role-aware editing across all six, squad instructions and avatars, autopilot dialogs and webhook deliveries, the usage breakdown and error views, runtime health and agent coverage | Autopilot "run only" output, which would be a change to the run ledger and the dispatcher; webhook delivery attempt counts, which the server does not store |

## Merge order

`fe/F6-shell` → `fe/F2-issue-detail` → `fe/F1-issue-lists` → `fe/F3-inbox` →
`fe/F4-agents-chat` → `fe/F5-workspace-admin` → `fe/F7-areas-polish`.

Shell first because six of the seven register something with it, and task
detail before the lists because the lists borrow its dialogs.


---

## F6 — shell, navigation, palette, shortcuts

*Source: `docs/superpowers/specs/parity-map/F6-shell.md`*

Workstream F6 owns `frontend/components/layout/**` (shell, rail, sidebar, command
palette, workspace menu), the global shortcut registry, the attachment preview
(modal and page), and the Settings › keyboard shortcuts page.

This file is the audit of that surface on branch `fe/F6-shell` (cut from
`feat/multica-parity`), written against the code actually on the branch, and
then updated as each item is built.

Legend: **present** — behaviour is there; **partial** — some of it is there,
what is missing is named; **missing** — nothing on the branch does this.

### Audit (before the work)

#### Sidebar (the shell rail)

| # | Behaviour | State | Notes |
| --- | --- | --- | --- |
| 1 | Personal section: inbox with an unread badge (99+ cap), my issues, chat with an unread count | missing | The rail has only Work and Manage (`shell-routes.ts`). The inbox exists as a bell in the tab strip (`notification-bell.tsx`) whose badge shows a digit up to 9 and then an empty dot, never `99+`. Chat is a Work item with no count, although `/api/v1/conversations` already returns `unread` per thread (`lib/chat.ts`). |
| 2 | Pinned section: pinned issues with status icon, projects and saved views; drag to reorder; unpin; show 5 then "show more"; silently drop pins whose target 404s; over `/api/v1/pins` | partial | `shell-pins.tsx` lists every pin as a plain link. No status icon, no drag, no unpin, no truncation, and the heading is a hardcoded English string. `lib/pins.ts` already wraps reorder and unpin but nothing calls them, and `pins-store.ts` has no reorder action. The server (`work/pins.ts` `listPins`) already leaves out a pin whose target is deleted or invisible, so "silently drop" is half-done at the source; the client never refetches, so a pin deleted elsewhere stays on screen for the life of the page. |
| 3 | Work and manage sections, as today | present | `SHELL_SECTIONS` with per-item visibility and order from `sidebar-prefs-store`. |
| 4 | "New issue" button with a dot when a create-issue draft exists | missing | `CreateNewIssue` is mounted hidden by `create-issue-modal-provider.tsx` and opened from the palette only. No button in the rail, and `create-issue-store` keeps no draft, so there is nothing a dot could report. |
| 5 | Help menu: docs, changelog, feedback, server version | missing | The rail foot has customize-sidebar and collapse only. The server knows its version (`VERSION` in `server-ts/src/index.ts`) but only publishes it on `/metrics`; `/api/v1/config` returns capabilities and no version. |

#### Workspace switcher

| # | Behaviour | State | Notes |
| --- | --- | --- | --- |
| 6 | Lists workspaces | present | `workspace-menu.tsx` renders the session's memberships with a check on the active one. |
| 7 | Dots for other workspaces that have unread items | missing | Unread is only ever loaded for the active workspace (`loadInboxUnreadCount` in the hydrate hook). |
| 8 | Create workspace → `/workspaces/new` | partial | The menu offers "create or join workspace" but routes to `/onboarding?add=1`. |
| 9 | Pending invitations with inline join and decline | missing | `GET /api/v1/invitations` already lists the caller's open invitations, but no browser client calls it. Joining from a list is impossible today: `POST /api/v1/invitations/:id/accept` demands the 53-character token, which the list deliberately does not carry, and there is no decline route at all (only an admin-side `DELETE /workspaces/:id/invitations/:id`). |
| 10 | Log out | present | `useSignOut` via the menu. |

#### Command palette

| # | Behaviour | State | Notes |
| --- | --- | --- | --- |
| 11 | mod+K toggles, including from inputs; Escape closes | present | A window-level keydown in `command-palette.tsx` fires wherever focus is; the Radix dialog closes on Escape. |
| 12 | Empty query: up to 20 recent issues, pages and commands | partial | Empty query shows Actions and Go-to. Nothing tracks recently visited issues, so there are no recents. |
| 13 | Typing matches pages by name and keywords, members locally, issues via the search API (debounced, limit 20, snippet highlights), projects; cancelled issues in their own group | partial | Pages match on their visible label only (cmdk's own filter), members are not searched at all, the search call is debounced but asks for `first=25` and renders no highlight, projects do come back via `PALETTE_SEARCH_TYPES`. The server's search rows carry no status, so a cancelled task cannot be told from any other. |
| 14 | Commands: new issue, new project, theme light/dark/system with the current one checked | partial | New issue is there; "plan something" stands where new project would be; there is no theme command even though `theme-toggle.tsx` already does the work through `next-themes`. |
| 15 | On an issue page: copy link, copy identifier, fold/unfold all comments (as an event) | partial | Copy task URL and copy task ID are there (plus more). Nothing folds comments, and there is no event for another component to listen to. |
| 16 | mod+Enter or mod+click opens a result in a new tab | missing | Every result is `router.push`. |

#### Global shortcut registry

| # | Behaviour | State | Notes |
| --- | --- | --- | --- |
| 17 | One exported module plus a provider hook other areas register with | missing | Shortcuts are three ad-hoc window listeners: ctrl+T / ctrl+W / ctrl+Tab in `berry-shell.tsx` and mod+K in the palette. Nothing can be registered from outside. |
| 18 | Defaults: C, mod+B, mod+/, mod+J, mod+F, E, mod+Enter, mod+[ , mod+] , plus unbound go-to actions | missing | None exist; `mod+B` in `components/ui/sidebar.tsx` belongs to the shadcn sidebar the shell does not render. |
| 19 | Ignore IME composition and key repeat | missing | No handler checks `isComposing` or `repeat`. |
| 20 | Remappable, persisted per user, documented API for F2/F3/F4 | missing | — |
| 21 | Settings › keyboard shortcuts page (search, record, validate, conflicts, per-row reset and disable, restore all behind a confirm, read-only fixed list) | missing | `settingsNav` has no such entry and no page exists. |

#### Attachment preview

| # | Behaviour | State | Notes |
| --- | --- | --- | --- |
| 22 | Modal: Escape closes, arrows move between attachments, image zoom and pan (keys, scroll, double-click, fit/actual), download, copy link, open in new tab, messages for too-large and unsupported files | missing | `issue-attachments.tsx` can only download. No preview of any kind. |
| 23 | `/[orgId]/attachments/[id]/preview` rendering HTML in a sandboxed iframe | missing | No route. The server side is ready: `GET /api/v1/attachments/:id` and `/:id/download` both exist. |

#### Other

| # | Behaviour | State | Notes |
| --- | --- | --- | --- |
| 24 | Navigation progress bar | missing | — |
| 25 | Sidebar auto-closes on narrow screens after navigating | missing | `railOpen` is persisted and never reacts to viewport width. |
| 26 | Unread badges update from the SSE stream | partial | `use-workspace-event-stream.ts` refreshes the inbox count on inbox-touching frames, which feeds the bell. There are no sidebar badges for it to feed, and chat unread is not refreshed at all. |

### Result (after the work)

Every row below is the same numbering as the audit.

| # | Behaviour | State |
| --- | --- | --- |
| 1 | Personal section with inbox / my issues / chat and live counts | present |
| 2 | Pinned section: status icons, drag to reorder, unpin, show 5 then more, 404 pins dropped | present |
| 3 | Work and manage sections | present |
| 4 | New-issue button with a draft dot | present |
| 5 | Help menu with docs, changelog, feedback and the server version | present — the three links are build-time settings (`NEXT_PUBLIC_DOCS_URL`, `NEXT_PUBLIC_CHANGELOG_URL`, `NEXT_PUBLIC_FEEDBACK_URL`); unset, a row renders disabled rather than pointing at somebody else's site. The version comes from the server that answered. |
| 6 | Workspace list | present |
| 7 | Unread dots on other workspaces | present |
| 8 | Create workspace links to `/workspaces/new` | present |
| 9 | Pending invitations with inline join and decline | present |
| 10 | Log out | present |
| 11 | mod+K toggle from anywhere, Escape closes | present |
| 12 | Recents, pages and commands on an empty query | present |
| 13 | Pages by keyword, members locally, issues via search with highlights, projects, cancelled group | present |
| 14 | New issue, new project, theme commands | present |
| 15 | Copy link, copy identifier, fold/unfold comments as an event | present |
| 16 | mod+Enter / mod+click opens in a new tab | present |
| 17 | `frontend/lib/shortcuts.ts` registry plus `useShortcut` / `ShortcutProvider` | present |
| 18 | Default bindings, including unbound go-to actions | present |
| 19 | IME composition and key repeat ignored | present |
| 20 | Remappable and persisted, with a documented registration API | present |
| 21 | Settings › keyboard shortcuts | present |
| 22 | Attachment preview modal | present |
| 23 | `/[orgId]/attachments/[id]/preview` with a sandboxed iframe | present |
| 24 | Navigation progress bar | present |
| 25 | Sidebar auto-closes on narrow screens after navigating | present |
| 26 | Unread badges update from the SSE stream | present |

#### What the shell stands in for

Three actions in the registry have no owner on this branch. They are registered
here anyway — so the binding, the settings row and the conflict checking are
all real — and the handler announces the moment on `window` instead of doing
anything (`frontend/lib/shell-events.ts`):

- `chat.toggleFloating` (mod+J) fires `berry:chat-toggle` — F4's floating chat.
- `issue.find` (mod+F) fires `berry:issue-find` — F2's find-in-issue.
- `composer.send` (mod+Enter) fires `berry:composer-send` — whichever composer
  has focus.

The palette's fold and unfold commands work the same way, firing
`berry:comments-fold` with `{ folded }` for whoever renders an issue's
comments.

Each is listed in the workstream's merge notes, with the exact call the owning
area needs to make.

#### Backend added

- `version` on `GET /api/v1/config`, so the help menu can name the server it is
  talking to. No new table, no workspace scope: the route is the unauthenticated
  build description and already carried the capability list beside it.
- `POST /api/v1/invitations/:id/join` and `POST /api/v1/invitations/:id/decline`,
  the two actions the switcher's invitation rows need. Both act only on an
  invitation addressed to the caller's own account — the same predicate that
  makes `GET /api/v1/invitations` list it — so a foreign or absent id is a 404.
- `status` on an issue row of `GET /api/v1/search`, which is what lets the
  palette group cancelled tasks apart. Additive; the frontend schema defaults it
  so an older server still parses.

---

## F2 — task detail

*Source: `docs/superpowers/specs/parity-map/F2-issue-detail.md`*

Audit of the issue detail surface on `fe/F2-issue-detail` (branched from
`feat/multica-parity`), and what was built against it.

Every line was checked against the code on this branch — the components under
`frontend/app/[orgId]/issue`, `frontend/components/common/issues/details`, the
`frontend/lib/*` clients they call, and the server mounts behind those calls.

- **Audit** is the verdict before this workstream started: **present** (behaves
  as described), **partial** (something real is there, but a named part of the
  behaviour is missing), **missing** (nothing on this branch does it).
- **After build** is the verdict now: **present**, or **not built** with the
  reason.

### Routing

| # | Behaviour | Audit | After build |
| - | - | - | - |
| R1 | UUID or identifier accepted; URL rewritten to the canonical identifier | **partial** — the page resolved either form through `getBoardIssue`, but nothing rewrote the address bar, so a UUID URL stayed a UUID URL. | **present** — the page replaces the URL with the task's key once it resolves, carrying the fragment across and using `replace`, so Back still leaves. |
| R2 | `#comment-<id>` scrolls to and highlights that comment, and reacts to hash changes | **missing** — no hash reading; comment cards carried no anchor. | **present** — every card carries `data-comment-id`; the page scrolls to it, marks it, listens for `hashchange`, and re-runs once comments have loaded. |
| R3 | Visit recorded in `localStorage` `berry.recentIssues` (`{id, identifier, title}`, newest first, capped at 20) | **missing**. | **present** — `lib/recent-issues.ts` owns the key and the shape; re-reading a task moves it to the front rather than adding it twice, and a task that turns out not to exist is dropped. |
| R4 | Skeleton; not found with a back link; deleted-while-open navigates away | **partial** — the not-found panel existed but was shown *while loading*, so a slow fetch told the reader the task did not exist. Deleted-while-open only worked when the reader did the deleting. | **present** — a skeleton while the fetch is in flight, the not-found panel only once it has answered, and a task that disappears underneath the reader closes the page. |

### Header

| # | Behaviour | Audit | After build |
| - | - | - | - |
| H1 | Breadcrumb with the project | **missing**. | **present** — project → task key → title, the project linking to its task list. |
| H2 | "sub-issue of" parent chip | **missing** — `parentId` was on the model and rendered nowhere. | **present** — a chip linking to the parent, in the header and again in the sidebar. |
| H3 | Live agent chip: who is working or queued, elapsed, tool-call count, view transcript, stop (with confirm), fed by the run events stream | **missing** — `activeRunId` was carried and never used. | **present** — `live-agent-chip.tsx`; elapsed ticks once a second, the tool count comes from the event stream, stop asks first. |
| H4 | Mark done | **missing** as a header action. | **present** — one button, which reopens as well as finishes. |
| H5 | Pin toggle | **present** (in the title row). | **present** — moved into the header beside the other task-level actions. |
| H6 | Right-sidebar toggle whose state is remembered | **missing** — the sidebar was always on, with no control. | **present** — `issue-view-store` persists it across tasks and sessions. |

### Title and description

| # | Behaviour | Audit | After build |
| - | - | - | - |
| T1 | Title inline edit | **missing** — a plain `<h1>`. | **present** — Enter or blur saves, Escape reverts, an empty title is refused and rolled back. |
| T2 | Description autosave | **present**. | **present** — unchanged. |
| T3 | Drop files onto the description, or an upload button | **partial** — an upload button existed further down the page under a different heading; the description took no drop, and the paperclip above the feed was decorative. | **present** — the description is the drop target and carries its own upload button. |
| T4 | Image viewer stepping through the issue's images | **missing**. | **present** — images are fetched as blob URLs (the download route needs the session header, so `<img src>` cannot reach it) and revoked on unmount. Arrow keys step; a counter says where you are. |
| T5 | Emoji reactions on the issue | **present**. | **present** — unchanged. |

### Sub-issues

| # | Behaviour | Audit | After build |
| - | - | - | - |
| S1 | Collapsible, x/y progress, grouped by stage | **partial** — progress and a stage chip, but a flat list that could not be collapsed. | **present** — grouped under stage headings, with the whole block foldable. |
| S2 | Inline status and assignee per row | **missing** — the status was text; there was no assignee. | **present** — both edit in place and write straight through, rolling back on refusal. |
| S3 | Add a new sub-issue, or attach an existing one through a debounced picker that excludes self and descendants | **partial** — creating worked; attaching had no UI. | **present** — a debounced search whose exclusion set is the task plus every task beneath it, walked breadth-first and bounded. |
| S4 | Collapsed state remembered per issue | **missing**. | **present** — persisted per task identifier. |

### Sidebar

| # | Behaviour | Audit | After build |
| - | - | - | - |
| P1 | Properties: status, assignee, project, priority, stage, dates, labels, "add property" menu; archived properties read-only | **partial** — status, priority, assignee and a read-only project row. No dates, labels, stage or add-property menu, and `archivedAt` was parsed then ignored. | **present**, with one exception — due date, stage and labels added; custom fields appear when they have a value or are chosen from the "add property" menu, and archived ones render as read-only values with a reason. **Squads as an assignee: not built** — `AssigneeUser` is shared with the board (F1), and giving it a squad branch means changing a component another workstream owns. |
| P2 | Quick actions panel with result states: started, folded into the current run, blocked (with the reason), comment posted | **partial** — a dropdown that toasted "started" or a generic failure. | **present** as a panel with four distinct outcomes read from the server's refusals. "Comment posted" is in the vocabulary but the run endpoint answers `{runId}` only, so it is reachable only once the server distinguishes it. |
| P3 | Parent issue with remove | **missing**. | **present**. |
| P4 | Keep K's linked-PR panel | **present**. | **present** — untouched. |
| P5 | Execution log: active runs pinned, past runs behind a toggle, newest first | **missing** — runs were grey one-liners in the feed. | **present**. |
| P6 | Per run: status, trigger kind (initial, comment, autopilot, retry #n), attribution, failure or cancel reason in plain language | **missing**, and not expressible: `serializeRun` exposed neither `source` nor `requested_by`. | **present** — the serializer now carries both (no schema change; the columns existed). "Retry #n" is derived: a retry is another run with the same trigger on the same task, so the count is how many came before it. |
| P7 | Cancel (with a confirm), retry, open transcript | **partial** — cancel existed on the runs page only, without a confirm. | **present** — all three per row, cancel behind a confirm that says what stopping costs. |
| P8 | Token and cost total opening a usage breakdown: cost, cache savings, tokens, per-agent totals, per-run table | **partial** — three numbers, no dialog. | **present** — per-agent totals are folded from the per-run rows and the runs already on the page rather than asked of the server, so one source owns the arithmetic. |
| P9 | Details (created by, created, updated) and a metadata dialog | **missing** — the fields were parsed and dropped; the metadata endpoint had no client. | **present** — plus `lib/issue-metadata.ts`. |

### Transcript dialog (shared component)

| # | Behaviour | Audit | After build |
| - | - | - | - |
| X1 | A shared `runs/transcript-dialog.tsx` | **missing** — the only transcript was a `<pre>` inside the runs page. | **present**. |
| X2 | Newest first; follows live output; End or scrolling breaks out of following | **missing**. | **present** — newest first, so following means staying at the top; scrolling away stops it and End resumes. |
| X3 | Search, and filter by step kind (tool, thinking, error; command, edit, read) | **missing** — the stream was flattened to one string, so there were no steps. | **present** — `foldRunEvent` turns the event stream into steps; tool names are classified into edit/read/tool by verb. |
| X4 | Per-step input and result with copy | **partial at the data layer** — commands carry their text, output and exit code; the ledger deliberately never records tool arguments or output. | **present within what the ledger records** — commands show both halves with copy; a tool step shows its name and outcome, because that is all that exists. |
| X5 | Token usage and cost, and an outcomes summary (files changed, commands run) | **partial at the data layer**. | **present** — usage and cost from the run, files changed from `run.delivered`, commands counted from the steps. |
| X6 | Keyboard scrolling | **missing**. | **present** — the list itself is focusable, so arrows, Page keys and Home/End reach it. |
| X7 | Exported for F4 to reuse | **missing**. | **present** — `RunTranscriptDialog` and `foldRunEvent` are both exported. |

### Activity and comments

| # | Behaviour | Audit | After build |
| - | - | - | - |
| A1 | Timeline mixes comments and activity; consecutive activities coalesced (xN) with "show more" | **partial** — merged by time, never coalesced. | **present** — consecutive bookkeeping folds into one row; a comment between two runs of it keeps them apart. |
| A2 | Threaded replies, collapsing a thread | **missing** in the UI — the server already stored and serialised `parentId`. | **present** — replies render under their root and fold away; the client now sends `parentId`. |
| A3 | Resolve or unresolve a thread, optionally with a comment; resolved threads fold into a summary bar | **partial** — resolve existed in the menu; no optional comment, no folding. | **present** — resolving offers a closing comment, and resolved threads collapse into a counted bar. |
| A4 | Comment menu: copy; create a sub-issue; edit (own, or any for moderators); delete with a confirm that warns about replies | **partial** — no copy; the moderator case was hidden even though the server allows it; the delete confirm was a bare `window.confirm` that said nothing about replies. | **present** — all four, with the reply count named in the confirm. |
| A5 | Comment reactions | **present**. | **present** — unchanged. |
| A6 | An agent run appears inline under the comment that triggered it, streaming live with a stop control | **missing**. | **present** — a mention-triggered run is attached to the last comment written before it, streams while live, and can be stopped there. |

### Composer

| # | Behaviour | Audit | After build |
| - | - | - | - |
| C1 | Per-issue draft surviving a close | **missing** — the draft lived in component state. | **present** — persisted per task; replies keep their own local draft. |
| C2 | Send on mod+Enter (F6's registry if present, else a local handler marked for merge) | **partial** — a local handler, unmarked. | **present** — local handler, marked `wire to shortcut registry at merge (F6)`; no registry exists on this branch. |
| C3 | Sending blocked while uploads are in flight | **missing** — the composer could not upload at all. | **present** — the composer uploads, and Send is disabled until they land. |
| C4 | @mentions of members, agents, squads, "all", issues and projects, grouped; agents without a runtime disabled | **partial** — agents and squads in one ungrouped list. | **present** except the disabled state — grouped, with people, "all", tasks and projects added. **Agents without a runtime: not built** — the agent resource exposes no runtime binding, so "has no runtime" is not knowable from the client and a guess would disable the wrong agents. The picker supports the state; only the fact is missing. |
| C5 | Slash commands: skills, plus a built-in "note" that triggers no agent | **missing**. | **present** — a leading `/` offers the skills catalogue and `note`, which demotes every mention to plain text so nothing starts. |
| C6 | Typed or pasted issue keys auto-link | **missing**. | **present** — task keys are linked wherever they appear in a comment. |
| C7 | Trigger preview chips; click to skip or restore; the reason when blocked; a partial-trigger toast after sending | **partial** — two sentences, not chips; nothing clickable. | **present** — chips toggle. A skip is honoured by demoting that agent's mention token to plain text before sending, which is what the server reads; the POST body has no "skip" field, so this is the only way to mean it without a new endpoint. |

### Subscriptions

| # | Behaviour | Audit | After build |
| - | - | - | - |
| B1 | Subscribe button | **present**. | **present**. |
| B2 | Popover to edit subscribers | **missing** — the list was fetched and reduced to a count. | **present** for reading — the popover names them and why each is following. **Changing someone else's subscription: not built** — the endpoints act on the caller (`PUT`/`DELETE /subscription`); there is no route for subscribing another person. |
| B3 | "Unsubscribe from this issue and its sub-issues" | **present**. | **present** — also offered inside the popover. |

### Find in issue

| # | Behaviour | Audit | After build |
| - | - | - | - |
| F1 | mod+F opens it; Enter next, Shift+Enter previous; current/total; Escape closes | **missing**. | **present** — matches are painted with the CSS Custom Highlight API, so no DOM React owns is rewritten. |
| F2 | Restore scroll position when coming back to an issue | **missing**. | **present** — per task, for the session only: a two-day-old offset against an edited description lands nowhere. |

### Run confirm dialog

| # | Behaviour | Audit | After build |
| - | - | - | - |
| N1 | Shown when assigning to an agent or squad, or moving an agent-owned issue out of backlog; start now, or apply without starting | **missing**. | **partial** — the dialog is built and asked in the create-issue modal, where "apply without starting" creates the task in the backlog (the one state an assigned agent is never dispatched from). **Asking on the detail page's assignee change, and on moving out of backlog, is not built**: both go through `AssigneeUser` / `StatusSelector`, which the board (F1) shares, and neither exposes a seam to intercept the write. See the wiring notes. |
| N2 | Used for bulk assignment; exported for F1 | **missing**. | **present as an export** — `RunConfirmDialog` and `useRunConfirm` take a count for the bulk case; F1 wires it to its selection. |

### Create-issue modal

| # | Behaviour | Audit | After build |
| - | - | - | - |
| M1 | Manual mode: title, description with uploads, status, priority, assignee, dates, labels, project, custom properties, parent (lockable), stage, sub-issues to link | **partial** — title, description, status, priority, assignee, project. | **present** — the rest added. Attachments are held until the task exists and uploaded immediately after, because an attachment needs a task to belong to. |
| M2 | "Create another", and a persisted draft | **missing**. | **present** — the draft persists; "create another" keeps the context and clears what was typed. |
| M3 | Defaults pre-filled from context | **partial** — only the board column. | **present** — column, project and parent, through `openModalWith`. |
| M4 | A hint saying whether an agent will start | **missing**. | **present**. |
| M5 | Duplicate (409) shows a view-existing toast | **missing** — a 409 fell into the generic error. | **present** — the toast offers to open the existing task when the server names it. |
| M6 | Agent quick-create: pick an agent or squad, a one-line prompt, attachments; the toast says the result arrives in the inbox | **missing**. | **present**. |

### Backend added

Three gaps blocked the screens above. None needed a schema change, so this
workstream did not use its migration block (163–166).

1. **An issue's labels.** `issue_label_memberships` had existed since the
   catalogue migration and was read by the query builder, but no route exposed
   it — labels could be filtered on and never set. Added `GET` and
   `PUT /api/v1/issues/:issueRef/labels` (`work/labels.ts`): a replace rather
   than an add/remove pair, so two concurrent edits converge on a set somebody
   chose. A label from another workspace, or an archived one, is a 404. Both
   routes hang off the issues mount's find-before-permission resolver and are
   asserted in `cross-tenant-leakage.test.ts`.
2. **Why a run started, and who asked.** `serializeRun` dropped the `source`
   and `requested_by` columns it already had in hand. Both are now on the wire,
   which is what lets the execution log tell an assignment from a mention from
   an autopilot. `docs/api/gateway-v1.md` updated to match.
3. Nothing else. The quick-action endpoint still answers `{runId}` only; the
   panel reads its four outcomes from the server's refusals instead.

### Verification

- `pnpm lint` — clean.
- `pnpm exec prettier --check` on every file this workstream touched — clean.
  Five files in `components/common/issues/details` that this workstream never
  edited (`issue-artifacts`, `issue-attachments`, `issue-linked-pull-requests`,
  `issue-pin-button`, `issue-reactions`) were already unformatted on the branch
  and were left alone rather than reformatted into someone else's diff.
- `pnpm build:check` — compiles, types check.
- `python3 scripts/check-locale-catalogues.py` — 4 locales × 10 namespaces
  agree. New strings live in their own `issueDetail` namespace so the six other
  workstreams do not collide inside one file.
- `pnpm typecheck:server` — clean.
- Server tests on a private database (`berry_test_f2_issue_detail`):
  `work/labels.test.ts` 7/7, `mounts/cross-tenant-leakage.test.ts` 9/9,
  `runs/ledger.test.ts` + `runs/repository.test.ts` 21/21.

### Notes on scope

- Runtimes are AgentCore runtimes. Nothing here builds a local runtime, a CLI,
  a desktop or mobile surface, or any integration but GitHub.
- The linked-PR panel (K's) is untouched.

---

## F1 — task lists, views and projects

*Source: `docs/superpowers/specs/parity-map/F1-issue-lists.md`*

Workstream F1 owns the task lists (`my-issues`, the project task surfaces, saved
views), the view and table components under `frontend/components/common/issues`
(everything except `details/`), and the saved-view screens.

This file was written as an audit of what the branch inherited, and is now the
record of what it ships. Every item below reads **present** or **not built**
with the reason it was left.

### Where the behaviour lives

- `frontend/components/common/my-issues/*` — the tasks page and its scopes.
- `frontend/components/common/issues/*` — rows, cards, table, swimlanes, gantt,
  grouping, filters, selection, the working-agents chip, load states.
- `frontend/components/common/views/*` — the saved-views bar, the save/edit
  dialog, the views page, the view detail body.
- `frontend/components/common/projects/*` — the projects list and the project
  detail panel.
- State: `store/filter-store.ts` and the layout/display params (URL),
  `store/display-settings-store.ts` and `store/view-store.ts` (browser),
  `store/issue-selection-store.ts`, `store/projects-filter-store.ts` (URL).
- Server, all of it pre-existing: `/api/v1/views` (CRUD, `/preferences`,
  `/query`), `/api/v1/issues` (`/batch`, `/batch-delete`, `/quick`,
  `/children`, `/parent`, `/assignee-frequency`), the issue-property catalogue,
  and `/api/v1/pins`. **No endpoint was added.**

### Issues list

| Item | Status |
| --- | --- |
| Scope switch on the tasks page: all, assigned, created, my agents & squads | **present** — URL-backed; the agent scope covers the workspace's agents and the rosters of the squads this person is in. |
| Scope switch on the project tab and on saved views | **not built** — a project tab is already scoped to its project and a saved view to its own query; a second scope control there would fight the one the view saves. |
| Everything synced to the URL | **present** — filters, scope, layout, grouping, ordering and direction all read from the URL first and fall back to the stored settings, so a link reproduces the sender's list without overwriting the reader's defaults. |
| View modes board, list, table, swimlane, gantt | **present** on the tasks page, the project task tab and a saved view. |
| The mode is remembered | **present** |

### Filter menu

| Item | Status |
| --- | --- |
| Status, with counts | **present** — counts come from the filtered data itself. |
| Priority | **present** |
| Assignee: members, agents, squads, no assignee | **present** — squads are their own section, matching whatever the leader or the roster holds. |
| Creator | **present** — the task model now carries the creator the API already sent. |
| Project, including "no project" | **present** |
| Label | **present** as a section; tasks still carry no labels from the list endpoint, so it matches nothing until that lands (outside F1). |
| Date created / updated: today, 3 days, 7 days, custom range | **present** |
| Custom properties: is, contains, before, after, empty | **present** — answered by the view query and applied as one intersection, capped at the 200 ids that query returns. |
| Every section searchable | **present** |
| One reset | **present** |
| Removable chips | **present** |
| Chip bar saves as a new view | **present** |
| Chip bar saves into the current view | **present** — sends the revision it read. |
| Working-agents chip: count, hover list, click to filter | **present** |

### Display options

| Item | Status |
| --- | --- |
| Grouping per mode | **present** — status / assignee / priority / project / none, plus parent and a workspace field for the table and swimlanes. |
| Ordering: manual, status, priority, dates, created, updated, title | **present** |
| Ordering by a custom property | **not built** — field values are not on the list payload, and the view query can group by a field but not order by one. |
| Ascending / descending | **present** |
| Sub-issue toggle | **present** — and it now hides sub-tasks instead of only remembering the switch. |
| Card property toggles | **present** |
| Table: hierarchy nesting | **present** |
| Table: searchable column picker | **present** |
| Table: hide columns | **present** |
| Table: drag to reorder columns | **present** |
| Table: footer count, sum, average | **present** — sum and average over the numeric columns. |
| Table: title and identifier search | **present** |
| Table: CSV export of all or selected rows, with a toast | **present** |
| Board: hide columns | **present** |
| Board: restore hidden columns | **present** — in the same strip that lists the filter-emptied ones. |

### Saved views

| Item | Status |
| --- | --- |
| Tabs with drag reorder and an overflow menu | **present** |
| Tab menu: edit, pin/unpin to the sidebar, hide/show, delete with a confirm | **present** |
| Manage-views dialog, order and visibility per user | **present** — both live in that person's view preferences on the server. |
| Save/edit dialog: name, private or shared, filters, layout, display defaults, scope | **present** |
| Conflict toast when someone else edited the view | **present** |
| A missing view shows an info toast and exits | **present** |
| Uses the existing saved-view endpoints | **present** |

### Inline edits

| Item | Status |
| --- | --- |
| Rows and cards: status, priority, assignee | **present** |
| Rows and cards: dates, labels, project | **present** — inline in the table, through the right-click menu on rows and cards. |
| Custom properties inline | **present** in the table; **not built** on cards — a card would need a popover per field, and the values are only readable in bulk through the grouped query the table already runs. |
| Table title rename: Enter saves, Escape cancels | **present** |
| Quick-add row | **present** — in the table and above every list. |
| Add button on each group header | **present**; pre-filling a non-status group value is **not built** — the create modal accepts a default status and nothing else. |

### Context menu

| Item | Status |
| --- | --- |
| Status, priority, assignee submenus | **present** — agents beside members. |
| Quick date picks: today, tomorrow, next week, clear | **present** |
| Open in new tab | **present** |
| Pin | **present** |
| Copy link | **present** |
| Relations: create sub-issue, set parent, remove parent, add existing sub-issue | **present** |
| Delete | **present**, with a confirmation. |

### Selection

| Item | Status |
| --- | --- |
| Checkboxes on rows, cards and table rows | **present** |
| Shift-range selection | **present** |
| Select all | **present** — over what the filters are showing. |
| Bulk toolbar: count, clear, status, priority, assignee, delete with a confirm | **present** |
| Assigning to an agent goes through a run confirmation | **present**, against a local stand-in — see the wiring note below. |
| Uses the batch endpoints | **present** |

### Drag and drop

| Item | Status |
| --- | --- |
| Board: reorder within a column | **present** |
| Board: move across columns to change the grouped field | **present** — status, assignee, priority and project all write. |
| List: move between groups | **present** |
| Swimlanes: move cells, reorder lanes | **present** |
| Table: reorder columns | **present** |
| Auto-scroll near the board edge | **present** |

### Loading

| Item | Status |
| --- | --- |
| Load more with retry | **not built** — the list endpoint is drained in full (up to twenty pages) on first load, so there is no cursor left to continue from. The retry half exists: a failed load says so and can be run again. |
| Per-group loading in the table | **not built** as a per-group fetch, for the same reason; the group header shows the list-level loading marker while a load is in flight. |
| Virtualized large board columns | **present** — past forty cards a column renders only what is in view. |

### Gantt

| Item | Status |
| --- | --- |
| Zoom by day, week, month | **present** |
| Toggle to show completed | **present** |
| Today line | **present** |
| Shaded weekends | **present** |
| Warning when dates are inverted | **present** — counted and named rather than drawn backwards. |

### States

| Item | Status |
| --- | --- |
| Skeleton per mode | **present** |
| Status-catalogue error with retry | **present** as the list-load error with retry. Berry's statuses are a local catalogue, so the failure this covers is the task list itself, which used to fail silently into an empty board. |
| Filters-empty state with a clear button | **present** |
| Workspace-empty state | **present** |
| Toast when a grouped property was deleted | **present** — and the grouping falls back to status. |

### Projects

| Item | Status |
| --- | --- |
| List: table or cards | **present** in substance — rows (list), cards (board) and a timeline; **not built** as a separate card grid beside the table. |
| Search | **present** |
| Filters: status, priority, lead (and health) | **present** |
| Sort | **present** |
| Column visibility | **present** |
| Inline edits | **present** |
| Row menu: pin, delete with a confirm | **present** |
| Bulk pin | **present** |
| Detail sidebar: title, status, priority, lead, dates, progress | **present** |
| Detail sidebar: emoji icon | **not built** — a project's icon is a glyph from the icon set, and an emoji picker would be a second, conflicting identity for the same field. |
| Description marked as agent context | **present** |
| Resources: attach or remove a GitHub repo | **present** (inherited) |
| Pin, copy link, delete on the detail | **present** |

### Not built, in one place

1. A scope switch on the project task tab and on saved views.
2. Ordering by a custom property.
3. Load more, and per-group loading as a per-group fetch.
4. Pre-filling a non-status value from a group header's add button.
5. Custom-property editing on board cards.
6. A separate card grid for projects.
7. An emoji icon picker on a project.

### Wiring left for the merge

- `components/common/issues/run-confirm-dialog.tsx` is a local stand-in for the
  agent workstream's run confirmation. The call site in `batch-toolbar.tsx`
  passes the agent, the task count and a confirm callback; swap the component,
  keep the props.
- The `issueLists` namespace is registered in `frontend/lib/i18n/locales.ts`,
  `frontend/i18n/messages-en.ts` and `scripts/check-locale-catalogues.py` — one
  line each, and the likeliest conflict with another workstream's namespace.
- `components/data-table-filter/components/filter-value.tsx` (vendored) gained
  the three date shortcuts. The rest of that file is untouched and deliberately
  left in its own formatting.
- `hooks/use-hydrate-workspace-data.ts`, `store/issues-store.ts` and
  `lib/issues.ts` carry the list's load state, the retry, and the creator and
  updated-at fields the list now reads.

---

## F3 — inbox

*Source: `docs/superpowers/specs/parity-map/F3-inbox.md`*

Workstream F3 owns `/[orgId]/inbox`, `frontend/components/common/inbox/**` and the
notifications drawer. This file records what the branch actually had when the workstream
started, and what it has now.

Audit taken on branch `fe/F3-inbox` (cut from `feat/multica-parity`).

### Audit, before the work

Berry had no inbox page. Notifications lived only in a right-hand drawer
(`frontend/components/layout/notifications/notifications-drawer.tsx`), backed by
`frontend/store/notifications-store.ts` and `frontend/lib/inbox.ts`, over a server mount
(`server-ts/src/mounts/inbox.ts`) that was already fairly complete.

| # | Behaviour | Before |
| --- | --- | --- |
| 1 | `/[orgId]/inbox` route exists | **missing** — no directory under `frontend/app/[orgId]`. `shell-routes.ts` declares an `inbox` route id and `sidebar-prefs-store.ts` an `inbox` key, but nothing renders either. |
| 2 | List + detail split, switching to one pane on compact widths | **missing** — the drawer is a single list; there is no detail pane anywhere. |
| 3 | Selection in the URL as `?issue=`, archived view as `?view=archived` | **missing** — drawer selection is store state; the archived state (`state=archived`) is never requested. |
| 4 | Notification types: assigned, unassigned, subscribed, field change, comment, mention, review requested, run completed/failed, agent blocked/completed, reaction, autopilot paused | **partial** — `data/inbox.ts` knows comment, mention, assignment, status, reopened, closed, edited, created, upload, approval, goal, workflow, plan. Nothing distinguishes unassigned from assigned, subscribed, a plain field change, a review request, run outcome, agent blocked/completed, a reaction or a paused autopilot. The classifier in `lib/inbox.ts` is a substring match over `eventType`/`category`. |
| 5 | Issue-backed item embeds the issue detail | **missing** — and not directly possible: `components/common/issues/details/issue-details.tsx` reads `issueId` from `useParams`, so it only renders under `/issue/[issueId]`. |
| 6 | The related comment is highlighted | **missing**. |
| 7 | Archive from the detail | **missing** — no archive control exists in any notification UI. |
| 8 | Items without an issue show title and body | **partial** — the drawer row shows title and a two-line clamp of the body; there is no detail view of them. |
| 9 | Agent-create outcomes show the original prompt and offer "retry with the original context" | **missing** — and unreachable: `inbox_items.details` (jsonb, where such a prompt is recorded) was not serialized by `GET /api/v1/inbox`. |
| 10 | Selecting an item marks it read, unless the user just marked it unread | **partial** — the drawer marks read on open; there is no "just marked unread" memory, and no unread action in the UI at all. |
| 11 | Per-row read/unread, archive, unarchive, open in new tab — from a menu, right-click and hover | **missing** — `updateInboxItem` supports all four actions and the server implements them; no UI calls archive or unarchive. |
| 12 | Bulk: mark all read, archive all, archive read, archive completed | **partial** — "Mark all read" exists in the drawer and in the store (`markAllAsRead`, batched through `/inbox/bulk`). The three archive sweeps do not exist. |
| 13 | Archiving moves the selection to the next item, or the previous one | **missing**. |
| 14 | Filters: status and priority with counts, sender, unread only, clear | **missing** — the API takes `unread=true` and `state=`, but `loadWorkspaceInbox` hard-codes `state=active`, `first=50` and no unread filter. No filter UI. |
| 15 | A filter that hides the selected item clears the selection | **missing**. |
| 16 | Keyboard: up/down move and scroll the selection; `E` archives (unarchives in the archived view), ignored in inputs and under a modal | **missing** — there is no shortcut registry on this branch at all (F6's registry is not here), and no key handling in notification UI. |
| 17 | States: loading, empty, no matches with a clear button, empty archive, error when the archived list fails | **partial** — the drawer has one empty line ("Nothing has happened yet"). `loadWorkspaceInbox` swallows every error and returns `[]`, so a failure is indistinguishable from an empty inbox. |
| 18 | Unread badge | **present** — `notification-bell.tsx`, local count with the server count as the pre-hydration fallback. |
| 19 | Toasts for arrivals | **present** — `notification-toasts.tsx`, capped at three plus an overflow toast. |
| 20 | Redirect when the item's issue was deleted | **missing** — the server already resolves `issueIdentifier` through a `deleted_at IS NULL` join, so a deleted issue comes back as `issueId` set with a null identifier. The frontend ignored the signal. |
| 21 | Backend: list, unread-count, bulk, per-item actions, archive | **present** — `server-ts/src/mounts/inbox.ts`, recipient-scoped in SQL, membership-guarded through `boards.authorizeWorkspace`. |
| 21b | Backend: snooze | **missing** — no column, no route, nothing calls one. |
| 22 | The drawer keeps working and links to the full page | **partial** — the drawer works; there was no page to link to. Its strings were hard-coded English, outside the catalogues. |

### After the work

Everything above that read missing or partial was rebuilt, except the one row that had no
screen asking for it. The new page is `frontend/app/[orgId]/inbox/page.tsx` over
`frontend/components/common/inbox/**`.

| # | Behaviour | Now |
| --- | --- | --- |
| 1 | `/[orgId]/inbox` route | present — `frontend/app/[orgId]/inbox/page.tsx` with its own header. |
| 2 | List + detail split, one pane when compact | present — `inbox.tsx`; below `md` the pane follows the selection, with a back control. |
| 3 | `?issue=` and `?view=archived` | present — both are nuqs query state, shared by the header, the list and the detail. |
| 4 | Notification types | present — `notificationType()` in `lib/inbox.ts` classifies assigned, unassigned, subscribed, field change, comment, mention, review requested, run completed, run failed, agent blocked, agent completed, reaction and autopilot paused, each with its own icon and label. |
| 5 | Issue-backed detail embeds the issue detail | present — renders the existing `IssueDetails`, which now takes an optional `issueRef`. Marked for merge: swap to F2's component when it lands. |
| 6 | Related comment highlighted | present — the detail carries a comment banner naming the comment the notification is about, with its body. |
| 7 | Archive from the detail | present. |
| 8 | Items without an issue show title and body | present. |
| 9 | Agent outcome prompt + retry | present — `GET /api/v1/inbox` now serializes `details`, and an agent-authored outcome shows the recorded prompt and a retry that re-runs the task with it. |
| 10 | Select marks read, unless just marked unread | present — the store keeps a per-session "held unread" set that selection respects. |
| 11 | Per-row actions from menu, right-click and hover | present. |
| 12 | Bulk sweeps | present — mark all read, archive all, archive read, archive completed. |
| 13 | Archive moves the selection on | present — next, else previous, else nothing. |
| 14 | Filters | present — status and priority with counts, sender, unread only, and a clear control. |
| 15 | Hidden selection is cleared | present. |
| 16 | Keyboard | present — up/down with scroll-into-view, `E` to archive or unarchive. Ignored in inputs, contenteditable and while a dialog is open. Registered through a local handler; marked for merge onto F6's registry. |
| 17 | States | present — loading, empty, no matches (with clear), empty archive, and an error panel with a retry when the archived list fails. |
| 18 | Unread badge | present (unchanged). |
| 19 | Toasts | present — arrivals as before, plus action toasts for archive/unarchive and the bulk sweeps. |
| 20 | Deleted issue | present — the detail says the task is gone and sends the reader back to the list. |
| 21 | Backend | unchanged apart from one added field (`details`) on the existing list route. |
| 21b | Snooze | **not built** — no screen in this checklist snoozes anything, and the project rule is that a backend addition needs a screen that requires it. Nothing in the UI, the store or the client references snoozing, so the endpoint would have no caller. |
| 22 | Drawer | present — same behaviour, now translated, with a footer link to the inbox page. |

### Wiring this needs at merge

- **F2's task detail.** `IssueDetails` now takes an optional `issueRef`, so a surface that
  is not routed at a task can still show one (`frontend/components/common/issues/details/issue-details.tsx`,
  three lines). When F2's detail component lands, the inbox detail should render that
  instead — one import in `inbox-detail.tsx`.
- **F6's shortcut registry.** Up, down and `E` are a local `keydown` listener in
  `frontend/components/common/inbox/use-inbox.ts` (`useInboxKeyboard`), because this branch
  has no registry to register with. Moving them is a change to that one hook.
- **The message namespace.** `inbox` is registered in three places, one line each:
  `frontend/lib/i18n/locales.ts`, `frontend/i18n/messages-en.ts` and
  `scripts/check-locale-catalogues.py`. Anyone else adding a namespace touches the same
  three lines.
- **The rail.** `shell-routes.ts` already declares an `inbox` route id and
  `sidebar-prefs-store.ts` an `inbox` preference key, both unused. Whoever owns the shell
  can point an entry at `/[orgId]/inbox`; this workstream did not edit the route table, so
  the page is reached from the drawer's footer link.
- **The command palette.** No inbox entry was added — that file belongs to the shell.
- **Cross-tenant coverage.** The inbox mount is not new, so it was not added to
  `cross-tenant-leakage.test.ts`. Its isolation is asserted in the new
  `server-ts/src/mounts/inbox.test.ts`: another member's rows are invisible and
  unactionable, and a foreign workspace is a 404 rather than an empty list.

---

## F4 — agents and chat

*Source: `docs/superpowers/specs/parity-map/F4-agents-chat.md`*

Branch `fe/F4-agents-chat`, cut from `feat/multica-parity` at `a73d2fa`.

Surfaces owned: `frontend/app/[orgId]/agents/**`, `frontend/app/[orgId]/chat/**`,
`frontend/components/common/agents/**`, `frontend/components/common/chat/**`,
and a floating chat window.

The audit below was taken against the code as it stood on the branch, then
re-taken after the work. Every row now reads **present** or **not built** with
the reason. Nothing is marked present that a reader could not go and use.

---

### 1. Agents list

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

### 2. Agent detail

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

### 3. Create

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

### 4. Chat

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

### 5. Floating chat window

| Item | Now |
| --- | --- |
| On every page except `/chat` | **Present.** |
| Toggled with mod+J | **Present**, via a local handler — see merge wiring. |
| Expand, restore, minimise, resize | **Present**; the size is remembered per browser. |
| History dropdown and agent picker | **Present.** |
| Full-screen sheet on narrow widths | **Present.** |

---

### Not built, and why

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

### Endpoints and schema added

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

---

## F5 — workspace administration

*Source: `docs/superpowers/specs/parity-map/F5-workspace-admin.md`*

Audited on branch `fe/F5-workspace-admin`, cut from `feat/multica-parity` at `a73d2fa`.

Scope: `frontend/app/[orgId]/settings/**` (minus keyboard shortcuts, which is F6),
`frontend/app/[orgId]/members/**`, profiles, onboarding, `/invitations`, `/invite/[id]`,
`/join`, `/workspaces/new`, and the no-access states.

Each row records what the code on this branch actually does — the component, the store, the
`lib/*` client, and the server route behind it — not what a screen appears to offer. The
**Was** column is the state at `a73d2fa`; **Now** is the state after this workstream.

---

### Settings shell

| Item | Was | Now |
| --- | --- | --- |
| Tab groups (personal / workspace / issue config / connections) | partial — two groups, with issue config and connections folded into "workspace"; no general, members or tokens entries | **present** — `nav-settings.tsx` holds four groups. Members links to `/members` rather than a settings clone, because that is the page people bookmark. |
| Shortcuts, a link to F6's page | missing | **present** — listed under Personal at `/settings/keyboard-shortcuts`. The page itself is F6's; see the wiring note below. |
| Dropdown instead of tabs on narrow screens | missing | **present** — `headers/settings/header-nav.tsx` renders the same `settingsNav` as a dropdown, `lg:hidden`, so it and the rail are never both the navigation. |
| Shared autosave (debounce, save on blur, saving / saved / failed) | partial — an optimistic `mutate` with rollback, no debounce and no indicator | **present** — `use-autosave.ts` debounces, commits on blur, and reports state; `save-indicator.tsx` shows saving / saved / failed with a retry. Used throughout the General page and the profile. |

### Profile

| Item | Was | Now |
| --- | --- | --- |
| Avatar | partial — read-only | **present** — the address is editable and autosaves; `PATCH /me` already validated it. |
| Name, autosaving, blocked while blank | present | **present** |
| "About you", ≤2000 characters, counter, shared with agents | missing, and no column | **present** — `users.description` (migration 173), on `GET`/`PATCH /me`, with a counter, and carried into agent context. |

### Preferences

| Item | Was | Now |
| --- | --- | --- |
| Theme | present | **present** |
| Language — local, synced to the account, then reload | present | **present** |
| Timezone — browser default or an IANA zone, on the account | partial — the browser's zone was hoisted but unlabelled among several hundred | **present** — it leads the list and names itself as this browser's. |
| Sticky comment bar | missing | **present** — a preference in `ui-prefs-store`, wired into the task detail: pinned, or at the end of the activity. |
| Issue — which fields show in the create toolbars | missing | **present** — four toggles, wired into the task composer. A hidden selector still sends its default, so nothing is created differently. |
| Chat — floating chat on or off | missing | **partial** — the preference exists and is offered; there is no floating chat surface on this branch to read it. See the wiring note. |

These three are kept in the browser rather than on the account, beside the sidebar
preferences that already live there, and each row says so. They answer questions about the
screen in front of you; syncing them would mean one device overruling another.

### Tokens

| Item | Was | Now |
| --- | --- | --- |
| Its own tab | no — fused into `/settings/security` | **present** — `/settings/tokens`, `api-tokens.tsx`. |
| Create with a name and an expiry (30 / 90 default / 1 year / never) | partial — name only | **present** — the server already bounded `expiresAt` to 365 days. |
| Shown once, copy, "Done" gated on "I stored it" | partial — dismissable unread | **present** |
| List shows prefix, created, last used, expiry | partial — created and expiry fetched, never rendered | **present** |
| Revoke, with a confirm | partial — no confirm | **present** |

### Workspace general

The page did not exist; only the endpoints did.

| Item | Was | Now |
| --- | --- | --- |
| Logo | missing, no column | **present** — `workspaces.logo_url` (migration 174), an address rather than an upload, bounded as `validAvatar` already bounds a user's. |
| Name, description, autosaving | missing (UI) | **present** |
| Context field for agents | missing, no column | **present** — `workspaces.agent_context` (migration 174), the workspace-wide half of what an agent is told. |
| Slug read-only | missing | **present** — shown, not editable. |
| Issue prefix: A–Z 0–9, ≤10, live example, confirm that it renumbers | missing (UI) | **present** — the ≤10 bound is the UI's, since the server's `validIssuePrefix` allows up to 12 and tightening it would refuse prefixes already stored. The confirm is load-bearing: identifiers are derived at query time, so every task reference changes the moment it saves. |
| Only owners and admins can edit | partial — server-side only | **present** — the page reflects it rather than offering fields whose save will 403. |
| Danger zone — leave, disabled for the sole owner | missing, no endpoint | **present** — `POST /workspaces/:id/leave`, because `DELETE …/members/:userId` needs `members.manage` and a member does not have it. The last-owner rule still holds (409). |
| Danger zone — delete, owner only, type the name, locked while deleting, then next workspace or onboarding | missing (UI) | **present** |

### Members

| Item | Was | Now |
| --- | --- | --- |
| Role badges | partial — four real roles collapsed into a template's four, so an owner rendered as "Member"; a quarter of rows shown by email at random; the year hard-coded to 2026; an "Application" role the server never returns | **present** — the four real roles, the real joined date, no invented rows. |
| Change role; only an owner grants owner; the last owner cannot be demoted | missing (UI) | **present** — the server enforced it under row locks all along. |
| Remove, with a confirm | missing (UI) | **present** |
| Invite by email with a role | missing (UI) | **present** |
| Pending invitations, with revoke | missing (UI) | **present** |
| Join links, kept and linked from here | partial — the page existed, unlinked | **present** |
| Updates live | missing | **present**, as honestly as a page without a subscription can be: both lists are re-read whenever the tab is looked at again. A change made elsewhere is correct here on return, not while the tab sits in the background. |

### Statuses

| Item | Was | Now |
| --- | --- | --- |
| Grouped by category, with a note on each category's agent behaviour | partial — flat, with `Board column: …` as a caption | **present** — grouped, each group saying what its category makes an agent do. |
| Add: name, category (fixed), description, colour | partial — name and category; colour hard-coded, description never sent | **present** |
| Edit | partial — rename only | **present** — name, description and colour. |
| Archive, with a confirm, plus an archived toggle | partial — no confirm, and archived rows could not be listed at all | **present** — `?includeArchived=true` on the read, a confirm that says the tasks are moved out, and restore through `PATCH { archived: false }`. Only `false`: archiving also detaches the tasks, which the DELETE route does. |
| Drag to reorder within a category | partial — arrows over a flat list, so a move could cross a category | **present** |
| Admins only; everyone else read-only | missing — every control rendered for every role | **present** |

### Labels

| Item | Was | Now |
| --- | --- | --- |
| Issue labels | present | **present** |
| Skill labels | missing | **present** — as what they are: free text on each skill, not a catalogue. The tab lists which are in use and how often and says where they come from; a "create" button would create nothing. |
| Filter by name | present | **present** |
| Usage counts | missing, no endpoint | **present** — counted on the catalogue read from `issue_label_memberships`, not stored: a label moves often enough that a cached number would be wrong more than right. |
| Create or edit with a colour picker | partial — the swatch cycled eight fixed colours | **present** — the palette plus any colour. |
| Deleting confirms with the usage count | missing | **present** |

### Properties

| Item | Was | Now |
| --- | --- | --- |
| At most 20 active, with a counter | missing, client and server | **present** — `MAX_ACTIVE_PROPERTIES`, enforced on create and on restore, with the count beside the heading and the Add button disabled at the bound. |
| Types fixed after creation | present | **present**, and now said on the form rather than discovered. |
| At least one option for select types | present | **present** |
| Archive | present | **present** |
| Restore | missing | **present** — `PATCH { archived: false }`, bounded exactly as creating is. |
| Archived hidden from pickers, values kept | partial — true, but untestable while restore did not exist | **present** |

### Quick actions

| Item | Was | Now |
| --- | --- | --- |
| Sorted by usage, stale after 90 days | missing — sorted by name; nothing recorded a use | **present** — `use_count` and `last_used_at` (migration 175), incremented when the action is reached for, before the run is enqueued: a run the queue later refuses was still a use. |
| Visibility: team or just me | present | **present** |
| Warn when the target agent can't be triggered by everyone | missing | **present** — a shared action pointing at an agent whose `access.assign` is not `everyone` says so before it is saved. |
| Template variables are rejected | missing | **present** — anything but `issue.identifier`, `issue.title` and `issue.description` is refused, in the form and on the server. Unfilled, it would not fail at run time; it would reach the agent as two braces and a word, read as instructions. |
| Archive | present | **present** |
| Restore, delete | missing | **present** — restore through the patch; delete is `POST …/delete` and only accepts an already-archived action, so the irreversible click is never the first. |

### Pages

| Item | Was | Now |
| --- | --- | --- |
| `/[orgId]/members/[id]` — avatar, role, email, the member's tasks (assigned or created, search, the same views) | partial, and at `/profiles/[memberId]`; the "created" scope hashed the identifier modulo the member count, attributing every task to whoever sat at that index; presence was invented | **present** — the route exists under members, "created" reads the API's own `createdBy` (a task with no recorded author, or one an agent filed, belongs to nobody), and the invented presence line is gone. `/profiles/[memberId]` stays: links to it exist and the drawer intercepts it. |
| Member hover card — role, email, top 2 agents by runs | missing, no endpoint | **present** — `GET /workspaces/:id/members/:userId/top-agents`. `runs` records the agent and the task and never who asked, so it is answered through the tasks the person filed or holds, which is the real link rather than a requester column invented to look like one. |
| `/invitations` — batch accept with multi-select, then enter the first accepted | missing | **present**. Accepting from a list needs no token — the list was never given one — so the token became optional and the address check that already ran is the whole proof. An invitation can still only be accepted by the account it names, and a token that *is* presented must still be right. |
| `/invite/[id]` — loading, not found, expired, revoked, other account, already accepted, declined, accept, decline | missing | **partial, deliberately.** The states shown are the states the server is willing to distinguish. `acceptInvitation` answers every unusable invitation the same way so a token cannot enumerate invitations, so expired, revoked, already-accepted and wrong-recipient cannot be told apart and are one honest screen. Declining is local: there is no decline endpoint, and inventing one that revoked the invitation would take an action away from whoever sent it. |
| `/join` — preview signed out, join, already a member goes straight in, seat errors excluded | partial — already-a-member fell through the same silent redirect | **present**. Seat errors are billing, and out of scope. |
| `/workspaces/new` | missing | **present** — with the address and the task prefix shown as they are derived and editable, because both are permanent and only cheap to decide before anything exists. |
| Onboarding — welcome; about you (skippable); workspace (name, slug validation, reserved names, derived and editable prefix); runtime (AgentCore or the workspace default); skip | partial — no steps at all, and the server's own `step`/`answers`/`skipped`/`completed` unused | **present** — all four steps plus a runtime step, skip on every one, and the state kept on the account so closing the tab does not start over. Someone adding a second workspace from the switcher still gets the short create-or-join form. |
| No-access page that does not reveal whether the workspace exists, with "my workspaces" and "sign in as someone else"; deleted or left workspaces navigate away without flashing it | missing | **present** — `WorkspaceAccess` wraps the workspace routes. A slug this session has seen in the reader's own list is treated as a departure and routes onward quietly, so pressing Leave never flashes a refusal. |

### Backend added

Everything else above is UI over a route that already worked.

1. **`users.description`** (173) — "about you", ≤2000 characters, on `GET`/`PATCH /me`.
2. **`workspaces.logo_url` and `workspaces.agent_context`** (174) — on `GET`/`PATCH /workspaces/:id`.
3. **`POST /workspaces/:id/leave`** — a member removing their own membership, which
   `members.manage` forbids; the last-owner rule still holds.
4. **Label usage counts** — a count per label on the catalogue read.
5. **Property restore and a 20-active bound** — `PATCH { archived: false }`, bounded as create is.
6. **Status archived reads and restore** — `?includeArchived=true`, `PATCH { archived: false }`.
7. **Quick action usage, restore, delete, and prompt validation** (175) — `use_count`,
   `last_used_at`, `?includeArchived=true`, `POST …/delete`, and a prompt that names a
   variable Berry cannot fill is refused.
8. **`GET /workspaces/:id/members/:userId/top-agents`** — for the hover card.

Every mount goes through the workspace guard and the find-before-permission helpers, so a
missing or foreign id is 404 and an own id without permission is 403; each is covered in
`cross-tenant-leakage.test.ts`. Migrations stayed in block **173–176**; 176 is unused.

Timezone and language were already on the user. Member role rules were already enforced, and
correctly — owner-only grants, last-owner protection, row locks. Issue-prefix renumbering
needed no migration, because identifiers are derived at query time and the existing settings
PATCH already performs it.

### Not built

- **Floating chat.** The preference is on the Preferences page and in the store; there is no
  floating chat surface on this branch for it to govern. Wiring listed below.
- **`/invite/[id]` expired / revoked / already-accepted as distinct screens.** Refused on
  purpose: the server answers all of them identically so a token cannot be used to find out
  whether an invitation exists or who it was for, and separate screens would mean guessing in
  public. Declining likewise stays local — there is no decline endpoint, and adding one that
  revoked the invitation would take the decision away from whoever sent it.
- **Seat errors on `/join`.** Billing, and out of scope.

---

## F7 — skills, squads, autopilots, usage, dashboard, runtimes

*Source: `docs/superpowers/specs/parity-map/F7-areas-polish.md`*

What this workstream owns, what the branch already had when the audit was taken, and what
was built on top of it. Every line describes behaviour in Berry's own words; the code is
Berry's own design system, component library and API clients throughout.

Audit taken on `fe/F7-areas-polish`, branched from `feat/multica-parity`.

The *Audit* column is what the branch had when the audit was taken; *Now* is what it has
after this workstream's work. **present** — the behaviour is there; **partial** — some of it
is there, with what is missing named; **missing** — nothing of it exists yet; **not built** —
deliberately left out, with the reason under "Not built".

### Skills

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

### Squads

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

### Autopilots

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

### Usage (`/usage`)

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

### Dashboard

| Behaviour | Audit | Now | What the audit saw |
| --- | --- | --- | --- |
| Working agents | **present** | **present** | `workingAgents` with links. |
| 30-day activity | **present** | **present** | Runs-by-day and cost-by-day. |
| Run counts | **present** | **present** | Five tiles. |
| Failures by agent | **present** | **present** | A ranked list. |

### Runtimes

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

### What was built

Everything the audit found *partial* or *missing* was built, except the two items under
"Not built". This section says where it landed.

#### Server

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

#### Frontend

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

#### Not built

- **Autopilot "run only" output mode.** Berry's run ledger admits a run against a task or a
  chat session (`runs_task_target_ck`), and the autopilot fire path creates or names an
  issue for every firing. A third mode would be a change to the ledger and the dispatcher,
  which are another workstream's, not a screen. The two existing modes are offered.
- **Webhook delivery attempt counts beyond replays.** The server stores one row per
  delivery and links replays through `replay_of`; there is no retry counter to show. The
  deliveries table shows the replay chain length instead, which is what Berry actually knows.

### Verification

- `pnpm lint` in `frontend` — clean.
- `pnpm exec prettier --check` on every file this workstream touched — clean.
- `pnpm build:check` in `frontend` — compiles, types check, every route builds.
- `python3 scripts/check-locale-catalogues.py` — 4 locales x 10 namespaces agree.
- `pnpm typecheck:server` — clean.
- The server tests behind these screens, on a private database
  (`berry_test_f7_areas_polish`): `mounts/runtimes`, `mounts/usage`, `mounts/skills`,
  `mounts/squads`, `mounts/autopilots`, `mounts/cross-tenant-leakage` and `usage/queries` —
  81 tests, all passing.
