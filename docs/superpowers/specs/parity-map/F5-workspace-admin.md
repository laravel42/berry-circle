# Parity map — F5, workspace administration

Audited on branch `fe/F5-workspace-admin`, cut from `feat/multica-parity` at `a73d2fa`.

Scope: `frontend/app/[orgId]/settings/**` (minus keyboard shortcuts, which is F6),
`frontend/app/[orgId]/members/**`, profiles, onboarding, `/invitations`, `/invite/[id]`,
`/join`, `/workspaces/new`, and the no-access states.

Each row records what the code on this branch actually does — the component, the store, the
`lib/*` client, and the server route behind it — not what a screen appears to offer.

---

## Settings shell

| Item | State | What is there, and what is missing |
| --- | --- | --- |
| Tab groups (personal / workspace / issue config / connections) | **partial** | `components/layout/sidebar/nav-settings.tsx` holds the one list of settings destinations, and `shell-rail-settings.tsx` renders it into the rail. It has **two** groups, `personal` and `workspace`, not four. Issue config and connections are mixed into `workspace`. Missing destinations entirely: workspace general, members, tokens as its own tab, and the link out to F6's shortcuts page. Security and tokens are fused into one `/settings/security` page. |
| Dropdown instead of tabs on narrow screens | **missing** | The rail is the only settings navigation. There is no responsive fallback: below the rail breakpoint a reader has no way to move between settings pages. |
| Shared autosave (debounce, save on blur, saving / saved / failed indicator) | **partial** | `use-settings-resource.ts` gives an optimistic `mutate` that rolls back and toasts on failure, and `profile.tsx` commits on blur. There is no debounce anywhere, and no saving / saved / failed indicator — a successful write is silent, so nothing tells a reader their edit landed. |

## Profile

| Item | State | Detail |
| --- | --- | --- |
| Avatar | **partial** | `profile.tsx` renders the avatar read-only. `PATCH /api/v1/me` accepts `avatarUrl` (absolute HTTP(S), no credentials) but nothing in the UI sets or clears it. |
| Name, autosaving, blocked while blank | **present** | Commits on blur and on Enter; an empty or unchanged value reverts instead of saving. |
| "About you", up to 2000 characters, with a counter, shared with agents | **missing** | No field, no counter, and no column — `users` has no description, `Profile` has no such member, and `PATCH /api/v1/me` accepts only `name` and `avatarUrl`. Needs a backend addition. |

## Preferences

| Item | State | Detail |
| --- | --- | --- |
| Theme | **present** | `theme-preferences.tsx`, written through to the account as well as `next-themes`. |
| Language — saved locally, synced to the account, then reload | **present** | `preferences.tsx` writes the cookie, sets the session store, PATCHes `/me/settings`, and calls `router.refresh()`. |
| Timezone — browser default or an IANA zone, stored on the account | **partial** | The picker is seeded from `Intl.supportedValuesOf('timeZone')` with the browser's own zone hoisted to the front, and the value is stored on the account. There is no explicit "use my browser's zone" choice — the browser zone is just another row in a list of several hundred, indistinguishable from the rest. |
| Sticky comment bar | **missing** | No such preference anywhere. |
| Issue — which fields show in the create toolbars | **missing** | Not offered; the create toolbars are fixed. |
| Chat — floating chat on or off | **missing** | Not offered. |

## Tokens

The checklist asks for a Tokens tab. Today tokens share `/settings/security` with the session
list, under `account-security.tsx`.

| Item | State | Detail |
| --- | --- | --- |
| Create with a name and an expiry (30 / 90 default / 1 year / never) | **partial** | Name and API scopes only. `POST /api/v1/tokens` already accepts `expiresAt` and bounds it to 365 days, so the expiry choice is a UI gap, not a server one. |
| Shown once, copy, "Done" enabled only after ticking "I stored it" | **partial** | The secret is shown once with a "Copy and dismiss" button. There is no acknowledgement checkbox gating dismissal, so the secret can be clicked away unread. |
| List shows prefix, created, last used, expiry | **partial** | Prefix, scopes and last-used are shown. Created and expiry are fetched (`tokenSchema` carries both) but never rendered. |
| Revoke, with a confirm | **partial** | Revoke works and rolls back on failure. There is no confirm — one click on an irreversible action. |

