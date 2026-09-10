# Multica functional parity on an AgentCore Runtime control plane

- **Date:** 2026-09-10
- **Status:** Draft for review
- **Deadline:** 3 days (2026-09-13)
- **Supersedes, on approval:** the "loop stays in process" parts of ADR-0008, ADR-0012, ADR-0013 (new ADR-0014)

## 1. Goal

Berry reaches functional parity with multica (web app + server) — every
product capability multica's web users have — while **Bedrock, reached only
from inside AgentCore Runtime, is the single LLM source**.

**Clean-room rule.** Multica's license forbids offering its code as a hosted
service and requires Multica branding on any derived UI. We reimplement
*behaviour* from its public docs and our feature inventory. No multica source,
schema, copy, icons, or UI is copied or translated. Berry's own design system
and naming are used throughout.

**Out of scope.** Berry is **web only**: no Electron desktop app, no mobile app.
The `multica` CLI, the local daemon and the 26 third-party CLI agent adapters are
also excluded, as is **every integration** (section 7). Their *product* surfaces (runtimes, runtime profiles, usage) are
replicated on AgentCore.

## 2. Architecture: control plane + managed runtime (workstream A)

```
Berry server (control plane)                     AgentCore Runtime (container)
 task queue (runs) ── dispatcher ─InvokeAgentRuntime──► /invocations
                                   (task envelope)       Strands agent loop
 ledger / run_events ◄──────── response event stream ─── ├─ Bedrock (only model)
                                                         ├─ shell/file tools (local)
 Berry tool API  ◄──── HTTPS, task-scoped token ──────── └─ Berry tools (issues, comments…)
 cancel ─────────── StopRuntimeSession ────────────────►
```

### 2.1 What moves

- The Strands loop (`agents/executor.ts`, `agents/runtime/*`, tools) runs in the
  container image, `server-ts/sandbox/agentcore/`. The image copies the shared
  `src/agents/runtime` modules and runs them under `--experimental-strip-types`
  like the server does, so there is one source for the loop.
- Shell and file tools run **locally** in the container. This removes today's
  one `InvokeAgentRuntimeCommand` round trip per command.
- The Berry server has **no model client**. `bedrockModel()` is only imported by
  container code. `llm/completion.ts` callers (planner, triage, review gate, chat
  titles, editor assist, agent builder) become short **completion tasks** on the
  same runtime, with a `kind: 'completion'` envelope.
- A repository check (`scripts/`) fails CI if `server-ts/src` outside
  `agents/runtime/` imports a Bedrock or any model SDK, or if any provider SDK
  (openai, anthropic, etc.) appears in any `package.json`.

### 2.2 The task envelope and lifecycle stream

The dispatcher claims a run exactly as today (lease, heartbeat, sweep are
unchanged), then calls `InvokeAgentRuntime` with the `(agent, issue)` session
id (section 2.2a) as `runtimeSessionId` and a JSON envelope:

`{ kind: 'agent' | 'completion', runId, sessionKey, agent: { instructions, model, skills[], mcpServers[], permissions }, task: { issue, comments, dependencies, project resources, priorWork }, transcript, repo?, berry: { apiUrl, token } }`

Completion tasks use a fresh session per run.

The container answers with an SSE stream. Each event is one line of the
lifecycle contract, modelled on the multica task lifecycle but in Berry's own
event vocabulary:

| Event | Berry writes |
|---|---|
| `task.started` | ledger `start` (run → running) |
| `task.message` (text, tool_use, tool_result, command output) | `run_events` via ledger, same types as today |
| `task.usage` (input/output/cache tokens, model) | `task_usage` row + `runs` totals |
| `task.completed` (result, artifacts, PR ref) | ledger `complete`, result comment, delivery |
| `task.failed` (code, message, retryable) | ledger `fail` |

The ledger stays the only writer of run state. A stream that ends without
`completed` or `failed` is recorded as `RUNTIME_STREAM_ENDED`, retryable.
Cancel still flows through the heartbeat: when it sees `cancelled`, it aborts
the stream and calls `StopRuntimeSession`.

