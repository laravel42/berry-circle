# F2 — Issue detail: parity map

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

## Routing

| # | Behaviour | Audit | After build |
| - | - | - | - |
| R1 | UUID or identifier accepted; URL rewritten to the canonical identifier | **partial** — the page resolved either form through `getBoardIssue`, but nothing rewrote the address bar, so a UUID URL stayed a UUID URL. | **present** — the page replaces the URL with the task's key once it resolves, carrying the fragment across and using `replace`, so Back still leaves. |
| R2 | `#comment-<id>` scrolls to and highlights that comment, and reacts to hash changes | **missing** — no hash reading; comment cards carried no anchor. | **present** — every card carries `data-comment-id`; the page scrolls to it, marks it, listens for `hashchange`, and re-runs once comments have loaded. |
| R3 | Visit recorded in `localStorage` `berry.recentIssues` (`{id, identifier, title}`, newest first, capped at 20) | **missing**. | **present** — `lib/recent-issues.ts` owns the key and the shape; re-reading a task moves it to the front rather than adding it twice, and a task that turns out not to exist is dropped. |
| R4 | Skeleton; not found with a back link; deleted-while-open navigates away | **partial** — the not-found panel existed but was shown *while loading*, so a slow fetch told the reader the task did not exist. Deleted-while-open only worked when the reader did the deleting. | **present** — a skeleton while the fetch is in flight, the not-found panel only once it has answered, and a task that disappears underneath the reader closes the page. |

## Header

| # | Behaviour | Audit | After build |
| - | - | - | - |
| H1 | Breadcrumb with the project | **missing**. | **present** — project → task key → title, the project linking to its task list. |
| H2 | "sub-issue of" parent chip | **missing** — `parentId` was on the model and rendered nowhere. | **present** — a chip linking to the parent, in the header and again in the sidebar. |
| H3 | Live agent chip: who is working or queued, elapsed, tool-call count, view transcript, stop (with confirm), fed by the run events stream | **missing** — `activeRunId` was carried and never used. | **present** — `live-agent-chip.tsx`; elapsed ticks once a second, the tool count comes from the event stream, stop asks first. |
| H4 | Mark done | **missing** as a header action. | **present** — one button, which reopens as well as finishes. |
| H5 | Pin toggle | **present** (in the title row). | **present** — moved into the header beside the other task-level actions. |
| H6 | Right-sidebar toggle whose state is remembered | **missing** — the sidebar was always on, with no control. | **present** — `issue-view-store` persists it across tasks and sessions. |

## Title and description

| # | Behaviour | Audit | After build |
| - | - | - | - |
| T1 | Title inline edit | **missing** — a plain `<h1>`. | **present** — Enter or blur saves, Escape reverts, an empty title is refused and rolled back. |
| T2 | Description autosave | **present**. | **present** — unchanged. |
| T3 | Drop files onto the description, or an upload button | **partial** — an upload button existed further down the page under a different heading; the description took no drop, and the paperclip above the feed was decorative. | **present** — the description is the drop target and carries its own upload button. |
| T4 | Image viewer stepping through the issue's images | **missing**. | **present** — images are fetched as blob URLs (the download route needs the session header, so `<img src>` cannot reach it) and revoked on unmount. Arrow keys step; a counter says where you are. |
| T5 | Emoji reactions on the issue | **present**. | **present** — unchanged. |

## Sub-issues

| # | Behaviour | Audit | After build |
| - | - | - | - |
| S1 | Collapsible, x/y progress, grouped by stage | **partial** — progress and a stage chip, but a flat list that could not be collapsed. | **present** — grouped under stage headings, with the whole block foldable. |
| S2 | Inline status and assignee per row | **missing** — the status was text; there was no assignee. | **present** — both edit in place and write straight through, rolling back on refusal. |
| S3 | Add a new sub-issue, or attach an existing one through a debounced picker that excludes self and descendants | **partial** — creating worked; attaching had no UI. | **present** — a debounced search whose exclusion set is the task plus every task beneath it, walked breadth-first and bounded. |
| S4 | Collapsed state remembered per issue | **missing**. | **present** — persisted per task identifier. |