## Workspace general

The whole page is **missing**. There is no `/settings/general` route and no component. What
exists is only server-side:

- `PATCH /api/v1/workspaces/:id` — name, slug, description, gated on `workspace.update`.
- `PATCH /api/v1/workspaces/:id/settings` — `issuePrefix`, `defaultRole`, `allowMemberInvites`,
  gated on `settings.write`.
- `DELETE /api/v1/workspaces/:id` — soft delete, gated on `workspace.delete` (owner only), and
  it clears `last_workspace_id` for everyone pointing at it.

Per checklist item:

| Item | State | Detail |
| --- | --- | --- |
| Logo | **missing** | No column, no endpoint, no UI. Needs a backend addition. |
| Name, description, autosaving | **missing** (UI) | The endpoint exists; nothing calls it. |
| Context field for agents | **missing** | No column, no endpoint, no UI. Needs a backend addition. |
| Slug read-only | **missing** | Never surfaced. The endpoint does accept a slug patch, so "read-only" is a UI decision to make. |
| Issue prefix: A–Z 0–9, ≤10, live example, confirm that it renumbers every issue | **missing** (UI); **server differs** | `validIssuePrefix` is `/^[A-Z][A-Z0-9]{1,11}$/` — 2 to 12 characters, first must be a letter. That is wider than the checklist's ≤10. Tightening the server would refuse prefixes already stored, so the ≤10 bound belongs in the UI. Renumbering needs no data migration: identifiers are derived at query time from `w.settings->>'issuePrefix'` (`core/issues.ts`, `berry_issue_identifier`), so changing the prefix renames every issue reference the moment it is saved — which is exactly why the confirm is load-bearing. |
| Only owners and admins can edit | **partial** | Enforced server-side by `workspace.update` / `settings.write`. No UI exists to reflect it. |
| Danger zone — leave workspace, disabled for the sole owner | **missing**, and **no backend** | `DELETE /workspaces/:id/members/:userId` requires `members.manage`, which a plain member does not have, so a member cannot remove themselves. There is no leave endpoint. Needs a backend addition. |
| Danger zone — delete workspace, owner only, type the name, dialog locked while deleting, then land on the next workspace or onboarding | **missing** (UI) | `DELETE /api/v1/workspaces/:id` exists and is owner-gated. Nothing calls it. |

## Members

`/[orgId]/members` renders `components/common/members/members.tsx`, fed by `members-store`.

| Item | State | Detail |
| --- | --- | --- |
| Role badges | **partial** | `member-line.tsx` shows a role, but through `lib/members.ts`'s `roleToUi`, which collapses the four real roles into the template's `Member / Admin / Guest / Application`. **Owner and viewer have no representation at all** — an owner renders as "Member". The row also carries inherited template behaviour that is wrong here: `hashString(user.id) % 4 === 0` shows a quarter of members by email for no reason, `joinedLabel` hard-codes the year 2026, and an "Application" role is rendered that the server never returns. |
| Change role; only an owner may grant owner; the last owner cannot be demoted | **missing** (UI) | Fully implemented server-side in `identity/workspaces.ts#updateMemberRole`, under row locks, with `LastOwner` → 409. No UI. |
| Remove, with a confirm | **missing** (UI) | `removeMember` exists with the same owner protections. No UI. |
| Invite by email with a role (member or admin) | **missing** (UI) | `POST /api/v1/workspaces/:id/invitations` exists — validates the address, refuses `owner`, defaults to a 7-day expiry, bounded to 30 days. No UI. |
| Pending invitations, with revoke | **missing** (UI) | `GET` and `DELETE .../invitations[/:id]` exist. No UI. |
| Join links, kept and linked from here | **partial** | `/settings/join-links` exists and works. Members does not link to it. |
| Updates live | **missing** | The list is hydrated once; nothing re-reads it. |

## Statuses

