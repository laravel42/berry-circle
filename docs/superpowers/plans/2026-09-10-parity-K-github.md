# Workstream K: GitHub integration parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Berry's existing GitHub App integration to parity: workspace GitHub settings with a master switch and three toggles, a Repositories settings tab with a GitHub import picker, pull requests linked to issues from webhooks with state and checks in the issue sidebar, merge-with-close-intent moving the issue to done, and a `Co-authored-by` trailer on agent commits.

**Architecture:** One migration (110) adds four workspace-scoped tables. Pure modules (`scm/commit-trailer.ts`, `scm/pr-linking.ts`) hold the decisions; repositories (`scm/github-settings.ts`, `scm/pull-requests.ts`) hold persistence and write `outbox_events`; `scm/github-events.ts` routes a verified webhook to a workspace by **installation id** (never by name). A new mount `/api/v1/github/:workspaceId/*` goes through `mountWorkspaceScope`. The frontend adds a GitHub settings panel, a Repositories tab with an import picker, and a self-contained linked-PR sidebar component.

**Tech Stack:** Node 22 `--experimental-strip-types`, Hono, postgres.js, Zod v4 (server); Next.js 15, Zod v3, shadcn/ui (frontend).

**Spec:** `docs/superpowers/specs/2026-09-10-multica-parity-design.md` §7 (the main checkout's uncommitted copy of §7 is authoritative) and §11.

## Global Constraints

- Clean-room: multica is a behavioural reference only; no code, UI or copy copied.
- Web only.
- Migrations in block **110–119** only.
- Every new table carries `workspace_id`. New mounts go through the workspace guard (`mountWorkspaceScope`) and are added to `cross-tenant-leakage.test.ts`.
- Secrets only through `integrations/sealing.ts`; never sent to the browser, never logged.
- No emitted TS syntax on the server (no enums, namespaces, parameter properties). Zod v4 server, Zod v3 frontend.
- Realtime only through `outbox_events` + the existing SSE hub (replay topics in `realtime/replay.ts`).
- GitHub App stays separate from sign-in (workstream J). Do not touch `auth/`.
- Co-authored-by logic is a pure exported function (`coAuthorTrailer`) wired into the current delivery path with minimal edits (workstream A is moving the loop).
- The linked-PR panel is a self-contained component (workstream B owns the sidebar).
- Never weaken a test. Live-GitHub-dependent behaviour is unit-tested offline and marked BLOCKED-LIVE.
- DB-backed tests gate on `BERRY_TEST_DATABASE_URL` and self-skip without it.

## Behavioural decisions (clean-room, Berry's own)

- **Effective flag** = `enabled && toggle`. With the master switch off, webhooks for that workspace change nothing, the sidebar panel says nothing, and no trailer is added.
- **Tenant of a webhook** = `github_installations.workspace_id` for `payload.installation.id`. A payload without a known installation is ignored.
- **Linking.** A PR links to an issue when (a) its head branch equals a `runs.branch` Berry wrote for that issue (always, Berry issued it), or (b) with auto-link on, the workspace's issue key (`<PREFIX>-<n>`, case-insensitive) appears in the branch, title or body. A key preceded by a closing keyword (`close[sd]?`, `fix(e[sd])?`, `resolve[sd]?`, optional colon) carries **close intent**. Only keys whose prefix equals the workspace's `settings.issuePrefix` are considered; the issue is looked up by number **inside that workspace**.
- **State** = `merged` if `merged`, `draft` if open and `draft`, else `open`/`closed`.
- **Checks** stored per `(workspace, kind, github_id)` keyed to `(repo_id, head_sha)`; the sidebar rolls them up to `success | failure | pending | neutral | none`.
- **Close on merge.** A merged PR with a close-intent link moves the issue to `done` through `IssueRepository.update` (so the normal `issue.updated` / `issue.completed` events fire), unless already `done`/`cancelled` or the transition is not allowed.
- **Trailer** credits the human who requested the run (`runs.requested_by` → `users.name`, `users.email`), because commits are authored as `Berry <agent@berry.invalid>`.
- **Realtime topics:** `github.settings.updated`, `github.repositories.updated`, `github.connection.updated` (workspace stream); `github.pull_request.updated` (workspace and board stream, carries `issueId`).

## File map

Server (create): `migrations/110_github_integration_parity.up.sql`, `src/scm/commit-trailer.ts(+.test)`, `src/scm/pr-linking.ts(+.test)`, `src/scm/github-settings.ts(+.test)`, `src/scm/pull-requests.ts(+.test)`, `src/scm/github-events.ts(+.test)`, `src/mounts/github.ts(+.test)`.
Server (modify): `src/scm/inbound.ts`, `src/mounts/webhooks.ts`, `src/integrations/github-app.ts`, `src/integrations/github.ts`, `src/agents/delivery.ts`, `src/agents/repository-run.ts`, `src/realtime/replay.ts`, `src/index.ts`, `src/mounts/cross-tenant-leakage.test.ts`, `SCOPE.md`.
Frontend (create): `lib/github.ts`, `components/common/settings/github-integration-settings.tsx`, `components/common/settings/repositories-settings.tsx`, `components/common/settings/github-import-picker.tsx`, `app/[orgId]/settings/repositories/page.tsx`, `components/common/issues/details/issue-linked-pull-requests.tsx`.
Frontend (modify): `components/common/settings/integrations.tsx`, `components/layout/sidebar/nav-settings.tsx`, `components/common/issues/details/issue-properties-panel.tsx` (one line).

---

### Task 1: Migration 110

**Files:** Create `server-ts/migrations/110_github_integration_parity.up.sql`.

**Produces:** tables `github_workspace_settings(workspace_id PK, enabled, show_linked_prs, co_author_trailer, auto_link_prs, updated_by, updated_at)`, `workspace_repositories(id, workspace_id, url, description, github_repo_id, position, created_by, created_at, updated_at, UNIQUE(workspace_id,url))`, `github_pull_requests(id, workspace_id, github_id, repo_id, repo_full_name, number, title, url, state, draft, head_ref, head_sha, author_login, merged_at, closed_at, github_updated_at, created_at, updated_at, UNIQUE(workspace_id, github_id))`, `github_pull_request_links(workspace_id, pull_request_id, issue_id, close_intent, source, created_at, PK(pull_request_id, issue_id))`, `github_checks(id, workspace_id, kind, github_id, repo_id, head_sha, name, status, conclusion, url, updated_at, UNIQUE(workspace_id, kind, github_id))`.

- [ ] Step 1: Write the SQL (CHECKs: url `^(https://|ssh://|git@)`, state in (open,draft,merged,closed), kind in (run,suite), source in (branch,title,body,run)); all FKs `ON DELETE CASCADE` to workspaces/issues.
- [ ] Step 2: `node --test` `src/migrate/migrations.test.ts` still passes (file naming/ordering). Run `pnpm --filter @berry/server test`.
- [ ] Step 3: Commit `feat(server-ts): add GitHub parity tables (migration 110)`.

### Task 2: Co-authored-by trailer (pure) and delivery wiring

**Files:** Create `src/scm/commit-trailer.ts`, `src/scm/commit-trailer.test.ts`. Modify `src/agents/delivery.ts` (`DeliveryOptions.trailers?: string[]`), `src/agents/repository-run.ts` (compute trailer).

**Produces:**
```ts
export interface TrailerSettings { enabled: boolean; coAuthorTrailer: boolean }
export interface CommitAuthor { name: string | null; email: string | null }
export function coAuthorTrailer(settings: TrailerSettings | null, author: CommitAuthor | null): string | null
export function withTrailers(message: string, trailers: readonly string[]): string
```
- `coAuthorTrailer` → `Co-authored-by: <name> <email>` only when both flags true and email is a plausible address; name falls back to the email's local part; newlines/angle brackets stripped from name.
- `withTrailers` appends after one blank line, dedupes, keeps an existing trailer block.

- [ ] Step 1: Failing tests: off when master off; off when toggle off; null author → null; sanitises `Eve\n<x>`; `withTrailers('subj', [t])` = `subj\n\nCo-authored-by: …`; no duplicate on repeat.
- [ ] Step 2: Run, see FAIL (module missing). Step 3: implement. Step 4: PASS.
- [ ] Step 5: delivery.ts: `const message = withTrailers(base, options.trailers ?? [])`. Test in `delivery.test.ts`? None exists — add a case to `commit-trailer.test.ts` only; delivery change is one line.
- [ ] Step 6: repository-run.ts: before `commitAndPush`, `const trailer = await runCoAuthor(deps.sql, dispatch.runId, dispatch.workspaceId)` reading settings + requester in one query, failure → null; pass `trailers: trailer ? [trailer] : []`.
- [ ] Step 7: typecheck + tests; commit `feat(server-ts): credit the requester with a Co-authored-by trailer`.

### Task 3: PR linking rules (pure)

**Files:** Create `src/scm/pr-linking.ts`, `src/scm/pr-linking.test.ts`.

**Produces:**
```ts
export type LinkSource = 'branch' | 'title' | 'body' | 'run';
export interface LinkIntent { number: number; closeIntent: boolean; source: LinkSource }
export function findLinkIntents(input: { prefix: string; branch: string; title: string; body: string | null }): LinkIntent[]
export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed';
export function pullRequestState(pr: { state: string; merged: boolean; draft: boolean }): PullRequestState
export type CheckRollup = 'success' | 'failure' | 'pending' | 'neutral' | 'none';
export function rollupChecks(checks: ReadonlyArray<{ status: string; conclusion: string | null }>): CheckRollup
```
- [ ] Step 1: Failing tests: `feature/abc-12-x` with prefix ABC → 12 via branch; `Fixes ABC-7` in body → closeIntent; `ABC-7` without keyword → no close; other prefix `XYZ-3` ignored; `ABC-12` inside `ABC-123` does not yield 12; dedupe merges closeIntent (any true wins), source priority branch>title>body; regex-special prefix is escaped; states; rollup (any failure/cancelled/timed_out → failure, any non-completed → pending, all success/skipped → success, all neutral → neutral, empty → none).
- [ ] Steps 2–4: FAIL → implement → PASS. Step 5: commit `feat(server-ts): decide which issues a pull request names`.

### Task 4: Settings and repositories repository

**Files:** Create `src/scm/github-settings.ts`, `src/scm/github-settings.test.ts` (DB-gated).

**Produces:**
```ts
export interface GitHubSettings { enabled: boolean; showLinkedPullRequests: boolean; coAuthorTrailer: boolean; autoLinkPullRequests: boolean; updatedAt: string | null }
export type GitHubSettingsPatch = Partial<Omit<GitHubSettings, 'updatedAt'>>;
export interface WorkspaceRepository { id: string; url: string; description: string; githubRepoId: number | null; position: number; createdAt: string; updatedAt: string }
export const DEFAULT_GITHUB_SETTINGS: GitHubSettings;
export function normaliseRepositoryUrl(url: string): string | null; // https/ssh/git@ only, trims, strips trailing slash
export class GitHubSettingsRepository {
  constructor(sql: Sql)
  get(workspaceId: string, tx?: Queryable): Promise<GitHubSettings>
  update(workspaceId: string, patch: GitHubSettingsPatch, userId: string, tx: Queryable): Promise<GitHubSettings> // + outbox github.settings.updated
  listRepositories(workspaceId: string, tx?: Queryable): Promise<WorkspaceRepository[]>
  addRepositories(workspaceId: string, items: Array<{ url: string; description?: string; githubRepoId?: number | null }>, userId: string, tx: Queryable): Promise<WorkspaceRepository[]> // ON CONFLICT DO NOTHING; + outbox
  updateRepository(workspaceId: string, id: string, patch: { url?: string; description?: string }, tx: Queryable): Promise<WorkspaceRepository | null>
  removeRepository(workspaceId: string, id: string, tx: Queryable): Promise<boolean>
}
export async function writeWorkspaceEvent(tx: Queryable, input: { workspaceId: string; boardId?: string | null; issueId?: string | null; type: string; aggregateType: string; aggregateId: string; payload: unknown }): Promise<void>
```
- [ ] Step 1: offline tests for `normaliseRepositoryUrl` (https ok, `git@github.com:a/b.git` ok, `ssh://` ok, `http://` refused, `ftp` refused, whitespace trimmed). DB tests: defaults without a row; update persists and writes one outbox row; repositories scoped to workspace (W2 never listed under W1); cross-workspace `updateRepository` returns null.
- [ ] Steps 2–4: FAIL → implement → PASS (DB part skips offline). Commit `feat(server-ts): store GitHub settings and workspace repositories`.

### Task 5: Pull-request store

**Files:** Create `src/scm/pull-requests.ts`, `src/scm/pull-requests.test.ts` (DB-gated).

**Produces:**
```ts
export interface PullRequestInput { githubId: number; repoId: number; repoFullName: string; number: number; title: string; url: string; state: PullRequestState; draft: boolean; headRef: string; headSha: string | null; authorLogin: string | null; mergedAt: string | null; closedAt: string | null; githubUpdatedAt: string | null; body: string | null }
export interface CheckInput { kind: 'run' | 'suite'; githubId: number; repoId: number; headSha: string; name: string; status: string; conclusion: string | null; url: string | null }
export interface LinkedPullRequest { id: string; number: number; title: string; url: string; repoFullName: string; state: PullRequestState; draft: boolean; headRef: string; authorLogin: string | null; mergedAt: string | null; closeIntent: boolean; checks: { rollup: CheckRollup; total: number; passed: number; failed: number; pending: number; items: Array<{ kind: 'run'|'suite'; name: string; status: string; conclusion: string | null; url: string | null }> }; updatedAt: string }
export class PullRequestStore {
  constructor(deps: { sql: Sql; issues: Pick<IssueRepository, 'update'>; systemActorId?: (workspaceId: string) => Promise<string | null> })
  upsertPullRequest(workspaceId: string, pr: PullRequestInput): Promise<{ id: string; stale: boolean }>
  linkIssues(workspaceId: string, pullRequestId: string, pr: PullRequestInput, options: { autoLink: boolean }): Promise<string[]> // issue ids
  closeLinkedIssues(workspaceId: string, pullRequestId: string, actorId: string | null): Promise<string[]>
  upsertCheck(workspaceId: string, check: CheckInput): Promise<string[]> // issue ids whose PRs share the head sha
  listForIssue(workspaceId: string, issueRef: string): Promise<LinkedPullRequest[] | null> // null = issue not in workspace
  publishUpdated(workspaceId: string, issueIds: string[], pullRequestId: string | null): Promise<void>
}
```
- [ ] Step 1: DB tests (skip offline): upsert is idempotent and ignores an older `github_updated_at`; linking by key within workspace only (a W2 issue with the same number is never linked from W1); run-branch linking works with auto-link off; close on merge moves to done and writes `issue.completed`; `listForIssue` for a foreign issue returns null; check rollup is reflected.
- [ ] Steps 2–4. Commit `feat(server-ts): record pull requests and checks against issues`.

### Task 6: Webhook routing (installation → workspace) and App webhook secret

**Files:** Create `src/scm/github-events.ts`, `src/scm/github-events.test.ts` (offline, fakes). Modify `src/scm/inbound.ts` (delegate), `src/mounts/webhooks.ts` (`secrets` resolver), `src/integrations/github-app.ts` (`webhookSecret()`, manifest events), add `src/mounts/webhooks.test.ts`.

**Produces:**
```ts
export interface GitHubEventDeps {
  workspaceForInstallation(installationId: number): Promise<string | null>;
  settings: Pick<GitHubSettingsRepository, 'get'>;
  pullRequests: Pick<PullRequestStore, 'upsertPullRequest' | 'linkIssues' | 'closeLinkedIssues' | 'upsertCheck' | 'publishUpdated'>;
  removeInstallation(installationId: number): Promise<string | null>;
  publishConnection(workspaceId: string): Promise<void>;
}
export class GitHubEvents { constructor(deps: GitHubEventDeps); handles(event: string): boolean; apply(event: string, payload: Record<string, unknown>): Promise<InboundResult> }
export function parsePullRequest(payload: Record<string, unknown>): PullRequestInput | null
export function parseCheck(event: 'check_run' | 'check_suite', payload: Record<string, unknown>): CheckInput | null
```
ScmInbound: constructor accepts optional `github?: { handles(e): boolean; apply(e,p): Promise<InboundResult> }`; for `pull_request` it runs the existing review update **and** the delegate, reporting applied if either applied; `check_run`, `check_suite`, `installation` go to the delegate.
WebhookOptions gains `secrets?: () => Promise<string[]>`; the route accepts a signature matching env secret or any resolved secret; 503 only when neither exists.
GitHubAppRepository gains `webhookSecret(): Promise<string | null>` (opens sealed). Manifest: `hook_attributes.url` = `/api/v1/webhooks/github`, `active: true`, `default_events` add `check_run`, `check_suite`, `pull_request_review`, `default_permissions.checks = 'read'`.

- [ ] Step 1: Failing tests: unknown installation → ignored; master off → ignored, no store call; opened PR → upsert + link(autoLink flag passed) + publish; merged PR → closeLinkedIssues called; check_run → upsertCheck + publish; `installation` `deleted` → removeInstallation + publishConnection; parsePullRequest maps draft/merged; webhook mount accepts a body signed with the resolved App secret and rejects a wrong one (offline, fake inbound/deliveries); manifest test updated in `github-app.test.ts` (existing assertions kept, new ones added).
- [ ] Steps 2–4. Commit `feat(server-ts): route GitHub webhooks to the installing workspace`.

### Task 7: Repository picker source

**Files:** Modify `src/integrations/github.ts`, `src/integrations/github.test.ts`.

**Produces:** `RepositoryChoice.archived?: boolean` and `htmlUrl?: string`, `sshUrl?: string`, plus `owner: string`; `listRepositories` keeps its filter behaviour and fills these. `listRepositories({ maxPages })` used with maxPages 10 by the picker.
- [ ] Step 1: failing test: installation listing maps `archived`, `html_url`, `ssh_url`, `owner.login`. Steps 2–4. Commit `feat(server-ts): report archived repositories to the picker`.

### Task 8: `/api/v1/github` mount

**Files:** Create `src/mounts/github.ts`, `src/mounts/github.test.ts` (offline validation tests + DB-gated flow). Modify `src/mounts/cross-tenant-leakage.test.ts`.

**Routes** (all under `mountWorkspaceScope`; writes via `scoped.mutate('settings.write', …)`):
- `GET /:ws/settings` → `{ settings, canManage, connection: { appConfigured, installed, accountLogin, accountType, installedBy: {id,name}|null, installedAt } }`
- `PATCH /:ws/settings` body (zod strict partial booleans) → `{ settings }`
- `DELETE /:ws/installation` → 204, writes `github.connection.updated`
- `GET /:ws/repositories` → `{ repositories }`; `POST /:ws/repositories` `{ repositories: [{url, description?, githubRepoId?}] (1..50) }` → `{ repositories: added }`; `PATCH /:ws/repositories/:id` `{url?, description?}`; `DELETE /:ws/repositories/:id`
- `GET /:ws/github-repositories?account=&q=&cursor=&limit=` → `{ accounts, repositories: [{id, fullName, owner, name, description, private, archived, url, alreadyAdded}], nextCursor }` (App token, maxPages 10; same 409/412/502 mapping as the integrations picker). BLOCKED-LIVE for the GitHub call; offline test with a fake client factory.
- `GET /:ws/issues/:issueRef/pull-requests` → `{ visible, pullRequests }` (`visible` = enabled && showLinkedPullRequests; 404 for an issue outside the workspace).
- [ ] Step 1: tests: member PATCH → 403 `FORBIDDEN`; invalid body → 400; unknown field → 400; viewer GET works with `canManage:false`; leakage: U1 GET/PATCH W2 settings → 404 byte-identical to random uuid and W2 row unchanged; W2 repository never listed under W1; W2 issue PRs → 404.
- [ ] Steps 2–4. Commit `feat(server-ts): serve GitHub settings, repositories and linked PRs`.

### Task 9: Composition, topics, docs

**Files:** Modify `src/index.ts`, `src/realtime/replay.ts`, `SCOPE.md`; add a replay test assertion.
- [ ] Step 1: failing test in `src/realtime/replay.test.ts`: WORKSPACE_TOPICS includes the four `github.*` topics; BOARD_TOPICS includes `github.pull_request.updated`.
- [ ] Step 2–4: add topics; wire `GitHubSettingsRepository`, `PullRequestStore` (with `IssueRepository`), `GitHubEvents` into `ScmInbound` and `webhookMounts({ secrets: () => githubApp?.webhookSecret() })`; register `githubMounts`; add `/api/v1/github` to SCOPE.md.
- [ ] Step 5: typecheck + tests. Commit `feat(server-ts): wire GitHub parity into the server`.

### Task 10: Frontend client

**Files:** Create `frontend/lib/github.ts` (Zod v3 schemas + calls mirroring Task 8; `describeGitHubFailure(error)`).
- [ ] lint + commit `feat(frontend): add the GitHub settings client`.

### Task 11: GitHub settings panel

**Files:** Create `components/common/settings/github-integration-settings.tsx`; modify `components/common/settings/integrations.tsx` (render panel above the directory; on `status=installed` for github, route to `/{org}/settings/repositories?import=github`).
- Master switch, connection block (account, who connected, when, Connect/Disconnect via existing `startGitHubInstall` and new `disconnectGitHub`), three toggles with Berry's own wording; every control disabled with a read-only note when `canManage` is false; refetch on `github.settings.updated` / `github.connection.updated`.
- [ ] lint + build; commit `feat(frontend): manage GitHub from integration settings`.

### Task 12: Repositories tab and import picker

**Files:** Create `app/[orgId]/settings/repositories/page.tsx`, `components/common/settings/repositories-settings.tsx`, `components/common/settings/github-import-picker.tsx`; modify `nav-settings.tsx`.
- List of URL + description rows, autosave on blur (debounced 600 ms) with per-row saved/error state; add row; remove row; read-only for non-admins.
- Picker dialog: account select, search input (debounced), load more (cursor), multi-select checkboxes, archived and already-added rows disabled with a reason; Import adds the chosen ones. Opens automatically when `?import=github` is present.
- [ ] lint + build; commit `feat(frontend): add the Repositories settings tab`.

### Task 13: Linked pull requests in the issue sidebar

**Files:** Create `components/common/issues/details/issue-linked-pull-requests.tsx`; modify `issue-properties-panel.tsx` (one import + one element).
- Self-contained: `IssueLinkedPullRequests({ issueRef })`; reads workspace from session store; renders nothing when `visible` is false or the list is empty; each row shows state, number, title, repo, checks rollup with counts; refetches on `github.pull_request.updated` whose `issueId` matches or whose payload lists the issue.
- [ ] lint + build; commit `feat(frontend): show linked pull requests on a task`.

### Task 14: Verification

- [ ] `pnpm typecheck:server`, `pnpm test:server`, `pnpm --filter berry-frontend lint`, `pnpm --filter berry-frontend build:check` (writes `.next-verify`); record verbatim output.