### 2.2a Persistent sessions (multica's resumable agent sessions)

- **Session identity is `(agent, issue)`, not the run.**
  `runtimeSessionId = "berry-" + sha256(agentId + ":" + issueId)`, padded to 33
  or more characters. Chat tasks use `(agent, chatSessionId)`. Follow-up runs on
  the same issue reach the same warm microVM while it is alive: same process,
  same repo checkout, same in-memory Strands conversation.
- **Warm case.** The container keeps a map from session to agent state. A new
  envelope for a live session appends the new prompt to the existing
  conversation, and does not rebuild it.
- **Cold case.** The microVM was reaped (idle timeout or `maxLifetime`). The
  envelope always carries `transcript`, the prior conversation for this
  `(agent, issue)` rebuilt from `run_events`, trimmed by the
  `SlidingWindowConversationManager` budget. The container restores the Strands
  messages from it. AgentCore Memory recall (`priorWork`) stays as the summary
  layer. The same envelope therefore works warm or cold, and only speed differs.
- **Workspace.** The repo stays checked out while the session is warm. On a cold
  start the container re-clones shallowly and checks out the issue's branch.
  Every run ends with its work committed to the branch or stored as S3
  artifacts, so a reaped VM loses no delivered work.
- **Lifecycle config.** Runtime `idleRuntimeSessionTimeout` defaults to 3600 s
  (configurable per runtime profile, maximum 28800) and `maxLifetime` to 28800 s.
  While the loop is working after the invoke stream has closed, `/ping` returns
  `HealthyBusy`.
- **Concurrency.** `issues.active_run_id` already allows one active run per
  issue, so two runs never share a session concurrently. A chat session gets the
  same guard with `chat_sessions.active_run_id`.
- **Cancel.** `StopRuntimeSession` now ends a session that later runs may have
  reused. This is acceptable, because the cold path restores the conversation.
- **Past 8 hours.** A task that outlives `maxLifetime` loses its lease and is
  re-queued as retryable. The retry resumes cold from the transcript.

### 2.3 Berry tools (agent → Berry)

Multica agents drive the product through its CLI. Berry agents do it through a
**Berry tool API**: `/api/v1/agent-tools/*`, authenticated by a task-scoped
token (`task_tokens` table: hash, run id, scopes, expiry equal to the lease
horizon, revoked on terminal state). The tools are: read issue, list or create
sub-issues, comment, set status, attach a file, read project resources, and
mention an agent. They are exposed to the loop as Strands tools.
**Requirement:** `BERRY_PUBLIC_URL` must be reachable from AgentCore. In local
development this means a tunnel.

### 2.4 Runtimes (multica's runtimes and runtime profiles)

- `agent_runtimes` table: one row per AgentCore Runtime ARN and qualifier the
  workspace may use. The seeded default is the platform runtime, and an owner
  can register their own ARN. Columns: name, arn, qualifier, region, status,
  last_health_at, concurrency limit, visibility (private or workspace).
- `runtime_profiles`: env vars (sealed with `integrations/sealing.ts`), model
  default, timeout, max concurrency. They are passed in the envelope.
- Agents bind to a runtime (nullable means the workspace default). The dispatcher
  respects each runtime's concurrency.
- UI: Runtimes list and detail with health, activity and usage by day, agent and
  hour. The health check is the existing `health()` no-op.
- Bedrock-capable coding CLIs in the image are an **optional stretch goal**.
  Claude Code with `CLAUDE_CODE_USE_BEDROCK=1` would be exposed as an agent
  "engine" choice, and it still spends Bedrock tokens only. It ships only if A is
  done by day 1 noon.

### 2.5 Local development

The `http`/docker driver runs the **same image** locally, with the same
`/invocations` contract. Tests use the existing `ScriptedModel` inside the
container module and an in-process fake driver on the server side.

## 3a. Authentication: Better Auth with GitHub only (workstream J)