`/settings/project-statuses` → `project-statuses-settings.tsx`.

| Item | State | Detail |
| --- | --- | --- |
| Grouped by category, with a note on each category's agent behaviour | **partial** | All seven categories exist server-side and each status prints `Board column: <category>` as a caption, but the list is flat — statuses are not grouped, and there is no note about what a category means to an agent. |
| Add a custom status: name, category (fixed after creation), description, colour | **partial** | Name and category only. Colour is hard-coded `#8b5cf6`; description is never sent. `statusCreateSchema` accepts both. Category is correctly unpatchable server-side. |
| Edit | **partial** | Rename only. `PATCH` accepts name, description, color and sortOrder. |
| Archive, with a confirm, plus an archived toggle | **partial** | Archive works and system statuses are protected. No confirm. No archived toggle — `GET .../issue-statuses` filters `archived_at IS NULL` unconditionally and takes no `includeArchived`, so archived statuses cannot be listed at all. |
| Drag to reorder within a category | **partial** | Up/down arrow buttons over the flat list, so a move can cross a category boundary. `PUT .../issue-statuses/order` requires the ids to name every active status exactly once. |
| Admins only; everyone else read-only | **missing** | Every control renders for every role. A member's write simply 403s and rolls back. |

## Labels

`/settings/issue-labels` → `issue-labels-settings.tsx`.

| Item | State | Detail |
| --- | --- | --- |
| Issue labels | **present** | Create, rename, recolour, archive, all against `/catalogs/:id/issue-labels`. |
| Skill labels | **missing** | Skills carry a `labels: string[]` (`lib/skills.ts`) but they are free strings with no catalogue, and this page does not mention them. |
| Filter by name | **present** | |
| Usage counts | **missing** | No endpoint returns one. `issue_label_memberships` exists and would answer it with a join. Needs a backend addition. |
| Create or edit with a colour picker | **partial** | Clicking the swatch cycles a fixed eight-colour palette. There is no picker, and no way to reach a colour outside the palette. |
| Deleting confirms with the usage count | **missing** | "Remove" archives immediately, with no confirm and no count. |

## Properties

`/settings/issue-properties` → `issue-properties-settings.tsx`.

| Item | State | Detail |
| --- | --- | --- |
| At most 20 active, with a counter | **missing** | Neither bound nor counter, client or server. |
| Types fixed after creation | **present** | `propertyPatchSchema` has no `kind`, deliberately. |
| At least one option for select types | **present** | `propertyCreateSchema.superRefine` requires it, and the Add button disables without it. |
| Archive | **present** | |
| Restore | **missing** | `DELETE` archives; nothing un-archives. `propertyPatchSchema` carries no `archived`. Needs a backend addition. |
| Archived hidden from pickers, values kept | **partial** | The list hides archived rows by default and `GET` takes `includeArchived`, and values are kept because archiving is a soft delete. Untestable from the UI while restore does not exist. |

## Quick actions

`/settings/quick-actions` → `quick-actions-settings.tsx`.

| Item | State | Detail |
| --- | --- | --- |
| Sorted by usage, with a "stale" flag after 90 days | **missing** | Sorted by name (`ORDER BY lower(name), id`). Nothing records a use: `quick_action_definitions` has no usage count and no last-used timestamp. Needs a backend addition. |
| Visibility: team or just me | **present** | `workspace` / `private`, and `listQuickActions` only returns another person's row when it is shared. |
| Warn when the target agent can't be triggered by everyone | **missing** | Agent access scopes exist in the agent layer; this page never consults them. |
| Template variables are rejected | **missing** | The opposite is true today: `renderPrompt` fills `{{issue.identifier}}`, `{{issue.title}}` and `{{issue.description}}`, and the page advertises them. Read as "a variable Berry cannot fill must be refused rather than shipped to an agent literally", nothing validates the prompt at all. |
| Archive | **present** | Author or a moderator (owner/admin). |
| Restore, delete | **missing** | Archive is one-way; there is no hard delete. Needs a backend addition. |

## Pages

