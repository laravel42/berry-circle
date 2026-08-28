# Multica web parity completion contract

## Pinned baseline

This matrix classifies the complete Multica web surface inspected at:

- **Repository:** [`multica-ai/multica`](https://github.com/multica-ai/multica)
- **Commit:** [`8c9b7503a12ded3f28553da48b9851621f10be6b`](https://github.com/multica-ai/multica/tree/8c9b7503a12ded3f28553da48b9851621f10be6b)
- **Provenance and reuse limits:**
  [Multica server reuse provenance](../provenance/multica-server-reuse.md)

All evidence paths below are repository-relative paths at that commit. They are
inventory evidence, not permission to copy legacy UI, assets, names, or
branding. Reuse is limited by the
[provenance record](../provenance/multica-server-reuse.md).

### Verified inventory facts

- **48 Next.js page routes** under `apps/web/app/**/page.tsx`: 21
  global/public/callback pages and 27 workspace pages.
- **13 workspace navigation destinations/actions** in
  `packages/views/layout/app-sidebar.tsx`: 12 route destinations plus the
  **New issue** action. This qualification prevents the action from being
  misreported as a thirteenth URL.
- **Approximately 417 product HTTP routes** in
  `server/cmd/server/router.go`. The file contains 424 HTTP-method
  registrations; removing seven operational/realtime/static handlers
  (`/health`, `/readyz`, `/healthz`, `/health/realtime`, `/ws`, `/uploads/*`,
  and `/api/avatars/{sig}/*`) yields the approximately 417 product/API
  registrations used for planning. Aliases remain registrations, so this is
  intentionally an approximate product-surface count rather than a count of
  unique business operations.
- **413 up migrations** under `server/migrations/*.up.sql`.
- **Four web locales:** `en`, `zh-Hans`, `ja`, and `ko`, declared by
  `packages/core/i18n/types.ts` and populated under
  `packages/views/locales/`.

Primary evidence:

- routes: `apps/web/app/**/page.tsx`;
- sidebar: `packages/views/layout/app-sidebar.tsx`;
- settings: `packages/views/settings/components/settings-page.tsx`;
- client/domain API: `packages/core/api/client.ts`;
- server routes: `server/cmd/server/router.go`;
- journeys: `e2e/*.spec.ts`; and
- product docs: `apps/docs/content/docs/*.mdx`.

## Classification and completion rules

### Status vocabulary

| Status | Meaning |
|---|---|
| `required-core` | Must work in the default self-hosted web product. |
| `optional-hosted` | May ship as an explicitly enabled hosted/cloud module; disabled by default and fail-closed in self-hosted deployments. |
| `replaced-by-runtime` | The user-facing product outcome may remain, but Multica's execution-side implementation is not ported; Berry provides the capability through its own in-process agent runtime (ADR-0008). |
| `excluded-nonweb` | Outside Berry's web-product scope. |
| `excluded-dead-dev` | Placeholder, compatibility shim, or temporary test surface that must not be recreated. |

### Target phases

| Phase | Exit theme |
|---|---|
| `P0` | Provenance, server scaffold, storage/security boundaries, and shared contract fixtures. |
| `P1` | Identity, onboarding, multi-workspace shell, navigation, and settings foundation. |
| `P2` | Issues, projects, collaboration, inbox, and notifications. |
| `P3` | Agent product surfaces, chat, runtime projections, run evidence, and usage. |
| `P4` | Automation, integrations, plugins, realtime hardening, and four-locale parity. |
| `P5` | Optional hosted/cloud modules and public marketing site. |
| `X` | Deliberate replacement or exclusion; completion evidence proves the boundary rather than an implementation. |

API status in this document means Berry's normative `/api/v1` contract and its
implementation, not presence in the legacy router. `partial` means the current
[gateway contract](../api/gateway-v1.md) covers only part of the behavior;
`gap` means the contract and implementation have not landed; `adapter-gap`
means Berry must define a runtime-backed product projection; and `N/A` means
no Berry API should exist. `test missing` means no Berry acceptance evidence is
linked yet, even when Multica has source tests.

A row is complete only when its checkbox is changed to `[x]` and `TBD` is
replaced with links to the Berry API contract, implementation, and automated or
manual acceptance evidence as applicable. Source existence is never completion
evidence. Any newly discovered source feature blocks a parity claim until it is
added and classified here.

## Page-route inventory

### Global, public, authentication, and callback pages (21/48)

| Multica source page / resulting route | Classification | Phase | Berry target / API / test status | Acceptance evidence |
|---|---|---:|---|---|
| `apps/web/app/(auth)/invitations/page.tsx` → `/invitations` | `required-core` | P1 | Invitation list route; API gap; test missing | [ ] TBD |
| `apps/web/app/(auth)/invite/[id]/page.tsx` → `/invite/:id` | `required-core` | P1 | Invitation preview/decision route; API gap; test missing | [ ] TBD |
| `apps/web/app/(auth)/login/page.tsx` → `/login` | `required-core` | P1 | Login route; auth API gap; test missing | [ ] TBD |
| `apps/web/app/(auth)/onboarding/page.tsx` → `/onboarding` | `required-core` | P1 | Onboarding route; API gap; test missing | [ ] TBD |
| `apps/web/app/(auth)/workspaces/new/page.tsx` → `/workspaces/new` | `required-core` | P1 | Workspace creation route; API gap; test missing | [ ] TBD |
| `apps/web/app/(landing)/about/page.tsx` → `/about` | `optional-hosted` | P5 | Optional public site; API N/A; test missing | [ ] TBD |
| `apps/web/app/(landing)/changelog/page.tsx` → `/changelog` | `optional-hosted` | P5 | Optional public site; API/content feed gap; test missing | [ ] TBD |
| `apps/web/app/(landing)/contact-sales/page.tsx` → `/contact-sales` | `optional-hosted` | P5 | Optional public site; contact API gap; test missing | [ ] TBD |
| `apps/web/app/(landing)/download/page.tsx` → `/download` | `optional-hosted` | P5 | Optional marketing route; native artifacts remain excluded; test missing | [ ] TBD |
| `apps/web/app/(landing)/homepage/page.tsx` → `/homepage` | `optional-hosted` | P5 | Optional public site; API N/A; test missing | [ ] TBD |
| `apps/web/app/(landing)/page.tsx` → `/` | `optional-hosted` | P5 | Optional public site/root redirect; API N/A; test missing | [ ] TBD |
| `apps/web/app/(landing)/usecases/[slug]/page.tsx` → `/usecases/:slug` | `optional-hosted` | P5 | Optional localized content route; API/content gap; test missing | [ ] TBD |
| `apps/web/app/(landing)/usecases/page.tsx` → `/usecases` | `optional-hosted` | P5 | Optional localized content index; API/content gap; test missing | [ ] TBD |
| `apps/web/app/auth/callback/page.tsx` → `/auth/callback` | `required-core` | P1 | Auth callback route; API gap; test missing | [ ] TBD |
| `apps/web/app/billing/return/page.tsx` → `/billing/return` | `optional-hosted` | P5 | Hosted billing return only; module/API gap; test missing | [ ] TBD |
| `apps/web/app/dingtalk/bind/page.tsx` → `/dingtalk/bind` | `required-core` | P4 | Config-gated identity binding; API gap; test missing | [ ] TBD |
| `apps/web/app/join/page.tsx` → `/join` | `required-core` | P1 | Share-link join route; API gap; test missing | [ ] TBD |
| `apps/web/app/lark/bind/page.tsx` → `/lark/bind` | `required-core` | P4 | Config-gated identity binding; API gap; test missing | [ ] TBD |
| `apps/web/app/slack/bind/page.tsx` → `/slack/bind` | `required-core` | P4 | Config-gated identity binding; API gap; test missing | [ ] TBD |
| `apps/web/app/telegram/bind/page.tsx` → `/telegram/bind` | `required-core` | P4 | Config-gated identity binding; API gap; test missing | [ ] TBD |
| `apps/web/app/wecom/bind/page.tsx` → `/wecom/bind` | `required-core` | P4 | Config-gated identity binding; API gap; test missing | [ ] TBD |

### Workspace pages (27/48)

| Multica source page / resulting route | Classification | Phase | Berry target / API / test status | Acceptance evidence |
|---|---|---:|---|---|
| `apps/web/app/[workspaceSlug]/(dashboard)/agents/[id]/page.tsx` | `required-core` | P3 | `/:workspace/agents/:id`; agent API partial; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/agents/new/ai/[sessionId]/page.tsx` | `required-core` | P3 | Builder session route; API gap; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/agents/new/ai/page.tsx` | `required-core` | P3 | Assisted builder entry; API gap; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/agents/new/manual/page.tsx` | `required-core` | P3 | Manual builder route; API gap; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/agents/new/page.tsx` | `required-core` | P3 | Agent creation chooser; API gap; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/agents/page.tsx` | `required-core` | P3 | Agent list route; API partial; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/autopilots/[id]/page.tsx` | `required-core` | P4 | Autopilot detail route; API gap; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/autopilots/page.tsx` | `required-core` | P4 | Autopilot list route; API gap; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/billing/page.tsx` | `excluded-dead-dev` | X | Source renders `billing-test-page.tsx`; no Berry target/API; exclusion test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/chat/page.tsx` | `required-core` | P3 | Workspace chat route; API gap; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/inbox/page.tsx` | `required-core` | P2 | Inbox route; API gap; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/issues/[id]/page.tsx` | `required-core` | P2 | Issue detail route; API partial; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/issues/page.tsx` | `required-core` | P2 | Issue views route; API partial; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/members/[id]/page.tsx` | `required-core` | P1 | Member profile route; API gap; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/my-issues/page.tsx` | `required-core` | P2 | Personal issue view; API gap; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/projects/[id]/page.tsx` | `required-core` | P2 | Project detail route; API gap; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/projects/page.tsx` | `required-core` | P2 | Project list route; API gap; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/runtimes/[id]/page.tsx` | `replaced-by-runtime` | P3 | Berry runtime projection; adapter-gap; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/runtimes/[id]/runtime/[runtimeId]/page.tsx` | `replaced-by-runtime` | P3 | Execution detail projection; adapter-gap; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/runtimes/page.tsx` | `replaced-by-runtime` | P3 | Runtime/agent availability projection; adapter-gap; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/settings/page.tsx` | `required-core` | P1 | Settings shell; domain APIs are phased below; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/skills/[id]/page.tsx` | `required-core` | P3 | Skill detail/catalog route; API gap; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/skills/page.tsx` | `required-core` | P3 | Skill list/catalog route; API gap; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/squads/[id]/page.tsx` | `required-core` | P3 | Squad detail route; API gap; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/squads/page.tsx` | `required-core` | P3 | Squad list route; API gap; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/(dashboard)/usage/page.tsx` | `required-core` | P3 | Berry run-ledger usage/cost route; API gap; test missing | [ ] TBD |
| `apps/web/app/[workspaceSlug]/attachments/[id]/preview/page.tsx` | `required-core` | P2 | Authorized attachment preview; API gap; test missing | [ ] TBD |

## Sidebar and settings inventory

### Primary workspace sidebar entries/actions (13)

Evidence: `packages/views/layout/app-sidebar.tsx`.

| Entry | Classification | Phase | Berry API / test status | Acceptance evidence |
|---|---|---:|---|---|
| New issue action | `required-core` | P2 | Issue create API partial; shortcut/route test missing | [ ] TBD |
| Inbox | `required-core` | P2 | API gap; navigation/unread test missing | [ ] TBD |
| Chat | `required-core` | P3 | API gap; navigation/unread test missing | [ ] TBD |
| My issues | `required-core` | P2 | API gap; navigation/filter test missing | [ ] TBD |
| Issues | `required-core` | P2 | API partial; navigation/view test missing | [ ] TBD |
| Projects | `required-core` | P2 | API gap; navigation test missing | [ ] TBD |
| Autopilots | `required-core` | P4 | API gap; navigation test missing | [ ] TBD |
| Agents | `required-core` | P3 | API partial; navigation/presence test missing | [ ] TBD |
| Squads | `required-core` | P3 | API gap; navigation test missing | [ ] TBD |
| Usage | `required-core` | P3 | API gap; navigation/chart test missing | [ ] TBD |
| Runtimes | `replaced-by-runtime` | P3 | Adapter-gap; projection test missing | [ ] TBD |
| Skills | `required-core` | P3 | API gap; navigation test missing | [ ] TBD |
| Settings | `required-core` | P1 | Domain APIs phased below; tab routing test missing | [ ] TBD |

Pinned/reorderable issue, project, and saved-view links are classified separately
under the shell and issue-view families below.

### Settings tabs (20)

Evidence: `packages/views/settings/components/settings-page.tsx`. Billing and
plugins are source feature-flagged; Labs is an explicit empty placeholder in
`packages/views/settings/components/labs-tab.tsx`. The component's dynamic
`extraAccountTabs` hook is documented for desktop daemon settings; it is
`excluded-nonweb` and does not add a Berry web tab.

| Tab / source value | Classification | Phase | Berry API / test status | Acceptance evidence |
|---|---|---:|---|---|
| Profile (`profile`) | `required-core` | P1 | User API gap; form/auth test missing | [ ] TBD |
| Preferences (`preferences`) | `required-core` | P1 | Preference API gap; persistence test missing | [ ] TBD |
| Keyboard shortcuts (`shortcuts`) | `required-core` | P1 | API N/A; interaction/conflict test missing | [ ] TBD |
| Issue preferences (`issue`) | `required-core` | P2 | Preference API gap; behavior test missing | [ ] TBD |
| Chat preferences (`chat`) | `required-core` | P3 | Preference API gap; behavior test missing | [ ] TBD |
| Notification preferences (`notifications`) | `required-core` | P2 | API gap; delivery/preference test missing | [ ] TBD |
| Personal access tokens (`tokens`) | `required-core` | P1 | API gap; secret lifecycle test missing | [ ] TBD |
| Workspace general (`workspace`) | `required-core` | P1 | Workspace API gap; settings test missing | [ ] TBD |
| Repositories (`repositories`) | `required-core` | P4 | Repository binding API gap; test missing | [ ] TBD |
| GitHub (`github`) | `required-core` | P4 | GitHub API gap; install/webhook test missing | [ ] TBD |
| Integrations (`integrations`, including legacy `lark` redirect) | `required-core` | P4 | Integration APIs gap; config-gate tests missing | [ ] TBD |
| Labs (`labs`) | `excluded-dead-dev` | X | Empty placeholder; API N/A; route/tab absence test missing | [ ] TBD |
| Members (`members`) | `required-core` | P1 | Membership API gap; role test missing | [ ] TBD |
| Billing (`billing`, flag-gated) | `optional-hosted` | P5 | Hosted subscription API gap; fail-closed test missing | [ ] TBD |
| Labels (`labels`) | `required-core` | P2 | API gap; CRUD test missing | [ ] TBD |
| Issue statuses (`issue-statuses`) | `required-core` | P2 | API gap; transition/order test missing | [ ] TBD |
| Properties (`properties`) | `required-core` | P2 | API gap; schema/value test missing | [ ] TBD |
| Quick actions (`quick-actions`) | `required-core` | P2 | API gap; render/run test missing | [ ] TBD |
| MCP (`mcp`) | `required-core` | P3 | Berry catalog/runtime binding API gap; test missing | [ ] TBD |
| Plugins (`plugins`, flag-gated) | `required-core` | P4 | Product install/consent API gap; execution adapter test missing | [ ] TBD |

## Feature-family completion matrix

### Shell, navigation, search, shortcuts, and localization

| Feature/check | Source evidence | Classification | Phase | Berry target / API / test status | Acceptance evidence |
|---|---|---|---:|---|---|
| Responsive authenticated shell, page headers, sidebar collapse, mobile web sheet | `packages/views/layout/`, `e2e/navigation.spec.ts` | `required-core` | P1 | Shell target; API N/A; responsive test missing | [ ] TBD |
| Workspace switcher with create/switch/logout and pending invitation actions | `packages/views/layout/app-sidebar.tsx` | `required-core` | P1 | Workspace/invitation APIs gap; test missing | [ ] TBD |
| Active navigation across child routes and stable route icons | `packages/views/layout/app-sidebar.tsx` | `required-core` | P1 | Route target; API N/A; test missing | [ ] TBD |
| Reorderable pins for issues, projects, and saved views | `packages/views/layout/app-sidebar.tsx`, `packages/core/pins/` | `required-core` | P2 | Pins API gap; drag/reload test missing | [ ] TBD |
| Global issue/project search and keyboard-opened search UI | `packages/core/search/`, `packages/core/api/client.ts` | `required-core` | P2 | `/api/v1/search` contract gap; relevance/auth test missing | [ ] TBD |
| Configurable shortcuts, keycaps, create issue, and command actions | `packages/core/shortcuts/`, settings `shortcuts` tab | `required-core` | P1 | Preference API gap where persisted; conflict/focus test missing | [ ] TBD |
| Locale detection, explicit user choice, persistence, and routing | `packages/core/i18n/`, `apps/web/lib/locale-routing.ts` | `required-core` | P4 | User locale API gap; routing test missing | [ ] TBD |
| Complete namespace parity for `en`, `zh-Hans`, `ja`, and `ko` | `packages/views/locales/`, `packages/views/locales/parity.test.ts` | `required-core` | P4 | API N/A; Berry locale parity test missing | [ ] TBD |
| Localized dates, relative time, empty/error states, and onboarding | `packages/views/i18n/`, `e2e/onboarding-smoke.spec.ts` | `required-core` | P4 | API N/A; visual/journey test missing | [ ] TBD |
| Help launcher and self-host-safe support links | `packages/views/layout/help-launcher.tsx` | `required-core` | P1 | Config API gap; link/privacy test missing | [ ] TBD |

### Authentication, onboarding, workspaces, invitations, and sharing

| Feature/check | Source evidence | Classification | Phase | Berry target / API / test status | Acceptance evidence |
|---|---|---|---:|---|---|
| Email-code login, verification, logout, expiry, and redirect | `packages/core/auth/`, `e2e/auth.spec.ts` | `required-core` | P1 | Auth/session API gap; test missing | [ ] TBD |
| Optional configured OAuth login and callback state validation | `apps/web/app/auth/callback/page.tsx`, `server/cmd/server/router.go` | `required-core` | P1 | Provider-neutral auth API gap; CSRF/replay test missing | [ ] TBD |
| Authenticated route guards and safe return URLs | `e2e/auth.spec.ts`, `apps/web/app/(auth)/` | `required-core` | P1 | Middleware gap; open-redirect test missing | [ ] TBD |
| First-run onboarding shell, answers, skip, and resumable state | `packages/core/onboarding/`, `e2e/onboarding-*.spec.ts` | `required-core` | P1 | Onboarding API gap; test missing | [ ] TBD |
| Multi-workspace list, create, switch, update, leave, and delete | `packages/core/workspace/`, `server/cmd/server/router.go` | `required-core` | P1 | Workspace API gap; isolation/lifecycle test missing | [ ] TBD |
| Workspace roles, member profile, invite, role update, and removal | `apps/docs/content/docs/members-roles.mdx`, `packages/core/workspace/` | `required-core` | P1 | Membership API gap; authorization matrix test missing | [ ] TBD |
| Personal invitation list, preview, accept, decline, and revoke | `apps/web/app/(auth)/invitations/`, `packages/core/api/client.ts` | `required-core` | P1 | Invitation API gap; expiry/race test missing | [ ] TBD |
| Share-link create, preview, join, limits, expiry, and revoke | `packages/core/api/client.ts`, router share-link routes | `required-core` | P1 | Share-link API gap; abuse/expiry test missing | [ ] TBD |
| Workspace-scoped authorization on HTTP, WebSocket, and persisted rows | `server/internal/middleware/`, `server/cmd/server/router.go` | `required-core` | P0 | Auth contract/middleware gap; cross-workspace test missing | [ ] TBD |
| Personal access token create/list/renew/revoke without secret replay | `packages/core/api/client.ts`, router `/api/tokens` | `required-core` | P1 | Token API gap; hashing/revocation test missing | [ ] TBD |

### Issues, views, detail, and collaboration

| Feature/check | Source evidence | Classification | Phase | Berry target / API / test status | Acceptance evidence |
|---|---|---|---:|---|---|
| Board, list, and server-grouped table modes | `packages/core/issues/`, `e2e/issues.spec.ts`, `e2e/issue-table.spec.ts` | `required-core` | P2 | Issue API partial; grouping/cursor tests missing | [ ] TBD |
| My issues and workspace issues scopes | `apps/web/app/[workspaceSlug]/(dashboard)/my-issues/`, `issues/` | `required-core` | P2 | Query/filter contract gap; isolation test missing | [ ] TBD |
| Filter builder with statuses, assignees, projects, labels, properties, and dates | `packages/core/issues/`, `e2e/issues.spec.ts` | `required-core` | P2 | Filter contract gap; combinatorial test missing | [ ] TBD |
| Table facets, counts, groups, rows, branch cursors, and retry states | `packages/core/api/client.ts`, `e2e/issue-table.spec.ts` | `required-core` | P2 | Facet/group/row API gap; 1,001-row test missing | [ ] TBD |
| Saved issue views, active-view preference, share-safe definitions, and CRUD | `packages/core/issue-views/` | `required-core` | P2 | View/preference API gap; persistence test missing | [ ] TBD |
| Issue create, quick create, draft restore, dismiss, and idempotency | `packages/core/issues/stores/`, `e2e/issues.spec.ts` | `required-core` | P2 | Create API partial; draft/idempotency test missing | [ ] TBD |
| Issue detail read/edit/delete/move and optimistic conflict handling | `apps/web/app/[workspaceSlug]/(dashboard)/issues/[id]/`, client issue methods | `required-core` | P2 | Detail API partial; concurrency test missing | [ ] TBD |
| Status, priority, assignee, project, due date, labels, and custom properties | `packages/core/types/`, issue/status/label/property packages | `required-core` | P2 | Field/catalog APIs gap; validation test missing | [ ] TBD |
| Bulk select, batch update, and batch delete with partial-failure reporting | router `/api/issues/batch-*`, `packages/core/api/client.ts` | `required-core` | P2 | Bulk API gap; authorization/atomicity test missing | [ ] TBD |
| Parent/child relationships, nested display, cross-group placement, and progress | router issue children routes, `e2e/issue-table.spec.ts` | `required-core` | P2 | Relationship API gap; cycle/progress test missing | [ ] TBD |
| Comment create/edit/delete, revision conflict, threading, and resolve state | `packages/core/api/client.ts`, `e2e/comments.spec.ts` | `required-core` | P2 | Comment API partial; same-issue/thread test missing | [ ] TBD |
| Comment and issue emoji reactions | client reaction methods, router reaction routes | `required-core` | P2 | Reaction API gap; uniqueness/authorization test missing | [ ] TBD |
| Subscribers, subscribe/unsubscribe, subtree behavior, and actor visibility | client subscriber methods, router subscriber routes | `required-core` | P2 | Subscriber API gap; notification test missing | [ ] TBD |
| Attachment upload, binding, metadata, preview, download, and deletion | `packages/core/attachments/`, router attachment routes | `required-core` | P2 | Attachment API gap; auth/content-policy test missing | [ ] TBD |
| Timeline and execution log with ordered events, output, usage, and terminal state | router timeline/task-run routes, `packages/core/api/client.ts` | `required-core` | P3 | Run API partial; event-order/replay test missing | [ ] TBD |
| Run-event SSE with durable replay/cursor semantics and no duplicate dispatch on reconnect | Berry run contract, the agent runtime contract | `required-core` | P3 | SSE contract partial; disconnect/resume test missing | [ ] TBD |
| Cancel and explicit rerun without duplicate dispatch | client `cancelTask`/`rerunIssue`, the agent runtime contract | `replaced-by-runtime` | P3 | Adapter/run-ledger gap; ambiguity test missing | [ ] TBD |
| Human-only review decision with run evidence before release | Berry product brief and run contract | `required-core` | P3 | Review resource/workflow API gap; authorization test missing | [ ] TBD |
| Issue/project/view pin, unpin, reorder, missing-target handling | `packages/core/pins/`, sidebar pin code | `required-core` | P2 | Pins API gap; realtime/delete test missing | [ ] TBD |
| Labels, custom statuses, property definitions/icons, and quick-action definitions | settings tabs, `e2e/property-icons.spec.ts`, `e2e/quick-actions.spec.ts` | `required-core` | P2 | Catalog/action APIs gap; tests missing | [ ] TBD |
| Quick-action render and run with hidden prompt kept server-side | router quick-action routes, `e2e/quick-actions.spec.ts` | `required-core` | P2 | API gap; prompt-disclosure/action test missing | [ ] TBD |
| Pull-request links and issue metadata without exposing provider secrets | router issue pull-request/metadata routes | `required-core` | P4 | VCS projection API gap; authorization test missing | [ ] TBD |

### Projects, resources, inbox, and notifications

| Feature/check | Source evidence | Classification | Phase | Berry target / API / test status | Acceptance evidence |
|---|---|---|---:|---|---|
| Project list/search/create/detail/update/delete | `packages/core/projects/`, router project routes | `required-core` | P2 | Project API gap; CRUD/search test missing | [ ] TBD |
| Project priority, status, issue rollups, and activity | project views and migrations | `required-core` | P2 | Project aggregate API gap; projection test missing | [ ] TBD |
| Project resources create/edit/order/delete and safe external links | `apps/docs/content/docs/project-resources.mdx`, router resource routes | `required-core` | P2 | Resource API gap; URL/permission test missing | [ ] TBD |
| Inbox unread, archived, mark read/unread, archive/unarchive | `packages/core/inbox/`, router inbox routes | `required-core` | P2 | Inbox API gap; state test missing | [ ] TBD |
| Bulk inbox actions and completed-item cleanup | router inbox bulk routes | `required-core` | P2 | Bulk API gap; count/idempotency test missing | [ ] TBD |
| Cross-workspace unread summary and sidebar indicators | `packages/views/layout/app-sidebar.tsx`, inbox unread routes | `required-core` | P2 | Account summary API gap; isolation test missing | [ ] TBD |
| Notification preferences by workspace/channel/event | `packages/core/notification-preferences/` | `required-core` | P2 | Preference API gap; delivery-suppression test missing | [ ] TBD |
| Realtime invalidation for issues, projects, chat, and inbox | `packages/core/realtime/`, router `/ws` | `required-core` | P4 | WebSocket contract gap; ordering/reconnect test missing | [ ] TBD |

### Chat, agents, builder, skills, MCP, squads, runtimes, and usage

| Feature/check | Source evidence | Classification | Phase | Berry target / API / test status | Acceptance evidence |
|---|---|---|---:|---|---|
| Chat session create/list/update/delete, pin, archive, and unread | `packages/core/chat/`, router chat routes | `required-core` | P3 | Chat API gap; lifecycle/unread test missing | [ ] TBD |
| Paginated messages, ordered send, failure state, and elapsed/usage data | client chat methods, router message routes | `required-core` | P3 | Message API gap; ordering/retry test missing | [ ] TBD |
| Chat attachments bound to session/message | `e2e/chat-attachments.spec.ts` | `required-core` | P3 | Attachment/chat API gap; binding test missing | [ ] TBD |
| Pending/queued task state, prioritize/clear, draft restore, and quick actions | router chat pending/draft/quick-action routes | `required-core` | P3 | Product queue API gap; race test missing | [ ] TBD |
| Agent lifecycle: list/detail/create/update/archive/restore | `packages/core/agents/`, router agent routes | `required-core` | P3 | Agent API partial; lifecycle test missing | [ ] TBD |
| Agent permissions, ownership, labels, environment secret writes, and audit | router agent env/label routes | `required-core` | P3 | Product API gap; secret/role audit test missing | [ ] TBD |
| Assisted and manual agent builder, resumable sessions, autosaved draft, runtime switch | agent builder pages, router builder routes | `required-core` | P3 | Builder API gap; resume/concurrency test missing | [ ] TBD |
| Skill list/search/create/import/detail/edit/delete/refresh | `packages/core/skills/`, router skill routes | `required-core` | P3 | Skill API gap; provenance/CRUD test missing | [ ] TBD |
| Skill files, labels, agent assignment, ordering, and enabled state | router skill/agent-skill routes | `required-core` | P3 | API gap; authorization/merge test missing | [ ] TBD |
| Workspace MCP catalog with write-only credentials | settings MCP tab, router workspace MCP routes | `required-core` | P3 | Catalog API gap; redaction/role test missing | [ ] TBD |
| Agent MCP assignment, enable state, and creator-only management | router agent MCP routes, `e2e/agent-mcp.spec.ts` | `required-core` | P3 | Binding/runtime adapter gap; role test missing | [ ] TBD |
| Squad list/detail/CRUD, members, roles, and status | `packages/core/squads/`, router squad routes | `required-core` | P3 | Squad API gap; role/evaluation test missing | [ ] TBD |
| Runtime availability, model/capability display, and agent binding as a runtime projection | runtime pages, the agent runtime contract | `replaced-by-runtime` | P3 | Adapter-gap; projection/absence-of-daemon test missing | [ ] TBD |
| Local runtime update, model scan, local skill import, and machine heartbeat | router runtime/daemon routes | `replaced-by-runtime` | X | No legacy API; boundary test missing | [ ] TBD |
| Workspace usage totals, by-agent/by-hour/day charts, run time, and failures | `packages/core/dashboard/`, router dashboard routes | `required-core` | P3 | Run-ledger analytics API gap; reconciliation test missing | [ ] TBD |
| Issue and runtime usage/cost drill-down tied to Berry run IDs | client usage methods, runtime usage mapping | `required-core` | P3 | API/run-ledger gap; accounting test missing | [ ] TBD |

### Automation, VCS, channels, Composio, and plugins

| Feature/check | Source evidence | Classification | Phase | Berry target / API / test status | Acceptance evidence |
|---|---|---|---:|---|---|
| Autopilot list/detail/create/update/delete | `packages/core/autopilots/`, router autopilot routes | `required-core` | P4 | API gap; CRUD/role test missing | [ ] TBD |
| Cron preview, manual trigger, schedules, webhook triggers, signing secrets, and rotation | router autopilot trigger routes | `required-core` | P4 | API gap; schedule/signature test missing | [ ] TBD |
| Autopilot runs, quota, collaborators, deliveries, replay, and terminal evidence | router autopilot run/delivery routes | `required-core` | P4 | API/run-ledger gap; replay/idempotency test missing | [ ] TBD |
| Repository bindings and provider-neutral VCS connections | settings repositories tab, `packages/core/vcs/` | `required-core` | P4 | API gap; credential/webhook test missing | [ ] TBD |
| GitHub App connect/install/repository list/webhook/PR projection | `packages/core/github/`, `apps/docs/content/docs/github-integration.mdx` | `required-core` | P4 | GitHub API gap; signature/installation test missing | [ ] TBD |
| Slack install/list/revoke, identity binding, and channel message flow | `packages/core/slack/`, Slack docs, router Slack routes | `required-core` | P4 | Config-gated API gap; callback/message test missing | [ ] TBD |
| Lark install/status/list/revoke, identity binding, and message flow | `packages/core/lark/`, Lark docs, router Lark routes | `required-core` | P4 | Config-gated API gap; callback/message test missing | [ ] TBD |
| DingTalk BYO install, group routes, identity binding, and message flow | `packages/core/dingtalk/`, DingTalk docs, router routes | `required-core` | P4 | Config-gated API gap; route/message test missing | [ ] TBD |
| WeCom BYO install/list/revoke, identity binding, and message flow | `packages/core/wecom/`, router WeCom routes | `required-core` | P4 | Config-gated API gap; callback/message test missing | [ ] TBD |
| Telegram bot install/list/revoke, identity binding, and message flow | `packages/core/telegram/`, Telegram docs, router routes | `required-core` | P4 | Config-gated API gap; update/message test missing | [ ] TBD |
| Composio toolkit discovery, OAuth connect/callback, list, and disconnect | `packages/core/composio/`, `e2e/settings.spec.ts` | `required-core` | P4 | Config-gated API gap; state/replay test missing | [ ] TBD |
| Plugin preview/consent/install/configure/enable/disable/uninstall | `packages/core/plugins/`, router workspace plugin routes | `required-core` | P4 | Product API gap; consent/role test missing | [ ] TBD |
| Plugin tokens, invocation audit, MCP tool schema approval, and storage scopes | router plugin routes and `/api/v1/plugin` | `required-core` | P4 | Berry product API gap; scope/redaction test missing | [ ] TBD |
| Plugin action UI and iframe bridge with origin/token/scroll isolation | plugin views, `e2e/iframe-scroll-bridge.spec.ts` | `required-core` | P4 | Host bridge contract gap; sandbox test missing | [ ] TBD |
| Plugin/agent tool execution | daemon plugin hooks and MCP credential routes | `replaced-by-runtime` | P4 | Runtime MCP/tool adapter gap; no-daemon test missing | [ ] TBD |

### Optional hosted/cloud and public marketing

| Feature/check | Source evidence | Classification | Phase | Berry target / API / test status | Acceptance evidence |
|---|---|---|---:|---|---|
| Account cloud balance, prices, checkout, portal, transactions, batches, and top-ups | `packages/core/billing/`, router `/api/cloud-billing` | `optional-hosted` | P5 | Optional module API gap; disabled/fail-closed test missing | [ ] TBD |
| Workspace subscriptions, prices, entitlements, seats, checkout, and portal | settings billing tab, router `/api/cloud-subscriptions` | `optional-hosted` | P5 | Optional module API gap; disabled/role test missing | [ ] TBD |
| Managed cloud fleet provisioning and lifecycle | `packages/core/runtimes/cloud-runtime.ts`, router `/api/cloud-runtime` | `optional-hosted` | P5 | Optional module gap; absent-config test missing | [ ] TBD |
| Cloud node arbitrary execution/provider plumbing | router `/api/cloud-runtime/nodes/exec` and legacy provider code | `replaced-by-runtime` | X | No Berry endpoint; exclusion test missing | [ ] TBD |
| Contact-sales submission and abuse controls | landing contact page, router `/api/contact-sales` | `optional-hosted` | P5 | Optional API gap; rate-limit/privacy test missing | [ ] TBD |
| About, homepage, use cases, changelog, and localized marketing content | `apps/web/app/(landing)/`, `apps/web/features/landing/` | `optional-hosted` | P5 | Public site target; content API optional; tests missing | [ ] TBD |
| Download marketing page | `apps/web/app/(landing)/download/page.tsx` | `optional-hosted` | P5 | Page may link external artifacts; native clients excluded; test missing | [ ] TBD |

## API/domain-family classification

This table reconciles the legacy client and router families so the roughly 417
product route registrations cannot be treated as a port checklist. Berry
extends its own `/api/v1` contract; it does not preserve Multica paths or
snake_case wire shapes.

| Legacy API/domain family | Source evidence | Classification | Phase | Berry API / test status | Acceptance evidence |
|---|---|---|---:|---|---|
| Health, readiness, request IDs, CORS, metrics | router operational routes and middleware | `required-core` | P0 | Operational contract gap; boot/probe test missing | [ ] TBD |
| Product WebSocket subscriptions and fanout | router `/ws`, `packages/core/realtime/` | `required-core` | P4 | Berry WS contract gap; auth/backpressure test missing | [ ] TBD |
| Auth, sessions, OAuth, profile, onboarding | router auth and `/api/me*` | `required-core` | P1 | `/api/v1` gap; security tests missing | [ ] TBD |
| Public config and self-host feature availability | router `/api/config`, `packages/core/config/` | `required-core` | P0 | Config contract gap; safe-default test missing | [ ] TBD |
| Feedback and client-usage telemetry | router `/api/feedback`, `/api/client-usage` | `optional-hosted` | P5 | Explicit opt-in API gap; disabled/privacy test missing | [ ] TBD |
| Attachments, avatars, uploads, signed downloads | router attachment/avatar/upload routes | `required-core` | P2 | `/api/v1` gap; storage/auth tests missing | [ ] TBD |
| Workspaces, memberships, invitations, share links | router `/api/workspaces`, invitations/share routes | `required-core` | P1 | `/api/v1` gap; isolation tests missing | [ ] TBD |
| Personal access tokens | router `/api/tokens` | `required-core` | P1 | `/api/v1` gap; secret tests missing | [ ] TBD |
| CLI token issuance | router `/api/cli-token` | `replaced-by-runtime` | X | No Berry endpoint; the server owns execution-client access; boundary test missing | [ ] TBD |
| Issues, search, grouped queries, table groups/rows/facets | router `/api/issues` | `required-core` | P2 | Partial/gap; query/cursor tests missing | [ ] TBD |
| Issue views and view preferences | router issue-view routes | `required-core` | P2 | API gap; persistence tests missing | [ ] TBD |
| Comments, reactions, subscribers, timeline | issue/comment routes | `required-core` | P2 | Comments partial; remainder gap; tests missing | [ ] TBD |
| Labels, issue statuses, properties, quick actions | router catalog/action routes | `required-core` | P2 | API gap; CRUD/domain tests missing | [ ] TBD |
| Projects and project resources | router `/api/projects` | `required-core` | P2 | API gap; tests missing | [ ] TBD |
| Pins | router `/api/pins` | `required-core` | P2 | API gap; order tests missing | [ ] TBD |
| Inbox and notification preferences | router inbox/preference routes | `required-core` | P2 | API gap; tests missing | [ ] TBD |
| Agents and builder sessions | router agent/builder routes | `required-core` | P3 | Agent read partial; mutations/builder gap; tests missing | [ ] TBD |
| Skills and agent-skill bindings | router skill routes | `required-core` | P3 | API gap; tests missing | [ ] TBD |
| Workspace/agent MCP catalogs and bindings | workspace and agent MCP routes | `required-core` | P3 | Product/runtime adapter gap; tests missing | [ ] TBD |
| Squads and leader evaluation | router squad routes | `required-core` | P3 | API gap; tests missing | [ ] TBD |
| Berry runs, task messages, cancel/rerun, usage | issue task/run routes and current Berry run contract | `required-core` | P3 | Run contract partial; projection gap; tests missing | [ ] TBD |
| Legacy task claim/lease/progress/complete/fail/session/GC APIs | router `/api/daemon` | `replaced-by-runtime` | X | No legacy endpoint; boundary test missing | [ ] TBD |
| Legacy daemon registration, heartbeat, workspace sync, and daemon WS | router `/api/daemon` | `replaced-by-runtime` | X | No legacy endpoint; boundary test missing | [ ] TBD |
| Runtime profile, update, local model, and local skill request APIs | workspace/runtime routes | `replaced-by-runtime` | P3 | Runtime projection gap; tests missing | [ ] TBD |
| Dashboard, runtime, issue, agent activity, and run-count analytics | router dashboard/usage/activity routes | `required-core` | P3 | Run-ledger API gap; reconciliation tests missing | [ ] TBD |
| Chat sessions, messages, pending tasks, pinned agents, draft restores | router chat routes | `required-core` | P3 | API gap; tests missing | [ ] TBD |
| Autopilots, triggers, runs, collaborators, deliveries, webhooks | router autopilot routes | `required-core` | P4 | API gap; scheduler/idempotency tests missing | [ ] TBD |
| GitHub installations, repositories, setup, webhook, PR links | router GitHub routes | `required-core` | P4 | API gap; tests missing | [ ] TBD |
| Provider-neutral VCS connections and webhooks | router VCS routes | `required-core` | P4 | API gap; tests missing | [ ] TBD |
| Slack installation, binding, and channel adapter | router Slack routes | `required-core` | P4 | Config-gated API gap; tests missing | [ ] TBD |
| Lark installation, binding, and channel adapter | router Lark routes | `required-core` | P4 | Config-gated API gap; tests missing | [ ] TBD |
| DingTalk installation, group routing, binding, channel adapter | router DingTalk routes | `required-core` | P4 | Config-gated API gap; tests missing | [ ] TBD |
| WeCom installation, binding, and channel adapter | router WeCom routes | `required-core` | P4 | Config-gated API gap; tests missing | [ ] TBD |
| Telegram installation, binding, and channel adapter | router Telegram routes | `required-core` | P4 | Config-gated API gap; tests missing | [ ] TBD |
| Composio toolkits, connections, connect state, callback | router Composio routes | `required-core` | P4 | Config-gated API gap; tests missing | [ ] TBD |
| Plugin install/config/audit/storage/action surface | workspace plugin and `/api/v1/plugin` routes | `required-core` | P4 | Berry API gap; tests missing | [ ] TBD |
| Plugin hooks/MCP execution via daemon | daemon plugin routes | `replaced-by-runtime` | P4 | Runtime tool adapter gap; no-daemon test missing | [ ] TBD |
| Cloud billing and Stripe webhook proxy | router cloud-billing routes | `optional-hosted` | P5 | Optional API gap; fail-closed tests missing | [ ] TBD |
| Workspace subscriptions and entitlement proxy | router cloud-subscriptions routes | `optional-hosted` | P5 | Optional API gap; fail-closed tests missing | [ ] TBD |
| Managed cloud runtime fleet lifecycle | router cloud-runtime routes except `exec` | `optional-hosted` | P5 | Optional API gap; disabled tests missing | [ ] TBD |
| Cloud node `exec`, legacy self-exec, provider adapters, filesystem execution | cloud-runtime `exec`, `server/internal/selfexec/`, daemon/provider code | `replaced-by-runtime` | X | No Berry implementation; repository boundary test missing | [ ] TBD |
| Contact sales and public-site content | public router/landing files | `optional-hosted` | P5 | Optional API/content gap; tests missing | [ ] TBD |

The 413 legacy up migrations are schema history evidence, not an instruction to
replay or renumber them in Berry. Each required domain must receive a
Berry-owned PostgreSQL design and migration with data invariants, rollback or
forward-fix strategy, and compatibility evidence. Daemon/execution and
hosted-only tables follow their classifications above.

## Documented-feature reconciliation

The four localized copies of each topic under `apps/docs/content/docs/*.mdx`
share the classification of their English topic below. This closes the gap
between source code inventory and capabilities promised in user documentation.

| Pinned documentation topics | Classification | Phase | Berry documentation/API/test status | Acceptance evidence |
|---|---|---:|---|---|
| `index`, `concepts`, `how-multica-works`, `tutorial` | `required-core` | P1-P4 | Berry product docs gap; API/test links must match the relevant rows above | [ ] TBD |
| `workspaces`, `members-roles`, `issues`, `projects`, `project-resources`, `comments`, `inbox` | `required-core` | P1-P2 | Berry feature docs gap; APIs/tests gap as above | [ ] TBD |
| `agents`, `agents-create`, `assigning-issues`, `mentioning-agents`, `triggering-agents`, `tasks`, `chat`, `skills`, `squads`, `autopilots`, `channels` | `required-core` | P3-P4 | Berry/runtime-boundary docs gap; APIs/tests gap as above | [ ] TBD |
| `github-integration`, `vcs-integration`, `slack-bot-integration`, `lark-bot-integration`, `dingtalk-bot-integration`, `telegram-bot-integration` | `required-core` | P4 | Config-gated integration docs/APIs/tests gap | [ ] TBD |
| `auth-setup`, `auth-tokens`, `security-model`, `self-host-quickstart`, `environment-variables`, `troubleshooting` | `required-core` | P0-P1 | Berry operations/security docs gap; boot/auth tests missing | [ ] TBD |
| `developers/architecture`, `developers/contributing`, `developers/conventions`, `community-maintained` | `required-core` | P0 | Berry contributor/architecture docs partial; link validation/review missing | [ ] TBD |
| `cloud-quickstart` | `optional-hosted` | P5 | Optional module docs gap; disabled-self-host test missing | [ ] TBD |
| `cli`, `daemon-runtimes`, `install-agent-runtime`, `providers` | `replaced-by-runtime` | X | Berry docs must point to the supported runtime boundary, not port instructions | [ ] TBD |
| `desktop-app`, `mobile-app` | `excluded-nonweb` | X | No Berry native-client docs or parity claim | [ ] TBD |

## Pinned E2E journey contract

Every pinned `e2e/*.spec.ts` family is classified below. Berry may rewrite the
tests, but it must preserve required user outcomes and add negative
authorization/failure assertions.

| Pinned spec / journey | Classification | Phase | Berry API / test status | Acceptance evidence |
|---|---|---:|---|---|
| `e2e/agent-mcp.spec.ts`: creator sees MCP Apps and toggling a toolkit writes the allowlist | `required-core` | P3 | MCP API/adapter gap; test missing | [ ] TBD |
| `e2e/agent-mcp.spec.ts`: non-creator viewer does not see MCP Apps | `required-core` | P3 | MCP authorization gap; negative test missing | [ ] TBD |
| `e2e/auth.spec.ts`: login page renders | `required-core` | P1 | Auth API gap; route/render test missing | [ ] TBD |
| `e2e/auth.spec.ts`: login redirects to Issues | `required-core` | P1 | Auth API gap; redirect test missing | [ ] TBD |
| `e2e/auth.spec.ts`: unauthenticated user redirects to login | `required-core` | P1 | Auth middleware gap; route-guard test missing | [ ] TBD |
| `e2e/auth.spec.ts`: logout redirects to login | `required-core` | P1 | Session API gap; logout test missing | [ ] TBD |
| `e2e/chat-attachments.spec.ts`: upload binds to session and send backfills message ID | `required-core` | P3 | Chat/attachment APIs gap; test missing | [ ] TBD |
| `e2e/comments.spec.ts`: add a comment on an issue | `required-core` | P2 | Comment API partial; test missing | [ ] TBD |
| `e2e/comments.spec.ts`: empty comment submit is disabled | `required-core` | P2 | API N/A; form test missing | [ ] TBD |
| `e2e/iframe-scroll-bridge.spec.ts`: sandbox without same-origin blocks session storage | `required-core` | P4 | Plugin bridge contract gap; security test missing | [ ] TBD |
| `e2e/iframe-scroll-bridge.spec.ts`: reports scroll position with the correct token | `required-core` | P4 | Plugin bridge contract gap; test missing | [ ] TBD |
| `e2e/iframe-scroll-bridge.spec.ts`: restores position from a parent message | `required-core` | P4 | Plugin bridge contract gap; test missing | [ ] TBD |
| `e2e/iframe-scroll-bridge.spec.ts`: holds delayed-append position then yields to user wheel | `required-core` | P4 | Plugin bridge contract gap; timing test missing | [ ] TBD |
| `e2e/iframe-scroll-bridge.spec.ts`: ignores a mismatched restore token | `required-core` | P4 | Plugin bridge contract gap; negative test missing | [ ] TBD |
| `e2e/iframe-scroll-bridge.spec.ts`: bounded handshake restores once without a loop | `required-core` | P4 | Plugin bridge contract gap; loop test missing | [ ] TBD |
| `e2e/issue-table.spec.ts`: groups 1,001 issues without full-result materialization | `required-core` | P2 | Table API gap; scale test missing | [ ] TBD |
| `e2e/issue-table.spec.ts`: nests same-group children and roots cross-group children | `required-core` | P2 | Hierarchy API gap; test missing | [ ] TBD |
| `e2e/issue-table.spec.ts`: drops stale branch cursors after realtime sort changes | `required-core` | P2/P4 | Cursor/WS contracts gap; test missing | [ ] TBD |
| `e2e/issue-table.spec.ts`: branch retry never falls back to client grouping | `required-core` | P2 | Table API gap; failure test missing | [ ] TBD |
| `e2e/issues.spec.ts`: Issues loads in board mode | `required-core` | P2 | Issue API partial; test missing | [ ] TBD |
| `e2e/issues.spec.ts`: switch from board to list | `required-core` | P2 | Issue API partial; mode test missing | [ ] TBD |
| `e2e/issues.spec.ts`: filter by created and updated dates | `required-core` | P2 | Filter contract gap; test missing | [ ] TBD |
| `e2e/issues.spec.ts`: filter by a custom created date | `required-core` | P2 | Filter contract gap; test missing | [ ] TBD |
| `e2e/issues.spec.ts`: create an issue | `required-core` | P2 | Create API partial; test missing | [ ] TBD |
| `e2e/issues.spec.ts`: navigate to issue detail | `required-core` | P2 | Detail API partial; route test missing | [ ] TBD |
| `e2e/issues.spec.ts`: dismiss issue creation | `required-core` | P2 | API N/A; draft/dialog test missing | [ ] TBD |
| `e2e/navigation.spec.ts`: sidebar navigation works | `required-core` | P1 | Domain APIs phased; navigation test missing | [ ] TBD |
| `e2e/navigation.spec.ts`: Settings loads from sidebar | `required-core` | P1 | Settings APIs phased; route test missing | [ ] TBD |
| `e2e/navigation.spec.ts`: Agents shows the agent list | `required-core` | P3 | Agent API partial; route/list test missing | [ ] TBD |
| `e2e/onboarding-shell.spec.ts`: structural blocks match column width on every step | `required-core` | P1 | Onboarding API gap; responsive test missing | [ ] TBD |
| `e2e/onboarding-shell.spec.ts`: shell survives step changes without remounting | `required-core` | P1 | Onboarding API gap; state test missing | [ ] TBD |
| `e2e/onboarding-smoke.spec.ts`: welcome to about-you answer path | `required-core` | P1 | Onboarding API gap; journey test missing | [ ] TBD |
| `e2e/onboarding-smoke.spec.ts`: one skip clears the questionnaire step | `required-core` | P1 | Onboarding API gap; skip test missing | [ ] TBD |
| `e2e/onboarding-smoke.spec.ts`: `zh-Hans` renders Chinese labels | `required-core` | P4 | API N/A; locale journey test missing | [ ] TBD |
| `e2e/property-icons.spec.ts`: create, persist, and clear a custom property icon | `required-core` | P2 | Property API gap; test missing | [ ] TBD |
| `e2e/quick-actions.spec.ts`: render assistant action and send hidden prompt | `required-core` | P2 | Quick-action API gap; secrecy test missing | [ ] TBD |
| `e2e/settings.spec.ts`: workspace rename updates sidebar immediately | `required-core` | P1/P4 | Workspace API gap/WS gap; test missing | [ ] TBD |
| `e2e/settings.spec.ts`: Composio connect shows toast and refreshes list | `required-core` | P4 | Composio API gap; journey test missing | [ ] TBD |

## Explicit exclusions and boundary evidence

| Excluded source capability | Classification | Phase | Required Berry evidence | Acceptance evidence |
|---|---|---:|---|---|
| Desktop application and desktop-only settings/platform adapters | `excluded-nonweb` | X | No desktop workspace, packaging, updater, or desktop-only parity claim | [ ] TBD |
| Mobile application and mobile-native platform code | `excluded-nonweb` | X | Responsive web may ship; no native mobile import or parity claim | [ ] TBD |
| CLI client and CLI token/bootstrap flows | `replaced-by-runtime` | X | No Berry CLI binary or CLI-only API; execution-client access stays server-side | [ ] TBD |
| Daemon binary, daemon WebSocket, machine pairing, heartbeat, claim/lease loop | `replaced-by-runtime` | X | Repository scan and integration tests show the in-process runtime is the only execution path | [ ] TBD |
| Local launchers, provider adapters, model plumbing, sandbox, and filesystem execution | `replaced-by-runtime` | X | No implementation in `server-ts/`; all dispatch stays inside the server | [ ] TBD |
| Labs settings placeholder | `excluded-dead-dev` | X | No empty Labs tab or dead API | [ ] TBD |
| Temporary workspace billing test page (`packages/views/billing/billing-test-page.tsx`) | `excluded-dead-dev` | X | No test-quality billing route; optional real hosted billing is tracked separately | [ ] TBD |
| Deprecated onboarding runtime-bootstrap shims and transitional API aliases | `excluded-dead-dev` | X | No compatibility shim without a Berry migration requirement and removal date | [ ] TBD |

## Reconciliation gates

- [ ] **P0 — Route manifest:** Berry records the 48-page source baseline and
  links every retained/replaced route to a target route test. Evidence: TBD.
- [ ] **P0 — API manifest:** every method registration in the pinned router is
  assigned to an API/domain family above; an automated reconciliation artifact
  records any alias/exclusion. Evidence: TBD.
- [ ] **P0 — Migration/domain map:** all 413 up migrations are mapped to a
  required, optional, replaced, or excluded domain before schema adaptation.
  Evidence: TBD.
- [ ] **P1 — Workspace isolation:** all required-core HTTP and realtime
  operations have cross-workspace denial tests. Evidence: TBD.
- [ ] **P3 — Execution boundary:** repository and runtime tests prove no daemon,
  provider, sandbox, launcher, or filesystem executor was ported. Evidence:
  TBD.
- [ ] **P4 — Locale parity:** all required namespaces and routes pass parity in
  `en`, `zh-Hans`, `ja`, and `ko`. Evidence: TBD.
- [ ] **P5 — Self-host default:** required-core journeys pass with every
  hosted/cloud flag off and every hosted credential absent; optional endpoints
  fail closed. Evidence: TBD.
- [ ] **Final — No unclassified features:** a fresh pinned-tree inventory finds
  no page, sidebar entry, settings tab, API/domain family, documented web
  capability, or E2E journey missing from this matrix. Evidence: TBD.