- Replace the login code in `server-ts/src/auth/` and the auth, me and account
  mounts with **Better Auth**.
- **GitHub is the only sign-in method.** No Google, no email and password, no
  magic link. The frontend has a single "Continue with GitHub" page. The sign-up
  and password forms are removed.
- **Existing users keep their ids.** Better Auth maps onto the existing `users`
  table, and a GitHub account links to an existing user by verified email.
  Existing sessions may be invalidated at cutover.
- **Tokens keep working.** Personal API tokens and task-scoped tokens stay valid
  as bearer auth alongside Better Auth sessions. The SSE stream still
  authenticates with the session cookie.
- **Nothing else about access changes.** Workspace membership, invitations and
  the cross-tenant guards stay as they are.
- **Secrets stay on the server.** The GitHub OAuth client id and secret are
  server config and never `NEXT_PUBLIC_`.
- **Sign-in is separate from repository access.** The GitHub App used for
  repositories is kept apart from the OAuth app used for sign-in.
- Migrations use block 150–159. J merges **first**, since every other
  workstream runs behind login.

## 3. Work tracking (workstream B)

This workstream reuses the unused tables where they exist (`issue_reactions`,
`comment_reactions`, `user_pins`, `issue_property_definitions`,
`quick_action_definitions`, `issue_subscribers`). Migrations start at `053`.

- **Custom properties.** Types: text, number, select, multi-select, date,
  checkbox, url, person, multi-person. Workspace CRUD, per-issue values, and
  filtering and grouping in views.
- **Issue metadata.** Free key/value pairs for agents and integrations.
- **Reactions** on issues and comments. **Comment resolve and unresolve.**
  **Comment edit and delete**, which have a backend but no UI today.
- **Subscribers.** Automatic sources are creator, assignee, commenter and
  mentioned. Manual subscribe and unsubscribe, including for a subtree. These
  feed the inbox.
- **Sub-issues.** Parent and children, child progress, create a sub-issue from a
  comment, and a **stage** ordinal as an ordered barrier among siblings.
  Auto-dispatch does not start stage N+1 until stage N is done. This fits the
  existing `readyForAgent`.
- **Custom statuses by category.** The categories are backlog, todo,
  in_progress, in_review, blocked, done and cancelled. Statuses can be created,
  renamed, reordered and archived. A custom `in_review` status acts as a review
  gate.
- **Views.** Board, list, **table** (virtualised, column picker, inline edit),
  **swimlane** and **gantt**. Saved views with create, update and delete (today
  they are read-only). Per-user view preferences. Server-side grouped and faceted
  queries.
- **Timeline.** Activity log per issue, from `outbox_events` or an
  `activity_log` projection. **Pins** in the sidebar. **Quick actions**:
  workspace prompt templates, run on an issue as an agent task.
- **Batch update and delete**, **move and reorder**, **quick create**, and
  **assignee frequency**.
- **Share links.** Workspace join links with create, list and revoke, plus a
  public lookup and a join page.
- **No Google OAuth.** GitHub is the only OAuth provider (see the auth
  decision).

## 4. Usage and cost (workstream C)

- `task_usage` holds one row per `task.usage` event. `task_usage_hourly` is a
  rollup maintained on write (upsert).
- Cost comes from the price table `agents/catalog.ts` already fetches. It is
  computed on write, which fixes `costMicros` always being null.
- Endpoints: issue usage, agent usage, runtime usage (daily, by agent, by hour),
  workspace dashboard (daily usage, failures daily and by agent, working agents,
  30-day activity, run counts, task snapshot).
- UI: a **Usage** page and a **Dashboard** page, plus usage panels on issue,
  agent and runtime.

## 5. Agent product layer (workstream D)

- **Skills catalogue.** `skills` (name, description, content), `skill_files`
  (path, content), labels. Import from a GitHub URL or a zip, refresh an import,
  and search. Attach to an agent with an enable toggle. The envelope carries the
  enabled skills, and the container writes them to the workspace (Claude
  Skills-style directory).