## Sidebar

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

## Transcript dialog (shared component)

| # | Behaviour | Audit | After build |
| - | - | - | - |
| X1 | A shared `runs/transcript-dialog.tsx` | **missing** — the only transcript was a `<pre>` inside the runs page. | **present**. |
| X2 | Newest first; follows live output; End or scrolling breaks out of following | **missing**. | **present** — newest first, so following means staying at the top; scrolling away stops it and End resumes. |
| X3 | Search, and filter by step kind (tool, thinking, error; command, edit, read) | **missing** — the stream was flattened to one string, so there were no steps. | **present** — `foldRunEvent` turns the event stream into steps; tool names are classified into edit/read/tool by verb. |
| X4 | Per-step input and result with copy | **partial at the data layer** — commands carry their text, output and exit code; the ledger deliberately never records tool arguments or output. | **present within what the ledger records** — commands show both halves with copy; a tool step shows its name and outcome, because that is all that exists. |
| X5 | Token usage and cost, and an outcomes summary (files changed, commands run) | **partial at the data layer**. | **present** — usage and cost from the run, files changed from `run.delivered`, commands counted from the steps. |
| X6 | Keyboard scrolling | **missing**. | **present** — the list itself is focusable, so arrows, Page keys and Home/End reach it. |
| X7 | Exported for F4 to reuse | **missing**. | **present** — `RunTranscriptDialog` and `foldRunEvent` are both exported. |

## Activity and comments

| # | Behaviour | Audit | After build |
| - | - | - | - |
| A1 | Timeline mixes comments and activity; consecutive activities coalesced (xN) with "show more" | **partial** — merged by time, never coalesced. | **present** — consecutive bookkeeping folds into one row; a comment between two runs of it keeps them apart. |
| A2 | Threaded replies, collapsing a thread | **missing** in the UI — the server already stored and serialised `parentId`. | **present** — replies render under their root and fold away; the client now sends `parentId`. |
| A3 | Resolve or unresolve a thread, optionally with a comment; resolved threads fold into a summary bar | **partial** — resolve existed in the menu; no optional comment, no folding. | **present** — resolving offers a closing comment, and resolved threads collapse into a counted bar. |
| A4 | Comment menu: copy; create a sub-issue; edit (own, or any for moderators); delete with a confirm that warns about replies | **partial** — no copy; the moderator case was hidden even though the server allows it; the delete confirm was a bare `window.confirm` that said nothing about replies. | **present** — all four, with the reply count named in the confirm. |
| A5 | Comment reactions | **present**. | **present** — unchanged. |
| A6 | An agent run appears inline under the comment that triggered it, streaming live with a stop control | **missing**. | **present** — a mention-triggered run is attached to the last comment written before it, streams while live, and can be stopped there. |

## Composer

