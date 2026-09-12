# F6 — shell, navigation, palette, shortcuts, attachment preview

Workstream F6 owns `frontend/components/layout/**` (shell, rail, sidebar, command
palette, workspace menu), the global shortcut registry, the attachment preview
(modal and page), and the Settings › keyboard shortcuts page.

This file is the audit of that surface on branch `fe/F6-shell` (cut from
`feat/multica-parity`), written against the code actually on the branch, and
then updated as each item is built.

Legend: **present** — behaviour is there; **partial** — some of it is there,
what is missing is named; **missing** — nothing on the branch does this.

## Audit (before the work)

### Sidebar (the shell rail)

| # | Behaviour | State | Notes |
| --- | --- | --- | --- |
| 1 | Personal section: inbox with an unread badge (99+ cap), my issues, chat with an unread count | missing | The rail has only Work and Manage (`shell-routes.ts`). The inbox exists as a bell in the tab strip (`notification-bell.tsx`) whose badge shows a digit up to 9 and then an empty dot, never `99+`. Chat is a Work item with no count, although `/api/v1/conversations` already returns `unread` per thread (`lib/chat.ts`). |
| 2 | Pinned section: pinned issues with status icon, projects and saved views; drag to reorder; unpin; show 5 then "show more"; silently drop pins whose target 404s; over `/api/v1/pins` | partial | `shell-pins.tsx` lists every pin as a plain link. No status icon, no drag, no unpin, no truncation, and the heading is a hardcoded English string. `lib/pins.ts` already wraps reorder and unpin but nothing calls them, and `pins-store.ts` has no reorder action. The server (`work/pins.ts` `listPins`) already leaves out a pin whose target is deleted or invisible, so "silently drop" is half-done at the source; the client never refetches, so a pin deleted elsewhere stays on screen for the life of the page. |
| 3 | Work and manage sections, as today | present | `SHELL_SECTIONS` with per-item visibility and order from `sidebar-prefs-store`. |
| 4 | "New issue" button with a dot when a create-issue draft exists | missing | `CreateNewIssue` is mounted hidden by `create-issue-modal-provider.tsx` and opened from the palette only. No button in the rail, and `create-issue-store` keeps no draft, so there is nothing a dot could report. |
| 5 | Help menu: docs, changelog, feedback, server version | missing | The rail foot has customize-sidebar and collapse only. The server knows its version (`VERSION` in `server-ts/src/index.ts`) but only publishes it on `/metrics`; `/api/v1/config` returns capabilities and no version. |

### Workspace switcher

| # | Behaviour | State | Notes |
| --- | --- | --- | --- |
| 6 | Lists workspaces | present | `workspace-menu.tsx` renders the session's memberships with a check on the active one. |
| 7 | Dots for other workspaces that have unread items | missing | Unread is only ever loaded for the active workspace (`loadInboxUnreadCount` in the hydrate hook). |
| 8 | Create workspace → `/workspaces/new` | partial | The menu offers "create or join workspace" but routes to `/onboarding?add=1`. |
| 9 | Pending invitations with inline join and decline | missing | `GET /api/v1/invitations` already lists the caller's open invitations, but no browser client calls it. Joining from a list is impossible today: `POST /api/v1/invitations/:id/accept` demands the 53-character token, which the list deliberately does not carry, and there is no decline route at all (only an admin-side `DELETE /workspaces/:id/invitations/:id`). |
| 10 | Log out | present | `useSignOut` via the menu. |

### Command palette

| # | Behaviour | State | Notes |
| --- | --- | --- | --- |
| 11 | mod+K toggles, including from inputs; Escape closes | present | A window-level keydown in `command-palette.tsx` fires wherever focus is; the Radix dialog closes on Escape. |
| 12 | Empty query: up to 20 recent issues, pages and commands | partial | Empty query shows Actions and Go-to. Nothing tracks recently visited issues, so there are no recents. |
| 13 | Typing matches pages by name and keywords, members locally, issues via the search API (debounced, limit 20, snippet highlights), projects; cancelled issues in their own group | partial | Pages match on their visible label only (cmdk's own filter), members are not searched at all, the search call is debounced but asks for `first=25` and renders no highlight, projects do come back via `PALETTE_SEARCH_TYPES`. The server's search rows carry no status, so a cancelled task cannot be told from any other. |
| 14 | Commands: new issue, new project, theme light/dark/system with the current one checked | partial | New issue is there; "plan something" stands where new project would be; there is no theme command even though `theme-toggle.tsx` already does the work through `next-themes`. |
| 15 | On an issue page: copy link, copy identifier, fold/unfold all comments (as an event) | partial | Copy task URL and copy task ID are there (plus more). Nothing folds comments, and there is no event for another component to listen to. |
| 16 | mod+Enter or mod+click opens a result in a new tab | missing | Every result is `router.push`. |

### Global shortcut registry

| # | Behaviour | State | Notes |
| --- | --- | --- | --- |
| 17 | One exported module plus a provider hook other areas register with | missing | Shortcuts are three ad-hoc window listeners: ctrl+T / ctrl+W / ctrl+Tab in `berry-shell.tsx` and mod+K in the palette. Nothing can be registered from outside. |
| 18 | Defaults: C, mod+B, mod+/, mod+J, mod+F, E, mod+Enter, mod+[ , mod+] , plus unbound go-to actions | missing | None exist; `mod+B` in `components/ui/sidebar.tsx` belongs to the shadcn sidebar the shell does not render. |
| 19 | Ignore IME composition and key repeat | missing | No handler checks `isComposing` or `repeat`. |
| 20 | Remappable, persisted per user, documented API for F2/F3/F4 | missing | — |
| 21 | Settings › keyboard shortcuts page (search, record, validate, conflicts, per-row reset and disable, restore all behind a confirm, read-only fixed list) | missing | `settingsNav` has no such entry and no page exists. |

### Attachment preview

| # | Behaviour | State | Notes |
| --- | --- | --- | --- |
| 22 | Modal: Escape closes, arrows move between attachments, image zoom and pan (keys, scroll, double-click, fit/actual), download, copy link, open in new tab, messages for too-large and unsupported files | missing | `issue-attachments.tsx` can only download. No preview of any kind. |
| 23 | `/[orgId]/attachments/[id]/preview` rendering HTML in a sandboxed iframe | missing | No route. The server side is ready: `GET /api/v1/attachments/:id` and `/:id/download` both exist. |

### Other

| # | Behaviour | State | Notes |
| --- | --- | --- | --- |
| 24 | Navigation progress bar | missing | — |
| 25 | Sidebar auto-closes on narrow screens after navigating | missing | `railOpen` is persisted and never reacts to viewport width. |
| 26 | Unread badges update from the SSE stream | partial | `use-workspace-event-stream.ts` refreshes the inbox count on inbox-touching frames, which feeds the bell. There are no sidebar badges for it to feed, and chat unread is not refreshed at all. |

## Result (after the work)

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

### What the shell stands in for

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

### Backend added

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
