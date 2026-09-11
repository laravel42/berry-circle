# F1 — issue lists, views and projects

Workstream F1 owns the task lists (`my-issues`, the project task surfaces, saved
views), the view and table components under `frontend/components/common/issues`
(everything except `details/`), and the saved-view screens.

This file was written as an audit of what the branch inherited, and is now the
record of what it ships. Every item below reads **present** or **not built**
with the reason it was left.

## Where the behaviour lives

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

## Issues list

| Item | Status |
| --- | --- |
| Scope switch on the tasks page: all, assigned, created, my agents & squads | **present** — URL-backed; the agent scope covers the workspace's agents and the rosters of the squads this person is in. |
| Scope switch on the project tab and on saved views | **not built** — a project tab is already scoped to its project and a saved view to its own query; a second scope control there would fight the one the view saves. |
| Everything synced to the URL | **present** — filters, scope, layout, grouping, ordering and direction all read from the URL first and fall back to the stored settings, so a link reproduces the sender's list without overwriting the reader's defaults. |
| View modes board, list, table, swimlane, gantt | **present** on the tasks page, the project task tab and a saved view. |
| The mode is remembered | **present** |

## Filter menu

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

## Display options

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

## Saved views

| Item | Status |
| --- | --- |
| Tabs with drag reorder and an overflow menu | **present** |
| Tab menu: edit, pin/unpin to the sidebar, hide/show, delete with a confirm | **present** |
| Manage-views dialog, order and visibility per user | **present** — both live in that person's view preferences on the server. |
| Save/edit dialog: name, private or shared, filters, layout, display defaults, scope | **present** |
| Conflict toast when someone else edited the view | **present** |
| A missing view shows an info toast and exits | **present** |
| Uses the existing saved-view endpoints | **present** |

## Inline edits

| Item | Status |
| --- | --- |
| Rows and cards: status, priority, assignee | **present** |
| Rows and cards: dates, labels, project | **present** — inline in the table, through the right-click menu on rows and cards. |
| Custom properties inline | **present** in the table; **not built** on cards — a card would need a popover per field, and the values are only readable in bulk through the grouped query the table already runs. |
| Table title rename: Enter saves, Escape cancels | **present** |
| Quick-add row | **present** — in the table and above every list. |
| Add button on each group header | **present**; pre-filling a non-status group value is **not built** — the create modal accepts a default status and nothing else. |

## Context menu

| Item | Status |
| --- | --- |
| Status, priority, assignee submenus | **present** — agents beside members. |
| Quick date picks: today, tomorrow, next week, clear | **present** |
| Open in new tab | **present** |
| Pin | **present** |
| Copy link | **present** |
| Relations: create sub-issue, set parent, remove parent, add existing sub-issue | **present** |
| Delete | **present**, with a confirmation. |

## Selection

| Item | Status |
| --- | --- |
| Checkboxes on rows, cards and table rows | **present** |
| Shift-range selection | **present** |
| Select all | **present** — over what the filters are showing. |
| Bulk toolbar: count, clear, status, priority, assignee, delete with a confirm | **present** |
| Assigning to an agent goes through a run confirmation | **present**, against a local stand-in — see the wiring note below. |
| Uses the batch endpoints | **present** |

## Drag and drop

| Item | Status |
| --- | --- |
| Board: reorder within a column | **present** |
| Board: move across columns to change the grouped field | **present** — status, assignee, priority and project all write. |
| List: move between groups | **present** |
| Swimlanes: move cells, reorder lanes | **present** |
| Table: reorder columns | **present** |
| Auto-scroll near the board edge | **present** |

## Loading

| Item | Status |
| --- | --- |
| Load more with retry | **not built** — the list endpoint is drained in full (up to twenty pages) on first load, so there is no cursor left to continue from. The retry half exists: a failed load says so and can be run again. |
| Per-group loading in the table | **not built** as a per-group fetch, for the same reason; the group header shows the list-level loading marker while a load is in flight. |
| Virtualized large board columns | **present** — past forty cards a column renders only what is in view. |

## Gantt

| Item | Status |
| --- | --- |
| Zoom by day, week, month | **present** |
| Toggle to show completed | **present** |
| Today line | **present** |
| Shaded weekends | **present** |
| Warning when dates are inverted | **present** — counted and named rather than drawn backwards. |

## States

| Item | Status |
| --- | --- |
| Skeleton per mode | **present** |
| Status-catalogue error with retry | **present** as the list-load error with retry. Berry's statuses are a local catalogue, so the failure this covers is the task list itself, which used to fail silently into an empty board. |
| Filters-empty state with a clear button | **present** |
| Workspace-empty state | **present** |
| Toast when a grouped property was deleted | **present** — and the grouping falls back to status. |

## Projects

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

## Not built, in one place

1. A scope switch on the project task tab and on saved views.
2. Ordering by a custom property.
3. Load more, and per-group loading as a per-group fetch.
4. Pre-filling a non-status value from a group header's add button.
5. Custom-property editing on board cards.
6. A separate card grid for projects.
7. An emoji icon picker on a project.

## Wiring left for the merge

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