| # | Behaviour | Audit | After build |
| - | - | - | - |
| C1 | Per-issue draft surviving a close | **missing** — the draft lived in component state. | **present** — persisted per task; replies keep their own local draft. |
| C2 | Send on mod+Enter (F6's registry if present, else a local handler marked for merge) | **partial** — a local handler, unmarked. | **present** — local handler, marked `wire to shortcut registry at merge (F6)`; no registry exists on this branch. |
| C3 | Sending blocked while uploads are in flight | **missing** — the composer could not upload at all. | **present** — the composer uploads, and Send is disabled until they land. |
| C4 | @mentions of members, agents, squads, "all", issues and projects, grouped; agents without a runtime disabled | **partial** — agents and squads in one ungrouped list. | **present** except the disabled state — grouped, with people, "all", tasks and projects added. **Agents without a runtime: not built** — the agent resource exposes no runtime binding, so "has no runtime" is not knowable from the client and a guess would disable the wrong agents. The picker supports the state; only the fact is missing. |
| C5 | Slash commands: skills, plus a built-in "note" that triggers no agent | **missing**. | **present** — a leading `/` offers the skills catalogue and `note`, which demotes every mention to plain text so nothing starts. |
| C6 | Typed or pasted issue keys auto-link | **missing**. | **present** — task keys are linked wherever they appear in a comment. |
| C7 | Trigger preview chips; click to skip or restore; the reason when blocked; a partial-trigger toast after sending | **partial** — two sentences, not chips; nothing clickable. | **present** — chips toggle. A skip is honoured by demoting that agent's mention token to plain text before sending, which is what the server reads; the POST body has no "skip" field, so this is the only way to mean it without a new endpoint. |

## Subscriptions

| # | Behaviour | Audit | After build |
| - | - | - | - |
| B1 | Subscribe button | **present**. | **present**. |
| B2 | Popover to edit subscribers | **missing** — the list was fetched and reduced to a count. | **present** for reading — the popover names them and why each is following. **Changing someone else's subscription: not built** — the endpoints act on the caller (`PUT`/`DELETE /subscription`); there is no route for subscribing another person. |
| B3 | "Unsubscribe from this issue and its sub-issues" | **present**. | **present** — also offered inside the popover. |

## Find in issue

| # | Behaviour | Audit | After build |
| - | - | - | - |
| F1 | mod+F opens it; Enter next, Shift+Enter previous; current/total; Escape closes | **missing**. | **present** — matches are painted with the CSS Custom Highlight API, so no DOM React owns is rewritten. |
| F2 | Restore scroll position when coming back to an issue | **missing**. | **present** — per task, for the session only: a two-day-old offset against an edited description lands nowhere. |

## Run confirm dialog

| # | Behaviour | Audit | After build |
| - | - | - | - |
| N1 | Shown when assigning to an agent or squad, or moving an agent-owned issue out of backlog; start now, or apply without starting | **missing**. | **partial** — the dialog is built and asked in the create-issue modal, where "apply without starting" creates the task in the backlog (the one state an assigned agent is never dispatched from). **Asking on the detail page's assignee change, and on moving out of backlog, is not built**: both go through `AssigneeUser` / `StatusSelector`, which the board (F1) shares, and neither exposes a seam to intercept the write. See the wiring notes. |
| N2 | Used for bulk assignment; exported for F1 | **missing**. | **present as an export** — `RunConfirmDialog` and `useRunConfirm` take a count for the bulk case; F1 wires it to its selection. |

## Create-issue modal

| # | Behaviour | Audit | After build |
| - | - | - | - |
| M1 | Manual mode: title, description with uploads, status, priority, assignee, dates, labels, project, custom properties, parent (lockable), stage, sub-issues to link | **partial** — title, description, status, priority, assignee, project. | **present** — the rest added. Attachments are held until the task exists and uploaded immediately after, because an attachment needs a task to belong to. |
| M2 | "Create another", and a persisted draft | **missing**. | **present** — the draft persists; "create another" keeps the context and clears what was typed. |
| M3 | Defaults pre-filled from context | **partial** — only the board column. | **present** — column, project and parent, through `openModalWith`. |
| M4 | A hint saying whether an agent will start | **missing**. | **present**. |
| M5 | Duplicate (409) shows a view-existing toast | **missing** — a 409 fell into the generic error. | **present** — the toast offers to open the existing task when the server names it. |
| M6 | Agent quick-create: pick an agent or squad, a one-line prompt, attachments; the toast says the result arrives in the inbox | **missing**. | **present**. |

## Backend added

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

## Verification

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

## Notes on scope

- Runtimes are AgentCore runtimes. Nothing here builds a local runtime, a CLI,
  a desktop or mobile surface, or any integration but GitHub.
- The linked-PR panel (K's) is untouched.
