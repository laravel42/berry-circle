# F2 — Issue detail: parity map

Audit of the issue detail surface on `fe/F2-issue-detail` (branched from
`feat/multica-parity`). Every line below was checked against the code on this
branch — the components under `frontend/app/[orgId]/issue`,
`frontend/components/common/issues/details`, the `frontend/lib/*` clients they
call, and the server mounts behind those calls.

Classification: **present** (behaves as described), **partial** (something real
is there, but a named part of the behaviour is missing), **missing** (nothing
on this branch does it).

The "after build" column is left empty here and filled in at the end of the
workstream, once each item has actually been built and verified.

## Routing

| # | Behaviour | Audit | After build |
| - | - | - | - |
| R1 | UUID or identifier accepted; URL rewritten to the canonical identifier | **partial** — `IssueDetails` matches `issues.find(i => i.identifier === issueId)` and falls back to `getBoardIssue(issueId)`, which does resolve a UUID server-side. But nothing rewrites the address bar, so a UUID URL stays a UUID URL and the page keeps re-resolving it. | — |
| R2 | `#comment-<id>` scrolls to and highlights the comment, and reacts to hash changes | **missing** — no hash reading anywhere in the details tree; comment cards carry no anchor id. | — |
| R3 | Visit recorded in `localStorage` key `berry.recentIssues` (`{id, identifier, title}`, newest first, capped at 20) | **missing** — the string `recentIssues` does not appear in the frontend. | — |
| R4 | Skeleton, not-found with a back link, deleted-while-open navigates away | **partial** — not-found exists (the "Task unavailable" panel with a back link), but there is no loading skeleton: an issue not yet in the store renders the not-found panel while the fetch is still in flight, which tells the reader the issue does not exist. Deleted-while-open is handled only when the reader themself deletes it (`afterDelete`), not when it disappears underneath them. | — |

## Header

| # | Behaviour | Audit | After build |
| - | - | - | - |
| H1 | Breadcrumb with the project | **missing** — `header-nav.tsx` shows identifier + title and prev/next only. | — |
| H2 | "sub-issue of" parent chip | **missing** — `Issue.parentId` exists in the model and `setParent` exists in `lib/issue-tracking.ts`, but nothing renders a parent anywhere on the detail page. | — |
| H3 | Live agent chip: who is working or queued, elapsed time, tool-call count, view transcript, stop (with confirm), fed by the run events stream | **missing** — `issue.activeRunId` is carried on the model and never used. No component on the issue page opens `streamRunEvents`. | — |
| H4 | Mark done | **missing** as a header action (status can be changed from the sidebar selector). | — |
| H5 | Pin toggle | **present** — `IssuePinButton`, though it sits in the title row rather than the header. | — |
| H6 | Right-sidebar toggle whose state is remembered | **missing** — the sidebar is `hidden lg:flex`, always on, with no control and no persistence. `right-panel-store` is for the list pages, not this one. | — |

## Title and description

| # | Behaviour | Audit | After build |
| - | - | - | - |
| T1 | Title inline edit | **missing** — the title is a plain `<h1>`. `patchBoardIssue` accepts `title`, so only the UI is absent. | — |
| T2 | Description autosave | **present** — `IssueDescriptionEditor` commits on blur through `updateIssueDescription`, which writes through to `PATCH /issues/:id`. | — |
| T3 | Drop files onto the description, or an upload button | **partial** — `IssueAttachments` has an "Add a file" button and `uploadIssueAttachment` works, but the description itself accepts no drop, and the paperclip button rendered above the activity feed is decorative (no handler). | — |
| T4 | Image viewer stepping through the issue's images | **missing** — no lightbox component exists in the frontend. | — |
| T5 | Emoji reactions on the issue | **present** — `IssueReactions` / `ReactionBar` against `/issues/:ref/reactions`. | — |
| | | | — |

## Sub-issues

| # | Behaviour | Audit | After build |
| - | - | - | - |
| S1 | Collapsible, x/y progress, grouped by stage | **partial** — `SubIssues` shows an x/y count and a progress bar, and prints each child's stage as a chip, but the list is flat (no grouping) and cannot be collapsed. | — |
| S2 | Inline status and assignee per row | **missing** — each row shows the status *name* as text; no selector, no assignee at all. | — |
| S3 | Add a new sub-issue, or attach an existing one through a debounced picker that excludes self and descendants | **partial** — creating a child works (`createChild`). Attaching an existing issue has no UI at all, though `setParent` is the endpoint it needs. | — |
| S4 | Collapsed state remembered per issue | **missing** (there is no collapse). | — |

## Sidebar

