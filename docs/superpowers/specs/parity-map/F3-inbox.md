# F3 — Inbox parity map

Workstream F3 owns `/[orgId]/inbox`, `frontend/components/common/inbox/**` and the
notifications drawer. This file records what the branch actually had when the workstream
started, and what it has now.

Audit taken on branch `fe/F3-inbox` (cut from `feat/multica-parity`).

## Audit, before the work

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

## After the work

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

## Wiring this needs at merge

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
