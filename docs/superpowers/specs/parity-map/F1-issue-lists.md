# F1 — issue lists, views and projects

Workstream F1 owns the task lists (`my-issues`, the project task surfaces, saved
views), the view and table components under `frontend/components/common/issues`
(everything except `details/`), and the saved-view screens.

This is the audit of what the branch `fe/F1-issue-lists` (cut from
`feat/multica-parity`) actually contains, item by item, in Berry's own words.
Status is one of **present**, **partial** (with what is missing) or **missing**.

## Where the behaviour lives today

- `frontend/components/common/my-issues/my-issues.tsx` — the live "tasks" page.
- `frontend/components/common/issues/*` — list rows, board cards, table,
  swimlanes, gantt, filter bar, batch toolbar, context menu.
- `frontend/components/common/issues/all-issues.tsx` — a second copy of the page
  body that nothing imports; the board/table/lanes/gantt switch only exists here.
- `frontend/components/common/views/*` + `frontend/app/[orgId]/views` — the saved
  views list and the view detail page.
- `frontend/components/common/projects/*` — the projects list/board/timeline and
  the project detail panel.
- State: `store/filter-store.ts` (URL), `store/display-settings-store.ts` and
  `store/view-store.ts` (localStorage), `store/issue-selection-store.ts`.
- Server: `/api/v1/views` (CRUD + `/preferences` + `/query`), `/api/v1/issues`
  (`/batch`, `/batch-delete`, `/quick`, `/assignee-frequency`), custom fields
  under `/api/v1/catalogs/:workspaceId/issue-properties`. All of it exists.

Two facts shape most of the gaps below: `toUiIssue` in `frontend/lib/issues.ts`
drops `createdBy` and `updatedAt` and always sets `labels: []`, so creator,
updated-at and label filters have nothing to filter on; and the board loads the
whole task list in one go, so there is no paging anywhere.

## Issues list

| Item | Status |
| --- | --- |
| Scope switch all / members / agents | **partial** — `my-issues` has all/members/agent tabs in the URL; the project task surface and saved views have no scope switch. |
| my-issues scopes: all, assigned, created, my agents & squads | **partial** — only "all", "members" and "agent" exist. "Assigned to me" and "created by me" are not there (no creator on the task model), and squads are not a scope. |
| Everything synced to the URL | **partial** — filters and the my-issues tab are in the URL; the view mode, grouping, ordering and display properties are localStorage only, so a link does not reproduce what the sender saw. |
| View modes board, list, table, swimlane, gantt | **partial** — all five components exist and `all-issues.tsx` switches between them, but that file is unreferenced. The live page renders list/board only, and the project pages render neither switch. |
| The mode is remembered | **present** — `view-store` persists it. |

## Filter menu

| Item | Status |
| --- | --- |
| Status | **partial** — the section exists; no counts. |
| Priority | **present** |
| Assignee (members, agents, squads, no assignee) | **partial** — members plus "unassigned"; agents and squads are absent even though both are loaded elsewhere. |
| Creator | **missing** |
| Project, including "no project" | **partial** — projects are listed; there is no "no project" choice. |
| Label | **partial** — the section is built from the workspace labels, but tasks carry no labels, so it matches nothing. |
| Date created / updated (today, 3 days, 7 days, custom range) | **missing** — the filter library supports date columns; no date column is declared. |
| Custom properties (is, contains, before, after, empty) | **missing** |
| Every section searchable | **present** — each value list is a `Command`. |
| One reset | **present** — the Clear action on the chip row. |
| Chips are removable | **present** |
| Chip bar: save as a new view | **partial** — "Save as view" lives inside the Display popover, not on the chip bar. |
| Chip bar: save into the current view | **missing** |
| Working-agents chip (count, hover list, click to filter) | **missing** |

## Display options

| Item | Status |
| --- | --- |
| Grouping per mode | **partial** — one global grouping (status / assignee / priority / project / none) applied to list and board. The table does not group at all, and swimlanes are hard-wired to assignee rows and status columns. |
| Ordering: manual, status, priority, dates, created, updated, title, custom property | **partial** — priority, created and title only. |
| Ascending / descending | **missing** |
| Sub-issue toggle | **partial** — the switch exists and is persisted, but nothing reads `showSubIssues`, so sub-tasks always show. |
| Card property toggles | **present** |
| Table: hierarchy nesting | **missing** |
| Table: searchable column picker | **partial** — a checkbox list with no search. |
| Table: hide columns | **present** |
| Table: drag to reorder columns | **missing** |
| Table: footer calculations (count, sum, average) | **missing** |
| Table: title and identifier search | **missing** |
| Table: CSV export of all or selected rows, with a toast | **missing** |
| Board: hide columns | **partial** — columns emptied by a filter collapse into a "hidden columns" strip automatically; a person cannot hide a column themselves. |
| Board: restore hidden columns | **missing** |

## Saved views