| Item | State | Detail |
| --- | --- | --- |
| `/[orgId]/members/[id]` — avatar, role, email, the member's issues (assigned or created, search, the same views) | **partial**, and at the wrong path | The page is `/[orgId]/profiles/[memberId]`. It shows avatar, email, role, local time and joined, and offers assigned/created tabs, search, filters and the shared grouped views. But the "created" scope is `issueCreatorIndex(issue, members.length)` — an index derived from the position of the member in the list, i.e. a template artefact that attributes issues to whoever happens to sit at that index, not to their author. The presence dot and "Away as of 11 minutes ago" are likewise invented; nothing tracks presence. |
| Member hover card — role, email, top 2 agents by runs | **missing** | No hover card. `runs.agent_id` exists, so "top agents by runs" is answerable, but no endpoint answers it. |
| `/invitations` — batch accept with multi-select, then enter the first accepted workspace | **missing** | `GET /api/v1/invitations` (the caller's own pending invitations) and `POST /api/v1/invitations/:id/accept` both exist. No page. |
| `/invite/[id]` — loading, not found, expired, revoked, other account, already accepted, declined, accept, decline | **missing** | The only path in is the onboarding "Join" tab, which asks a person to paste an invitation id and a 53-character token by hand. Note a deliberate server constraint: `acceptInvitation` answers **every** invalid state with the same `InvitationInvalid` so a token cannot be used to enumerate invitations — so "expired" and "revoked" cannot be distinguished from a token alone, and there is no decline endpoint. |
| `/join` — preview signed out, join, already a member goes straight in, seat errors excluded | **partial** | `/join/[token]` previews signed out (the lookup is the one unauthenticated read), joins, and sends a 401 to sign-in. "Already a member" is not handled explicitly — the accept returns `joined: false` and the page pushes `/` either way, which lands correctly but says nothing. Seat errors are out of scope (billing). |
| `/workspaces/new` | **missing** | No route. Creation exists only inside the onboarding create-or-join card. |
| Onboarding — welcome; about you (role, use cases, skippable); workspace (name, slug validation, reserved names, derived and editable issue prefix); runtime (AgentCore or workspace default); skip | **partial** | `onboarding/page.tsx` resolves an existing membership or shows create-or-join. There are **no steps**: no welcome, no about-you, no runtime step, no skip. The server already models all of it and it is entirely unused — `GET`/`PATCH /api/v1/me/onboarding` with steps `welcome / aboutYou / workspace / complete`, answers `role / teamSize / goal / source`, and `skipped`. Slug is derived by `slugFromWorkspaceName` but never validated against the server's rule before submit, there is no reserved-name list, and the issue prefix is never shown — it is silently derived server-side by `prefixFromName`. |
| No-access page that does not reveal whether the workspace exists, with "my workspaces" and "sign in as someone else"; deleted or left workspaces navigate away without flashing it | **missing** | Nothing renders this state. `app/not-found.tsx` redirects to `/`, and the workspace guard already answers 404 for a non-member and an absent workspace indistinguishably, which is the property the page has to preserve. |

## Backend additions this workstream needs

Only where a screen has no endpoint. Everything else above is a UI gap over a working route.

1. **Profile description** — `users.description`, surfaced on `GET`/`PATCH /api/v1/me`, ≤2000 characters, and carried into the agent context.
2. **Workspace context and logo** — a logo URL and an agent-context field on the workspace, on `GET`/`PATCH /api/v1/workspaces/:id`.
3. **Leave workspace** — a member removing their own membership, which `members.manage` currently forbids, with the last-owner rule still holding.
4. **Label usage counts** — a count per label on the catalogue read.
5. **Property restore** — un-archiving a property definition.
6. **Quick action usage** — a use count and a last-used time, so "sorted by usage" and the 90-day stale flag mean something; plus restore and hard delete.
7. **Top agents by runs, per member** — for the member hover card.

Timezone and language are already on the user; member role rules are already enforced, and
correctly (owner-only grants, last-owner protection, row locks). Issue-prefix renumbering needs
no migration because identifiers are derived — the existing settings PATCH already performs it.

Migrations for this workstream stay in block **173–176**.
