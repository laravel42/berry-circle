# Parity map — F5, workspace administration

Audited on branch `fe/F5-workspace-admin`, cut from `feat/multica-parity` at `a73d2fa`.

Scope: `frontend/app/[orgId]/settings/**` (minus keyboard shortcuts, which is F6),
`frontend/app/[orgId]/members/**`, profiles, onboarding, `/invitations`, `/invite/[id]`,
`/join`, `/workspaces/new`, and the no-access states.

Each row records what the code on this branch actually does — the component, the store, the
`lib/*` client, and the server route behind it — not what a screen appears to offer. The
**Was** column is the state at `a73d2fa`; **Now** is the state after this workstream.

---

## Settings shell

| Item | Was | Now |
| --- | --- | --- |
| Tab groups (personal / workspace / issue config / connections) | partial — two groups, with issue config and connections folded into "workspace"; no general, members or tokens entries | **present** — `nav-settings.tsx` holds four groups. Members links to `/members` rather than a settings clone, because that is the page people bookmark. |
| Shortcuts, a link to F6's page | missing | **present** — listed under Personal at `/settings/keyboard-shortcuts`. The page itself is F6's; see the wiring note below. |
| Dropdown instead of tabs on narrow screens | missing | **present** — `headers/settings/header-nav.tsx` renders the same `settingsNav` as a dropdown, `lg:hidden`, so it and the rail are never both the navigation. |
| Shared autosave (debounce, save on blur, saving / saved / failed) | partial — an optimistic `mutate` with rollback, no debounce and no indicator | **present** — `use-autosave.ts` debounces, commits on blur, and reports state; `save-indicator.tsx` shows saving / saved / failed with a retry. Used throughout the General page and the profile. |

## Profile

| Item | Was | Now |
| --- | --- | --- |
| Avatar | partial — read-only | **present** — the address is editable and autosaves; `PATCH /me` already validated it. |
| Name, autosaving, blocked while blank | present | **present** |
| "About you", ≤2000 characters, counter, shared with agents | missing, and no column | **present** — `users.description` (migration 173), on `GET`/`PATCH /me`, with a counter, and carried into agent context. |

## Preferences

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

## Tokens

| Item | Was | Now |
| --- | --- | --- |
| Its own tab | no — fused into `/settings/security` | **present** — `/settings/tokens`, `api-tokens.tsx`. |
| Create with a name and an expiry (30 / 90 default / 1 year / never) | partial — name only | **present** — the server already bounded `expiresAt` to 365 days. |
| Shown once, copy, "Done" gated on "I stored it" | partial — dismissable unread | **present** |
| List shows prefix, created, last used, expiry | partial — created and expiry fetched, never rendered | **present** |
| Revoke, with a confirm | partial — no confirm | **present** |

## Workspace general

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

## Members

| Item | Was | Now |
| --- | --- | --- |
| Role badges | partial — four real roles collapsed into a template's four, so an owner rendered as "Member"; a quarter of rows shown by email at random; the year hard-coded to 2026; an "Application" role the server never returns | **present** — the four real roles, the real joined date, no invented rows. |
| Change role; only an owner grants owner; the last owner cannot be demoted | missing (UI) | **present** — the server enforced it under row locks all along. |
| Remove, with a confirm | missing (UI) | **present** |
| Invite by email with a role | missing (UI) | **present** |
| Pending invitations, with revoke | missing (UI) | **present** |
| Join links, kept and linked from here | partial — the page existed, unlinked | **present** |
| Updates live | missing | **present**, as honestly as a page without a subscription can be: both lists are re-read whenever the tab is looked at again. A change made elsewhere is correct here on return, not while the tab sits in the background. |

## Statuses

| Item | Was | Now |
| --- | --- | --- |
| Grouped by category, with a note on each category's agent behaviour | partial — flat, with `Board column: …` as a caption | **present** — grouped, each group saying what its category makes an agent do. |
| Add: name, category (fixed), description, colour | partial — name and category; colour hard-coded, description never sent | **present** |
| Edit | partial — rename only | **present** — name, description and colour. |
| Archive, with a confirm, plus an archived toggle | partial — no confirm, and archived rows could not be listed at all | **present** — `?includeArchived=true` on the read, a confirm that says the tasks are moved out, and restore through `PATCH { archived: false }`. Only `false`: archiving also detaches the tasks, which the DELETE route does. |
| Drag to reorder within a category | partial — arrows over a flat list, so a move could cross a category | **present** |
| Admins only; everyone else read-only | missing — every control rendered for every role | **present** |

## Labels

| Item | Was | Now |
| --- | --- | --- |
| Issue labels | present | **present** |
| Skill labels | missing | **present** — as what they are: free text on each skill, not a catalogue. The tab lists which are in use and how often and says where they come from; a "create" button would create nothing. |
| Filter by name | present | **present** |
| Usage counts | missing, no endpoint | **present** — counted on the catalogue read from `issue_label_memberships`, not stored: a label moves often enough that a cached number would be wrong more than right. |
| Create or edit with a colour picker | partial — the swatch cycled eight fixed colours | **present** — the palette plus any colour. |
| Deleting confirms with the usage count | missing | **present** |

## Properties

| Item | Was | Now |
| --- | --- | --- |
| At most 20 active, with a counter | missing, client and server | **present** — `MAX_ACTIVE_PROPERTIES`, enforced on create and on restore, with the count beside the heading and the Add button disabled at the bound. |
| Types fixed after creation | present | **present**, and now said on the form rather than discovered. |
| At least one option for select types | present | **present** |
| Archive | present | **present** |
| Restore | missing | **present** — `PATCH { archived: false }`, bounded exactly as creating is. |
| Archived hidden from pickers, values kept | partial — true, but untestable while restore did not exist | **present** |

## Quick actions

| Item | Was | Now |
| --- | --- | --- |
| Sorted by usage, stale after 90 days | missing — sorted by name; nothing recorded a use | **present** — `use_count` and `last_used_at` (migration 175), incremented when the action is reached for, before the run is enqueued: a run the queue later refuses was still a use. |
| Visibility: team or just me | present | **present** |
| Warn when the target agent can't be triggered by everyone | missing | **present** — a shared action pointing at an agent whose `access.assign` is not `everyone` says so before it is saved. |
| Template variables are rejected | missing | **present** — anything but `issue.identifier`, `issue.title` and `issue.description` is refused, in the form and on the server. Unfilled, it would not fail at run time; it would reach the agent as two braces and a word, read as instructions. |
| Archive | present | **present** |
| Restore, delete | missing | **present** — restore through the patch; delete is `POST …/delete` and only accepts an already-archived action, so the irreversible click is never the first. |

## Pages

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

## Backend added

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

## Not built

- **Floating chat.** The preference is on the Preferences page and in the store; there is no
  floating chat surface on this branch for it to govern. Wiring listed below.
- **`/invite/[id]` expired / revoked / already-accepted as distinct screens.** Refused on
  purpose: the server answers all of them identically so a token cannot be used to find out
  whether an invitation exists or who it was for, and separate screens would mean guessing in
  public. Declining likewise stays local — there is no decline endpoint, and adding one that
  revoked the invitation would take the decision away from whoever sent it.
- **Seat errors on `/join`.** Billing, and out of scope.