| # | Behaviour | Audit | After build |
| - | - | - | - |
| P1 | Properties: status, assignee (members, agents, squads), project, priority, stage, dates, labels, "add property" menu for custom properties; archived properties read-only | **partial** — status (`StatusSelector` + `CustomStatusSelect`), priority, assignee (members and agents; squads only in the create modal) and a read-only project row are there, and `IssueCustomProperties` edits every custom field. Missing: any date field, labels, stage, the "add property" menu, and the archived-is-read-only rule (`archivedAt` is parsed by `lib/properties.ts` and then ignored). The server has no issue↔label API at all — `issue_label_memberships` exists in the schema and is read by the query builder, but no mount reads or writes it. | — |
| P2 | Quick actions panel with result states: started, folded into the current run, blocked (with reason), comment posted | **partial** — `IssueQuickActions` is a dropdown that toasts "started" or a generic failure. It is not a panel and it has no result vocabulary; the server returns only `{runId}`. | — |
| P3 | Parent issue with remove | **missing**. | — |
| P4 | Keep K's linked-PR panel | **present** — `IssueLinkedPullRequests` is mounted in the panel; untouched. | — |
| P5 | Execution log: active runs pinned, past runs behind a toggle newest-first | **missing** — runs appear only as grey one-liners mixed into the activity feed. There is no execution log section. | — |
| P6 | Per run: status, trigger kind (initial, comment, autopilot, retry #n), attribution, failure/cancel reason in plain language | **missing** — and not expressible: `serializeRun` exposes neither `source` (the column exists: `assignment`/`mention`/`chat`/`autopilot`/`squad`/`quick_action`/…) nor `requested_by`. | — |
| P7 | Cancel (with confirm), retry, open transcript per run | **partial** — `cancelRun` exists in `lib/runs.ts` and is wired only on the runs *overview* page, without a confirm. No retry, no transcript from the issue page. | — |
| P8 | Token and cost total opening a usage breakdown dialog (cost, cache savings, tokens, per-agent totals, per-run table) | **partial** — `IssueUsageSection` prints cost, tokens and a run count. No dialog, no cache savings, no per-agent or per-run table, although `getIssueUsage` already returns `byRun` and the bucket carries `cacheReadTokens`/`cacheWriteTokens`. | — |
| P9 | Details (created by, created, updated) and a metadata dialog | **missing** — `createdBy`/`createdAt`/`updatedAt` are parsed and dropped; `GET/PATCH /issues/:ref/metadata` exists server-side with no client. | — |

## Transcript dialog (shared component)

| # | Behaviour | Audit | After build |
| - | - | - | - |
| X1 | A shared `runs/transcript-dialog.tsx` | **missing** — the only transcript in the product is the `<pre>` block inside `runs/run-overview.tsx`, which is a page, not a component, and is not reusable. | — |
| X2 | Newest first; follows live output; End key or scrolling breaks out of following | **missing** — the existing `<pre>` appends oldest-first and never scrolls itself. | — |
| X3 | Search, and filter by step kind (tool, thinking, error; command, edit, read) | **missing** — the stream is flattened to one string by `textFromRunEvent`, so there are no steps to filter. | — |
| X4 | Per-step input and result with copy | **partial at the data layer** — `run.command.started/output/completed` carry the command, its output and its exit code. `run.tool.started/completed` deliberately carry only a name and a success flag (the ledger never records tool arguments or output), so a tool step can show its name and outcome and nothing more. | — |
| X5 | Token usage and cost, and an outcomes summary (files changed, commands run) | **partial at the data layer** — the run resource carries usage and cost; `run.delivered` carries files changed, insertions and deletions. Nothing renders them in a transcript. | — |
| X6 | Keyboard scrolling | **missing**. | — |
| X7 | Exported for F4 to reuse | **missing**. | — |

## Activity and comments

| # | Behaviour | Audit | After build |
| - | - | - | - |
| A1 | Timeline mixes comments and activity; consecutive activities coalesced (xN) with "show more" | **partial** — `useIssueActivity` already merges comments, runs and activity entries by time. No coalescing and no "show more". | — |
| A2 | Threaded replies, collapsing a thread | **missing** in the UI — the server stores and serialises `parentId` and refuses a reply to a reply, so the data is one level deep and ready; the feed renders every comment flat. | — |
| A3 | Resolve/unresolve a thread, optionally with a comment; resolved threads fold into a summary bar | **partial** — `setCommentResolved` is wired into the comment menu and a "resolved" chip shows. No optional comment, no folding. | — |
| A4 | Comment menu: copy; create a sub-issue from the comment; edit (own, or any for moderators); delete with a confirm that warns about replies | **partial** — create-sub-issue, edit and delete are there. Copy is missing; the moderator case is hidden (the menu offers edit/delete only to the author, so an admin sees nothing even though the server would allow it); the delete confirm is a bare `window.confirm` that says nothing about replies. | — |
| A5 | Comment reactions | **present** — `ReactionBar target="comment"`. | — |
| A6 | An agent run appears inline under the comment that triggered it, streaming live with a stop control | **missing** — a run shows as a separate grey line wherever its timestamp lands, with no link to the comment that started it and no live output. | — |

## Composer

| # | Behaviour | Audit | After build |
| - | - | - | - |
| C1 | Per-issue draft surviving a close | **missing** — the draft lives in `useState` inside `useIssueActivity`. | — |
| C2 | Send on mod+Enter (F6 registry if present, else a local handler marked for merge) | **partial** — a local `metaKey/ctrlKey + Enter` handler exists inline in the textarea. No shortcut registry exists on this branch. | — |
| C3 | Sending blocked while uploads are in flight | **missing** — the composer cannot upload at all. | — |
| C4 | @mentions of members, agents, squads, "all", issues and projects, grouped; agents without a runtime disabled | **partial** — `useMentionPicker` offers agents and squads in one ungrouped list. No members, no "all", no issues, no projects, no grouping. The agent resource does not expose its runtime binding, so "no runtime" is not knowable from the client. | — |
| C5 | Slash commands: skills, plus a built-in "note" that triggers no agent | **missing** — `lib/skills.ts` lists skills; nothing consumes it from a composer. | — |
| C6 | Typed or pasted issue keys auto-link | **missing**. | — |
| C7 | Trigger preview chips before sending; click to skip or restore an agent; reason shown when one is blocked; partial-trigger toast after sending | **partial** — `previewCommentTriggers` is called (debounced 400 ms) and rendered as two sentences. Not chips, not clickable, no skipping, and `createIssueComment` sends only `{body}` so a skip could not be honoured. | — |

## Subscriptions

| # | Behaviour | Audit | After build |
| - | - | - | - |
| B1 | Subscribe button | **present** — `IssueSubscription`. | — |
| B2 | Popover to edit subscribers | **missing** — the current subscriber list is fetched and reduced to a "N following" count; there is no way to see or change who. | — |
| B3 | "Unsubscribe from this issue and its sub-issues" | **present** — the dropdown's subtree items call `setSubscription(..., subtree: true)`. | — |

## Find in issue

| # | Behaviour | Audit | After build |
| - | - | - | - |
| F1 | mod+F opens it; Enter next, Shift+Enter previous; current/total count; Escape closes | **missing** — the only keyboard handling in the shell is Ctrl+T/W/Tab for tabs. | — |
| F2 | Restore scroll position when coming back to an issue | **missing**. | — |

## Run confirm dialog

| # | Behaviour | Audit | After build |
| - | - | - | - |
| N1 | Shown when assigning to an agent or squad, or moving an agent-owned issue out of backlog; options start now / apply without starting | **missing** — `AssigneeUser` writes the assignment straight through, and the server's auto-dispatch decides on its own. | — |
| N2 | Used for bulk assignment; exported for F1 | **missing**. | — |

## Create-issue modal

| # | Behaviour | Audit | After build |
| - | - | - | - |
| M1 | Manual mode: title, description with uploads, status, priority, assignee, dates, labels, project, custom properties, parent (lockable), stage, sub-issues to link | **partial** — title, description (no uploads), status, priority, assignee (members, agents, squads) and project are there. Missing: uploads, dates, labels, custom properties, parent, stage, sub-issues. | — |
| M2 | "Create another", and a persisted draft | **missing** — the form resets and closes. | — |
| M3 | Defaults pre-filled from context | **partial** — only `defaultStatus`, set by the board column that opened it. | — |
| M4 | A hint saying whether an agent will start | **missing**. | — |
| M5 | Duplicate (409) shows a view-existing toast | **missing** — a 409 falls into the generic error toast. | — |
| M6 | Agent quick-create mode: pick agent or squad, one-line prompt, attachments; toast says the result arrives in the inbox | **missing** — `QuickCreate` is a one-line title field on list pages, unrelated. | — |

## Backend gaps this workstream has to close

1. `serializeRun` exposes no `source` and no `requestedBy`, so P6 (trigger kind
   and attribution) cannot be rendered. Both columns already exist on `runs`
   (`source` since migration 053, `requested_by` since 003) — this is a
   serializer change, not a schema change.
2. There is no issue↔label API. `issue_label_memberships` exists and is read by
   `work/issue-query.ts`, but no mount exposes it, so P1 and M1 cannot show or
   set labels.
3. The quick-action run endpoint answers `{runId}` only, with no way to say
   "folded into the current run", "blocked, because…" or "posted a comment"
   (P2).

No migration is needed for any of the three, so this workstream does not use
its migration block (163–166).

## Notes on scope

- Runtimes are AgentCore runtimes; nothing here builds a local runtime, a CLI,
  or any integration but GitHub.
- The linked-PR panel (K's) is left exactly as it is.