| Item | Status |
| --- | --- |
| Saved-views tab bar | **missing** — there is a Views *page* with rows, and no tab strip above the list. |
| Drag to reorder tabs, overflow menu | **missing** |
| Tab menu: edit, pin/unpin, hide/show, delete with confirm | **partial** — the Views page has a pin toggle and a delete button that deletes with no confirmation. |
| Manage-views dialog (order and visibility per user) | **missing** — the server already stores per-person view preferences. |
| Save/edit dialog: name, private or shared, filters, layout, display defaults, scope | **partial** — name, private/shared, current filters and the layout; no display defaults, no scope, and no way to edit an existing view. |
| Conflict toast when someone else edited the view | **missing** — the API returns a revision conflict; the frontend never calls PATCH. |
| A missing view shows a toast and exits | **partial** — the page renders the words "View not found" and stays there. |
| Uses `/api/v1/issue-views` (ours: `/api/v1/views`) | **present** |

## Inline edits

| Item | Status |
| --- | --- |
| Status, priority, assignee on rows and cards | **present** |
| Dates, labels, project, custom properties on rows and cards | **missing** |
| Table title rename, Enter saves | **partial** — double-click then Enter saves; Escape does not cancel. |
| Quick-add row | **partial** — a quick-add input exists on the unused all-issues body, not in the table or on the live page. |
| Add button on each group header pre-filling the group value | **partial** — the button is there and pre-fills a status; grouping by assignee, priority or project pre-fills nothing. |

## Context menu

| Item | Status |
| --- | --- |
| Status, priority, assignee submenus | **present** |
| Quick date picks (today, tomorrow, next week, clear) | **missing** — one "set due date in a week" item. |
| Open in new tab | **missing** |
| Pin | **missing** |
| Copy link | **partial** — the row menu copies the title only; the detail overflow menu copies a link. |
| Relations: create sub-issue, set parent, remove parent, add existing sub-issue | **missing** from the menu (the API and the detail panel have them). |
| Delete | **present** — with a confirmation dialog. |
| Several menu entries are decorative | noted — "convert into", "make a copy", "remind me", "mark as" and friends only raise a toast. |

## Selection

| Item | Status |
| --- | --- |
| Checkboxes | **partial** — table rows only; list rows and board cards have none. |
| Shift-range selection | **missing** |
| Select all | **missing** |
| Bulk toolbar: count, clear, status, priority, assignee, delete | **partial** — all present, but it is only mounted on the unused all-issues body, the delete confirmation is `window.confirm`, and assigning to an agent does not go through a run confirmation. |
| Uses the batch endpoints | **present** |

## Drag and drop

| Item | Status |
| --- | --- |
| Board: reorder within a column | **present** |
| Board: move across columns to change the grouped field | **partial** — works when grouping by status; dropping into an assignee/priority/project column does nothing. |
| List: move between groups | **missing** |
| Swimlanes: move cells, reorder lanes | **missing** |
| Table: reorder columns | **missing** |
| Auto-scroll near the board edge | **missing** |

## Loading

| Item | Status |
| --- | --- |
| Load more with retry | **missing** — every task is fetched up front. |
| Per-group loading in the table | **missing** |
| Virtualized large board columns | **missing** — the table is virtualized; board columns are not. |

## Gantt

| Item | Status |
| --- | --- |
| Zoom by day, week, month | **missing** — one fixed day scale. |
| Toggle to show completed issues | **missing** |
| Today line | **missing** |
| Shaded weekends | **missing** |
| Warning when dates are inverted | **missing** |

## States

| Item | Status |
| --- | --- |
| Skeleton per mode | **missing** |
| Status-catalogue error with retry | **missing** — statuses are a local constant, and a failed task load silently yields an empty list. |
| Filters-empty state with a clear button | **partial** — a footer says how many rows the filters hid and offers "clear filters", but an all-empty result shows the generic empty state instead. |
| Workspace-empty state | **present** |
| Toast when a grouped property was deleted | **missing** |

## Projects

| Item | Status |
| --- | --- |
| List: table or cards | **partial** — list, board and timeline; the board is closer to columns than to a card grid. |
| Search | **missing** |
| Filters: status, priority, lead | **partial** — health and priority only. |
| Sort | **present** |
| Column visibility | **present** |
| Inline edits | **present** — status, priority, lead, target date, health. |
| Row menu (pin, delete with confirm) | **partial** — `ProjectActionsMenu` exists with a delete confirmation but is not mounted on a row, and it has no pin. |
| Bulk pin | **missing** — projects have no selection at all. |
| Detail sidebar: emoji icon, title, status, priority, lead, dates, progress | **present** (the icon is a glyph, not an emoji picker). |
| Description marked as agent context | **missing** |
| Resources: attach or remove a GitHub repo from workspace repos | **present** |
| Pin, copy link, delete on the detail | **partial** — delete and copy link (through the actions menu); no pin. |

## Summary

Roughly a third of the checklist is already here in some form, mostly the parts
that were easy to reach from the Circle template: the list and board, the filter
chips, the batch endpoints, project inline edits. What is thin is everything that
makes the list a working surface rather than a display: per-mode display
settings, table work (columns, export, calculations, hierarchy), selection,
saved-view management, the gantt, the loading and error states, and the small
per-row affordances (dates, labels, quick picks, relations).