- **MCP servers.** Per agent and per workspace: url, transport, headers sealed,
  enabled. They are passed in the envelope and connected by the Strands loop's
  MCP client inside the container. Tool traffic may be routed through the
  **AgentCore Gateway** when `AWS_AGENTCORE_GATEWAY_URL` is set. That turns on
  the dormant Gateway code and puts Cedar Policy in reach.
- **Agent CRUD completion.** Create, archive, restore, cancel all tasks,
  per-agent task list, env vars (sealed), labels, avatar upload, copy.
- **AI agent builder.** A builder session is a chat with a completion task that
  drafts `{name, instructions, skills, mcp, model}`, previewed and then applied.
  Tables: `agent_builder_sessions`, `agent_builder_drafts`.
- **Onboarding agent.** A seeded guide agent used by the onboarding chat.
- **Squads.** Agents and people with roles and a leader. Assigning an issue to a
  squad routes it to the leader. The leader's run decides delegation, creating
  sub-issues assigned to members through the Berry tools. It re-triggers on
  member completion. There is a squad briefing in the envelope.
- **Mentions trigger runs.** @agent in a comment queues a task. A plain reply on
  an agent-assigned issue routes to the assignee or squad leader. There is a
  trigger preview before sending.
- **Chat.** Sessions with create, rename, pin, archive, delete and read, and
  pinned agents. Messages queue **agent tasks**, so chat gets tools and runtime
  (today it is words only). Queued and pending tasks can be cancelled and
  prioritised. Titles are generated automatically. There are draft restore,
  history and thread views, and quick-action suggestions.
- **Per-agent access scopes.** These control which members may assign or
  mention which agents, and extend `PUT /permissions`.

## 6. Autopilots (workstream E)

- `autopilots` (name, agent or squad, prompt template, execution mode: create an
  issue per run or run against a fixed issue, paused), `autopilot_triggers`
  (cron with timezone, or webhook with a token and signing secret and event
  filters), `autopilot_runs`, `webhook_deliveries` (payload, status, replay),
  collaborators and subscribers, quota periods, rule versions.
- The scheduler is a Postgres-leased tick in the dispatcher process
  (`sys_cron_executions`, unique on trigger and slot) so exactly one server fires
  each slot. There is cron preview, manual trigger and token rotation.
- Public ingress: `POST /api/webhooks/autopilots/:token` with HMAC verification.
- UI: Autopilots list and detail with triggers, runs, deliveries and replay.

## 7. Integrations: GitHub only (workstream K)

**GitHub stays and reaches parity.** It builds on the existing GitHub App in
`server-ts/src/integrations/` and `server-ts/src/scm/`. Migrations use block
110–119.

- **Integration settings.** A master on/off switch for all GitHub features in
  the workspace. Connect and disconnect the GitHub App, with who connected it.
  Three feature toggles:
  1. Show linked pull requests in the issue sidebar.
  2. Add a `Co-authored-by` trailer to agent commits.
  3. Auto-link a pull request to an issue by the issue key in the branch name,
     title or a closing keyword.

  Only admins can manage these; everyone else sees them read-only.
- **Repositories settings tab.**
  - A workspace list of repository URLs (https or ssh) with descriptions.
    Changes auto-save.
  - A GitHub import picker: choose the account, search, load more, multi-select,
    with archived and already-added repositories disabled. After the app is
    installed, the picker opens automatically.
- **Pull requests on issues.** A PR is linked to an issue from webhook events.
  Its state (open, draft, merged, closed) and its check runs and check suites
  show in the issue sidebar. A merged PR with close intent moves the issue to
  done. These publish realtime events.
- **Agent commits.** The `Co-authored-by` trailer is applied in the delivery
  path when the toggle is on.

**Still out of scope:** other SCM providers (GitLab, Gitea, Forgejo), chat
channels (Slack, Telegram, Lark, DingTalk, WeCom) and Composio. GitHub sign-in
is workstream J, and it is kept separate from this GitHub App integration.

## 8. Plugins and public API (workstream G)

- **Public API v1.** `/v1/context`, `/v1/issues/:ref` (GET, PATCH),
  `/v1/issues/:ref/comments` and `/v1/storage/*` (scoped key/value), all
  authenticated by personal access tokens or plugin tokens with scopes such as
  `issues:read|write` and `comments:read|write`.
- **Plugins.** Install a plugin package (manifest plus files, remote URL or
  upload) with a preview. Config, enable, disable, uninstall, secrets (sealed),
  storage, invocations log. **Hooks** are event-triggered and scheduled calls to
  a plugin endpoint. **Surfaces** are an embedded iframe UI launched with a
  signed token. Remote MCP from a plugin is surfaced to agents with an admin
  tool-approval list. There is a minimal TypeScript plugin SDK package in
  `packages/plugin-sdk`.

## 9. Locales (workstream H)

- **Billing and payments are out of scope.** That means no Stripe, no seats, no
  credits, no entitlements and no billing page.
- **Locales.** en, zh-Hans, ja and ko via `next-intl` message catalogues. There
  is a locale preference in settings.

## 10. Frontend (workstream I, runs alongside every workstream)

- Every new area gets real pages under `app/[orgId]/`: runtimes, usage,
  dashboard, skills, agents/new (manual and AI), squads, autopilots, chat (linked
  from the rail), members detail, invitations and join, billing, and the settings
  tabs (members, labels, statuses, properties, quick actions, repositories,
  integrations, MCP, plugins, chat, keyboard shortcuts, billing, delete
  workspace).
- **Fixture removal.** No page in the shipped rail imports `frontend/data/*`.
  Surfaces with no backend in either product (initiatives, cycles, documents,
  and the 14 placeholder settings) are hidden from navigation, not faked.
- Realtime: new event families are published through `outbox_events` and the
  existing SSE hub. No WebSocket is added.
- Global search is extended to projects, skills, agents and chat.

## 11. Cross-cutting rules

- **Isolation.** Every new table carries `workspace_id`. Every mount goes
  through the existing workspace guard and is added to the cross-tenant leakage
  property tests.
- **Secrets.** Stored only through `sealing.ts`. Never sent to the browser,
  never logged. Only the envelope carries decrypted env to the runtime, over the
  AWS SDK.
- **Server code style.** No emitted TS syntax. Zod v4 on the server, Zod v3 on
  the frontend.
- **Tests.** Each workstream adds `node --test` coverage for repositories and
  mounts. The runtime contract has a contract test that runs the container module
  against `ScriptedModel`. The frontend passes lint and `next build`.

## 12. Delivery plan

| Day | Critical path | Parallel tracks |
|---|---|---|
| 1 | A: envelope, lifecycle stream, container loop, task tokens, runtimes, ADR-0014, no-model-in-server check | B (backend + UI), C (backend + UI) |
| 2 | D: skills, MCP/Gateway, agent CRUD, builder, squads, mentions, chat on tasks | E autopilots, G public API |
| 3 | Live AgentCore end-to-end run, security review | G plugins, H locales, I fixture removal, fixes |

Each workstream runs in its own git worktree with its own implementation plan.
Migrations are numbered in blocks per workstream to avoid collisions: A 053–059,
B 060–079, C 080–084, D 085–099, E 100–109, G 130–139, H 140–149.

**Risks.**
- A slipping delays D and E.
- Every image change needs a redeploy.
- Live verification needs AWS credentials and a reachable `BERRY_PUBLIC_URL`.

## 13. Acceptance

- An issue assigned to an agent runs end to end on the live AgentCore Runtime
  with the loop inside the container, and the Berry server process makes zero
  Bedrock calls (the CI check plus a CloudTrail spot check).
- Every row of the feature inventory (sections 3–10) maps to a shipped endpoint
  and page, or to an entry in a "verified-offline-only" list with the reason.
- `node --test` passes, frontend lint and `next build` pass, and the
  cross-tenant tests cover every new mount.
