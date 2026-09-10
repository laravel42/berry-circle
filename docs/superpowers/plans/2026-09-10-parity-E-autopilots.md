# Parity E — Autopilots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workspace can define autopilots: an agent (or squad) plus a prompt template that fires on a cron schedule, on a signed webhook, or by hand. Each firing opens a task or reuses a fixed one, and queues an agent task through `enqueueTask(source 'autopilot')`. Triggers, run history and webhook deliveries (with replay) are visible in the web UI.

**Architecture:** Seven tables live in migration `100_autopilots.up.sql`. A new domain folder, `server-ts/src/autopilots/`, holds pure modules (cron, template, signing), a repository, and `fireAutopilot`, the single path every trigger source goes through. A Postgres-claimed scheduler, `server-ts/src/runs/scheduler.ts`, runs in the dispatcher process beside `runs/dispatcher.ts`. It claims each cron slot exactly once via `sys_cron_executions UNIQUE (trigger_id, slot)`. Two mounts serve the product: `/api/v1/autopilots` (session, workspace-guarded) and `/api/webhooks/autopilots/:token` (public, HMAC-SHA256 verified with the existing `verifySignature`). Realtime uses `outbox_events` topics `autopilot.*`, which are added to the workspace SSE replay list. The frontend adds `lib/autopilots.ts`, two hooks, a list page and a detail page (triggers, runs, deliveries), and one rail entry.

**Tech Stack:** Server: Node 22 `--experimental-strip-types`, Hono, postgres.js, Zod v4 (`zod` ^4.2.1), `node --test`. New dependency: **`croner` 10.0.1** (MIT, zero dependencies), for cron parsing and timezone-aware next-run computation. Frontend: Next.js 15 App Router, React 19, Zod v3 (`^3.24.2`), zustand, shadcn/ui primitives in `components/ui`.

**Spec:** `docs/superpowers/specs/2026-09-10-multica-parity-design.md` §6 (Autopilots). §11 (isolation, secrets, tests) and §13 (acceptance) are the cross-cutting gates. Read §6 and §11 before starting.

## Global Constraints

- Scope is spec §6 only: autopilots, autopilot triggers (cron with timezone, or webhook with token + signing secret + event filters), autopilot runs, webhook deliveries (payload, status, replay), collaborators and subscribers, quota periods, rule versions, the leased scheduler (`sys_cron_executions`, unique on trigger and slot), cron preview, manual trigger, token rotation, public ingress `POST /api/webhooks/autopilots/:token` with HMAC, and the list and detail UI.
- **Do not resurrect the retired rules engine** (migrations 021 and 036). Do not create, reference or reintroduce the `automations*` tables, step graphs, `/api/v1/workflows` or `/api/v1/hooks`. An autopilot is one prompt handed to one agent, not a workflow definition.
- Migration block for E is **100–109**. This plan uses only `100`. Migrations are forward-only: `.up.sql` only, and never edit a migration once it is applied.
- **Shared contract, consumed and never redefined.** Workstream A exports `enqueueTask(sql, input)` from `server-ts/src/runs/queue.ts`, with `input: { workspaceId; agentId; issueId?; kind: 'agent' | 'completion'; source: 'assignment' | 'mention' | 'chat' | 'autopilot' | 'squad' | 'quick_action' | 'builder' | 'completion'; prompt?; chatSessionId?; autopilotRunId?; priority? }`, returning `Promise<{ runId: string }>`. E always calls it with `kind: 'agent'` and `source: 'autopilot'`. E's domain code types that dependency structurally as `EnqueueTask` (a subset signature, Task 5), so it compiles and tests without A merged. Only the composition-root wiring (Task 9) imports `./runs/queue.ts`, and Task 9 is blocked until A is merged.
- Squads belong to workstream D. E only reads a squad's leader through `resolveSquadLeader` (Task 9) and treats an absent `squads` table or leader column as "no leader": the run fails with `SQUAD_UNAVAILABLE`, and the server does not crash.
- Server style: no emitted TS syntax (no enums, namespaces or parameter properties), relative imports with `.ts` extensions, `import type` for types, 3-space indent, single quotes, and no `any` or `!` (narrow instead). Map errors once at the HTTP boundary into the Berry error envelope. Validation failures are `422 VALIDATION_FAILED` via `assertValid([fieldError(path, 'invalid_value', message)])`.
- Server tests: `node --test`, co-located `*.test.ts`. DB tests are gated by `describe(..., { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' })`, so `pnpm test:server` stays green offline.
- Isolation (§11): every new table has `workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE`. Every session route resolves the workspace through `resolveScoped` (`mounts/shared.ts`), and an autopilot in another workspace answers the same `404 NOT_FOUND "Autopilot not found."` as a random id. Cross-tenant tests cover the new mount.
- Secrets (§11): the webhook signing secret is sealed with `integrations/sealing.ts` (`Sealer.seal`) and opened only to verify a delivery. The webhook token is stored as a SHA-256 hash, plus a 4-character hint. Token and secret are returned only once, in the create or rotate response, with `Cache-Control: no-store`. They are never logged, never returned by a GET, and never passed through the idempotency store: trigger create and rotate are deliberately not wrapped in `idempotent()`.
- Realtime: outbox topics `autopilot.created`, `autopilot.updated`, `autopilot.archived`, `autopilot.run.created` and `autopilot.delivery.received`, published via `outbox_events` and the SSE hub. No WebSocket.
- Frontend: Prettier 3-space, single quotes, semicolons, `es5` trailing commas, width 100. `prettier/prettier` is an ESLint error, and some snippets below run past width 100. Before each frontend lint step, run `cd /Users/secret/Code/berry-circle/frontend && pnpm exec prettier --write <the files this task created or modified>`. Use Zod v3 and the `@/*` alias, and send all traffic through `lib/api.ts` (`apiFetch`). Creating POSTs send `Idempotency-Key: newIdempotencyKey()`. No `text-*` font-size utilities. Gates: `pnpm lint:frontend` and `cd frontend && pnpm build:check`.
- Clean-room: never copy multica source, schema text, copy or UI. All names and strings here are Berry's own. Web only. No new integrations.
- Commits: `type(scope): imperative summary`, with scope `server-ts` or `frontend`. End each commit with the `Co-Authored-By` line the session gives. Do not push.

---

## File Structure

**Server (`server-ts/`)**

| File | Responsibility |
|---|---|
| `migrations/100_autopilots.up.sql` (create) | `autopilots`, `autopilot_versions`, `autopilot_members`, `autopilot_triggers`, `autopilot_runs`, `webhook_deliveries`, `sys_cron_executions` |
| `package.json` (modify) | add `"croner": "^10.0.1"` |
| `src/autopilots/migration.test.ts` (create) | offline shape test for migration 100 |
| `src/autopilots/cron.ts` (+ `.test.ts`) | `assertSchedule`, `nextFireTimes`, `nextFireAfter`, `InvalidSchedule` |
| `src/autopilots/template.ts` (+ `.test.ts`) | `renderPrompt` — `{{path}}` substitution, no code evaluation |
| `src/autopilots/signing.ts` (+ `.test.ts`) | token/secret generation, token hashing, `signBody`, header names; re-exports `verifySignature` |
| `src/autopilots/events.ts` | `AUTOPILOT_TOPICS`, `writeAutopilotEvent` (outbox envelope) |
| `src/autopilots/repository.ts` (+ `.test.ts`) | `AutopilotRepository`: CRUD, versions, members, triggers, runs/deliveries reads, token lookup, delivery records |
| `src/autopilots/test-fixture.ts` | shared DB seed/cleanup for the autopilot test files (not a test itself) |
| `src/autopilots/fire.ts` (+ `.test.ts`) | `fireAutopilot` — pause/quota gate, target resolution, `enqueue`, run record, event |
| `src/autopilots/squads.ts` (+ `.test.ts`) | `resolveSquadLeader` — reads D's squad leader if present |
| `src/runs/scheduler.ts` (+ `.test.ts`) | `AutopilotScheduler` — leased cron tick beside the dispatcher |
| `src/mounts/autopilots.ts` (+ `.test.ts`) | `/api/v1/autopilots` management API and cron preview |
| `src/mounts/autopilot-webhooks.ts` (+ `.test.ts`) | `/api/webhooks/autopilots/:token` public ingress |
| `src/mounts/autopilots.cross-tenant.test.ts` (create) | two-workspace leakage guarantees for the new mount |
| `src/realtime/replay.ts` (modify) | add `AUTOPILOT_TOPICS` to `WORKSPACE_TOPICS` |
| `src/realtime/replay.autopilot-topics.test.ts` (create) | offline: every autopilot topic reaches the workspace stream |
| `src/index.ts` (modify) | wire repository, fire, mounts, scheduler |
| `SCOPE.md` (modify) | list the two new prefixes |

**Frontend (`frontend/`)**

| File | Responsibility |
|---|---|
| `lib/autopilots.ts` (create) | Zod v3 wire schemas and API functions |
| `hooks/use-autopilots.ts` (create) | workspace list, refreshed on `autopilot.*` events |
| `hooks/use-autopilot.ts` (create) | one autopilot plus its runs and deliveries, refreshed on events |
| `app/[orgId]/autopilots/page.tsx` (create) | list page |
| `app/[orgId]/autopilot/[autopilotId]/page.tsx` (create) | detail page |
| `components/layout/headers/autopilots/header.tsx` (create) | list header with the "new autopilot" action |
| `components/common/autopilots/autopilots.tsx` (create) | list body |
| `components/common/autopilots/autopilot-dialog.tsx` (create) | create/edit form |
| `components/common/autopilots/autopilot-detail.tsx` (create) | detail shell: actions and tabs |
| `components/common/autopilots/triggers-tab.tsx` (create) | cron form with live preview; webhook add/rotate with one-time secrets |
| `components/common/autopilots/history-tabs.tsx` (create) | runs table, deliveries table with replay |
| `components/layout/shell/shell-routes.ts` (modify) | one `ShellRouteDef` (`autopilots`) |
| `store/sidebar-prefs-store.ts` (modify) | `'autopilot'` in `DEFAULT_ORDER.configure` (the key already exists) |
| `components/layout/sidebar/customize-sidebar-dialog.tsx` (modify) | one `CONFIGURE_ITEMS` entry |

## Task order and parallelism

- Tasks 1, 2 and 3 are independent, and can run in parallel.
- Task 4 needs 1, 2 and 3. Task 5 needs 4. Task 6 needs 5. Tasks 7 and 8 need 5, and can run in parallel with each other and with 6.
- Task 9 needs 6, 7 and 8, **and workstream A merged** (`server-ts/src/runs/queue.ts` must exist).
- Task 10 needs only the wire shapes fixed in Task 7, so it can start once Task 7's serializers are written. Tasks 11 and 12 need 10, and can run in parallel with each other. The only file both touch is `lib/autopilots.ts`, which neither edits.

## Wire shapes (fixed here; Tasks 7 and 10 must match)

```jsonc
// Autopilot (list node, and the base of the detail)
{ "id", "workspaceId", "name", "description": string|null,
  "assigneeType": "agent"|"squad", "assigneeId",
  "promptTemplate", "executionMode": "create_issue"|"fixed_issue",
  "boardId": string|null, "issueId": string|null,
  "status": "active"|"paused"|"archived", "version": number,
  "quotaPeriod": "none"|"hour"|"day"|"week", "quotaMax": number|null,
  "createdBy": string|null, "createdAt", "updatedAt" }
// GET /api/v1/autopilots/:id  => Autopilot & { "triggers": Trigger[], "members": Member[] }
// Trigger
{ "id", "autopilotId", "kind": "cron"|"webhook", "enabled": boolean,
  "cronExpression": string|null, "timezone": string|null,
  "nextFireAt": string|null, "lastFiredAt": string|null,
  "tokenHint": string|null, "eventFilters": string[], "createdAt", "updatedAt" }
// Member
{ "userId", "role": "collaborator"|"subscriber", "createdAt" }
// Secrets (only in POST /:id/triggers for webhooks and POST .../rotate)
{ "token", "signingSecret", "ingressPath": "/api/webhooks/autopilots/<token>" }
// AutopilotRun
{ "id", "autopilotId", "autopilotVersion", "triggerId": string|null,
  "source": "cron"|"webhook"|"manual"|"replay",
  "status": "pending"|"enqueued"|"skipped"|"failed",
  "reasonCode": string|null, "reasonMessage": string|null,
  "issueId": string|null, "runId": string|null, "taskStatus": string|null,
  "slot": string|null, "requestedBy": string|null, "createdAt" }
// WebhookDelivery (list). GET /:id/deliveries/:deliveryId => WebhookDelivery & { "payload": unknown }
{ "id", "autopilotId", "triggerId": string|null, "event": string|null,
  "status": "accepted"|"filtered"|"rejected"|"failed",
  "failureReason": string|null, "autopilotRunId": string|null,
  "replayOf": string|null, "receivedAt" }
// FireOutcome (POST /:id/run, POST .../replay, webhook ingress)
{ "autopilotRunId", "status": "enqueued"|"skipped"|"failed",
  "reasonCode": string|null, "runId": string|null, "issueId": string|null }
```

Lists answer `{ "nodes": [...] }`, newest first, capped at 100 (autopilots at 500). They are not cursor-paged. See Open Questions.

---

### Task 1: Migration 100 — autopilot tables

**Files:**
- Create: `server-ts/migrations/100_autopilots.up.sql`
- Test: `server-ts/src/autopilots/migration.test.ts`

**Interfaces:**
- Consumes: existing tables `workspaces`, `users`, `boards`, `issues`, and the function `berry_set_updated_at()` (defined before 021, and still present).
- Produces, for every later task:
  - `autopilots`
  - `autopilot_versions`
  - `autopilot_members`
  - `autopilot_triggers`
  - `autopilot_runs`
  - `webhook_deliveries`
  - `sys_cron_executions`

  Column names are exactly as written below. `autopilot_runs.run_id` deliberately has **no FK**: A owns `runs`, and E must not fail if a run row is pruned or if A adds an `autopilot_run_id` column that points back.

- [ ] **Step 1: Write the failing test**

Create `server-ts/src/autopilots/migration.test.ts`:

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * Migration 100, read as text. Offline on purpose: the guarantees here are
 * about what the file declares — every table scoped to a workspace, one
 * claim per cron slot, and nothing of the retired rules engine — and none of
 * them needs a database to check.
 */
const text = readFileSync(new URL('../../migrations/100_autopilots.up.sql', import.meta.url), 'utf8');

function tables(): Map<string, string> {
   const found = new Map<string, string>();
   for (const match of text.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
      found.set(match[1] ?? '', match[2] ?? '');
   }
   return found;
}

test('the migration creates exactly the autopilot tables', () => {
   assert.deepEqual([...tables().keys()].sort(), [
      'autopilot_members',
      'autopilot_runs',
      'autopilot_triggers',
      'autopilot_versions',
      'autopilots',
      'sys_cron_executions',
      'webhook_deliveries',
   ]);
});

test('every table it creates belongs to a workspace and goes with it', () => {
   for (const [name, body] of tables()) {
      assert.match(
         body,
         /workspace_id uuid NOT NULL REFERENCES workspaces\(id\) ON DELETE CASCADE/,
         `${name} must carry workspace_id`
      );
   }
});

test('a cron slot can be claimed once: unique on trigger and slot', () => {
   assert.match(tables().get('sys_cron_executions') ?? '', /UNIQUE \(trigger_id, slot\)/);
});

test('a webhook token is stored as a hash, never as itself', () => {
   const triggers = tables().get('autopilot_triggers') ?? '';
   assert.match(triggers, /webhook_token_hash bytea/);
   assert.doesNotMatch(triggers, /webhook_token text/);
   assert.match(triggers, /signing_secret_sealed bytea/);
});

test('the retired rules engine is not brought back', () => {
   assert.doesNotMatch(text, /CREATE TABLE IF NOT EXISTS automation/);
   assert.doesNotMatch(text, /REFERENCES automation/);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/autopilots/migration.test.ts`
Expected: FAIL with `ENOENT: no such file or directory ... 100_autopilots.up.sql`.

- [ ] **Step 3: Write the migration**

Create `server-ts/migrations/100_autopilots.up.sql`. Each `CREATE TABLE` must end with a line that is exactly `);`, because the test's parser relies on it.

```sql
-- Berry migration 100: autopilots.
--
-- An autopilot is a standing instruction: this agent (or squad), this
-- prompt, whenever a schedule comes round or a signed webhook arrives. Each
-- firing becomes one agent task through the shared task queue. There is no
-- step graph and no condition language; a person who wants a condition
-- writes it in the prompt, where the agent will read it.
--
-- Every table is scoped to a workspace directly, so a workspace delete takes
-- all of it and no query needs a join to know whose a row is.

CREATE TABLE IF NOT EXISTS autopilots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text,
    assignee_type text NOT NULL,
    assignee_id uuid NOT NULL,                  -- agents.id or squads.id; checked on write, resolved on fire
    prompt_template text NOT NULL,
    execution_mode text NOT NULL,
    board_id uuid REFERENCES boards(id) ON DELETE SET NULL,   -- create_issue: where tasks are opened
    issue_id uuid REFERENCES issues(id) ON DELETE SET NULL,   -- fixed_issue: the task every run works on
    status text NOT NULL DEFAULT 'active',
    version integer NOT NULL DEFAULT 1,         -- bumps when the definition changes (autopilot_versions row)
    quota_period text NOT NULL DEFAULT 'none',
    quota_max integer,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    CONSTRAINT autopilots_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT autopilots_name_ck CHECK (char_length(name) BETWEEN 1 AND 200),
    CONSTRAINT autopilots_description_ck CHECK (description IS NULL OR char_length(description) <= 5000),
    CONSTRAINT autopilots_assignee_type_ck CHECK (assignee_type IN ('agent', 'squad')),
    CONSTRAINT autopilots_prompt_ck CHECK (char_length(prompt_template) BETWEEN 1 AND 20000),
    CONSTRAINT autopilots_mode_ck CHECK (execution_mode IN ('create_issue', 'fixed_issue')),
    CONSTRAINT autopilots_status_ck CHECK (status IN ('active', 'paused', 'archived')),
    CONSTRAINT autopilots_archived_ck CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
    CONSTRAINT autopilots_version_ck CHECK (version >= 1),
    CONSTRAINT autopilots_quota_ck CHECK (
        quota_period IN ('none', 'hour', 'day', 'week')
        AND ((quota_period = 'none') = (quota_max IS NULL))
        AND (quota_max IS NULL OR quota_max BETWEEN 1 AND 10000)
    )
);
CREATE INDEX IF NOT EXISTS autopilots_workspace_order_idx
    ON autopilots (workspace_id, updated_at DESC, id DESC) WHERE archived_at IS NULL;
DROP TRIGGER IF EXISTS berry_autopilots_set_updated_at ON autopilots;
CREATE TRIGGER berry_autopilots_set_updated_at BEFORE UPDATE ON autopilots
    FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();

CREATE TABLE IF NOT EXISTS autopilot_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    autopilot_id uuid NOT NULL,
    version integer NOT NULL,
    snapshot jsonb NOT NULL,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT autopilot_versions_autopilot_fk FOREIGN KEY (workspace_id, autopilot_id)
        REFERENCES autopilots(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT autopilot_versions_version_key UNIQUE (autopilot_id, version),
    CONSTRAINT autopilot_versions_snapshot_ck CHECK (jsonb_typeof(snapshot) = 'object' AND octet_length(snapshot::text) <= 65536)
);

CREATE TABLE IF NOT EXISTS autopilot_members (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    autopilot_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT autopilot_members_pkey PRIMARY KEY (autopilot_id, user_id),
    CONSTRAINT autopilot_members_autopilot_fk FOREIGN KEY (workspace_id, autopilot_id)
        REFERENCES autopilots(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT autopilot_members_role_ck CHECK (role IN ('collaborator', 'subscriber'))
);

CREATE TABLE IF NOT EXISTS autopilot_triggers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    autopilot_id uuid NOT NULL,
    kind text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    cron_expression text,
    timezone text,
    next_fire_at timestamptz,                    -- the next slot the scheduler will claim
    last_fired_at timestamptz,
    webhook_token_hash bytea,                    -- sha256 of the token; the token itself is never stored
    webhook_token_hint text,                     -- last four characters, so a person can tell tokens apart
    signing_secret_sealed bytea,                 -- sealed with integrations/sealing.ts
    event_filters text[] NOT NULL DEFAULT ARRAY[]::text[],
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT autopilot_triggers_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT autopilot_triggers_autopilot_fk FOREIGN KEY (workspace_id, autopilot_id)
        REFERENCES autopilots(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT autopilot_triggers_kind_ck CHECK (kind IN ('cron', 'webhook')),
    CONSTRAINT autopilot_triggers_cron_ck CHECK (
        (kind = 'cron') = (cron_expression IS NOT NULL AND timezone IS NOT NULL)
    ),
    CONSTRAINT autopilot_triggers_webhook_ck CHECK (
        (kind = 'webhook') = (webhook_token_hash IS NOT NULL AND signing_secret_sealed IS NOT NULL)
    ),
    CONSTRAINT autopilot_triggers_token_hash_ck CHECK (webhook_token_hash IS NULL OR octet_length(webhook_token_hash) = 32),
    CONSTRAINT autopilot_triggers_cron_length_ck CHECK (cron_expression IS NULL OR char_length(cron_expression) <= 200),
    CONSTRAINT autopilot_triggers_filters_ck CHECK (cardinality(event_filters) <= 50)
);
CREATE UNIQUE INDEX IF NOT EXISTS autopilot_triggers_token_key
    ON autopilot_triggers (webhook_token_hash) WHERE webhook_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS autopilot_triggers_due_idx
    ON autopilot_triggers (next_fire_at) WHERE kind = 'cron' AND enabled AND next_fire_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS autopilot_triggers_autopilot_idx ON autopilot_triggers (autopilot_id, created_at, id);
DROP TRIGGER IF EXISTS berry_autopilot_triggers_set_updated_at ON autopilot_triggers;
CREATE TRIGGER berry_autopilot_triggers_set_updated_at BEFORE UPDATE ON autopilot_triggers
    FOR EACH ROW EXECUTE FUNCTION berry_set_updated_at();

CREATE TABLE IF NOT EXISTS autopilot_runs (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    autopilot_id uuid NOT NULL,
    autopilot_version integer NOT NULL,
    trigger_id uuid REFERENCES autopilot_triggers(id) ON DELETE SET NULL,
    source text NOT NULL,
    status text NOT NULL,
    reason_code text,
    reason_message text,
    issue_id uuid REFERENCES issues(id) ON DELETE SET NULL,
    run_id uuid,                                 -- the queued task (runs.id); no FK, runs belongs to the task queue
    slot timestamptz,                            -- cron firings: the slot this run answers
    requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT autopilot_runs_autopilot_fk FOREIGN KEY (workspace_id, autopilot_id)
        REFERENCES autopilots(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT autopilot_runs_source_ck CHECK (source IN ('cron', 'webhook', 'manual', 'replay')),
    CONSTRAINT autopilot_runs_status_ck CHECK (status IN ('pending', 'enqueued', 'skipped', 'failed')),
    CONSTRAINT autopilot_runs_reason_ck CHECK ((status IN ('pending', 'enqueued')) = (reason_code IS NULL)),
    CONSTRAINT autopilot_runs_reason_length_ck CHECK (reason_message IS NULL OR char_length(reason_message) <= 2000)
);
CREATE INDEX IF NOT EXISTS autopilot_runs_order_idx ON autopilot_runs (autopilot_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS autopilot_runs_quota_idx
    ON autopilot_runs (autopilot_id, created_at) WHERE status IN ('pending', 'enqueued');

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    autopilot_id uuid NOT NULL,
    trigger_id uuid REFERENCES autopilot_triggers(id) ON DELETE SET NULL,
    event text,
    status text NOT NULL,
    payload jsonb,                               -- null when the delivery was refused before it was read
    failure_reason text,
    autopilot_run_id uuid REFERENCES autopilot_runs(id) ON DELETE SET NULL,
    replay_of uuid REFERENCES webhook_deliveries(id) ON DELETE SET NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT webhook_deliveries_autopilot_fk FOREIGN KEY (workspace_id, autopilot_id)
        REFERENCES autopilots(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT webhook_deliveries_status_ck CHECK (status IN ('accepted', 'filtered', 'rejected', 'failed')),
    CONSTRAINT webhook_deliveries_event_ck CHECK (event IS NULL OR char_length(event) <= 100),
    CONSTRAINT webhook_deliveries_payload_ck CHECK (payload IS NULL OR octet_length(payload::text) <= 262144),
    CONSTRAINT webhook_deliveries_failure_ck CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 200)
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_order_idx ON webhook_deliveries (autopilot_id, received_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS sys_cron_executions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    trigger_id uuid NOT NULL REFERENCES autopilot_triggers(id) ON DELETE CASCADE,
    slot timestamptz NOT NULL,
    autopilot_run_id uuid REFERENCES autopilot_runs(id) ON DELETE SET NULL,
    claimed_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sys_cron_executions_slot_key UNIQUE (trigger_id, slot)
);
CREATE INDEX IF NOT EXISTS sys_cron_executions_retention_idx ON sys_cron_executions (claimed_at, id);
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/autopilots/migration.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Apply it to the test database, if one is running**

The test database is a schema copy (see `server-ts/ROUTING.md`, "Running the database-backed tests"), so apply the file directly rather than through the migration ledger:

Run: `test -n "$BERRY_TEST_DATABASE_URL" && psql "$BERRY_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f /Users/secret/Code/berry-circle/server-ts/migrations/100_autopilots.up.sql`
Expected: the `CREATE TABLE`, `CREATE INDEX` and `CREATE TRIGGER` lines print with no `ERROR`. If the variable is unset, skip this step. Later DB tests will self-skip.

- [ ] **Step 6: Commit**

```bash
git add server-ts/migrations/100_autopilots.up.sql server-ts/src/autopilots/migration.test.ts
git commit -m "feat(server-ts): add the autopilot tables"
```

---

### Task 2: Cron schedules with `croner`

**Files:**
- Modify: `server-ts/package.json` (dependencies)
- Create: `server-ts/src/autopilots/cron.ts`
- Test: `server-ts/src/autopilots/cron.test.ts`

**Interfaces:**
- Consumes: `validTimezone(value: string): boolean` from `server-ts/src/http/validation.ts`, and `Cron` from `croner`.
- Produces:
  - `class InvalidSchedule extends Error`.
  - `assertSchedule(expression: string, timezone: string): void`, which throws `InvalidSchedule`.
  - `nextFireTimes(expression: string, timezone: string, from: Date, count: number): Date[]`: strictly after `from`, with `count` clamped to 1–20.
  - `nextFireAfter(expression: string, timezone: string, from: Date): Date | null`: strictly after `from`.
  - `MAX_PREVIEW = 20`.

- [ ] **Step 1: Add the dependency**

Run: `cd /Users/secret/Code/berry-circle/server-ts && pnpm add croner@^10.0.1`
Expected: `server-ts/package.json` gains `"croner": "^10.0.1"` under `dependencies`, and `pnpm-lock.yaml` updates. croner is MIT and has no dependencies, so the license rule in `AGENTS.md` holds.

- [ ] **Step 2: Write the failing test**

Create `server-ts/src/autopilots/cron.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvalidSchedule, MAX_PREVIEW, assertSchedule, nextFireAfter, nextFireTimes } from './cron.ts';

// 2026-09-10 is a Thursday. Rome is UTC+2 in September.
const THURSDAY_MIDNIGHT_UTC = new Date('2026-09-10T00:00:00.000Z');

test('a weekday-morning schedule fires at 09:00 in its own time zone, skipping the weekend', () => {
   const times = nextFireTimes('0 9 * * 1-5', 'Europe/Rome', THURSDAY_MIDNIGHT_UTC, 3);
   assert.deepEqual(
      times.map((time) => time.toISOString()),
      ['2026-09-10T07:00:00.000Z', '2026-09-11T07:00:00.000Z', '2026-09-14T07:00:00.000Z']
   );
});

test('the next firing is strictly after the moment asked about, even when that moment is a slot', () => {
   const next = nextFireAfter('0 9 * * *', 'UTC', new Date('2026-09-10T09:00:00.000Z'));
   assert.equal(next?.toISOString(), '2026-09-11T09:00:00.000Z');
});

test('a preview never lists more than the cap', () => {
   assert.equal(nextFireTimes('* * * * *', 'UTC', THURSDAY_MIDNIGHT_UTC, 500).length, MAX_PREVIEW);
   assert.equal(nextFireTimes('* * * * *', 'UTC', THURSDAY_MIDNIGHT_UTC, 0).length, 1);
});

test('a schedule with a seconds field is refused: autopilots fire at most once a minute', () => {
   assert.throws(() => assertSchedule('*/5 * * * * *', 'UTC'), InvalidSchedule);
});

test('an unknown or server-local time zone is refused', () => {
   assert.throws(() => assertSchedule('0 9 * * *', 'Mars/Olympus_Mons'), InvalidSchedule);
   assert.throws(() => assertSchedule('0 9 * * *', 'Local'), InvalidSchedule);
});

test('an expression croner cannot read is refused as a schedule, not a crash', () => {
   assert.throws(() => assertSchedule('99 * * * *', 'UTC'), InvalidSchedule);
   assert.throws(() => assertSchedule('every morning', 'UTC'), InvalidSchedule);
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/autopilots/cron.test.ts`
Expected: FAIL with `Cannot find module '.../src/autopilots/cron.ts'`.

- [ ] **Step 4: Implement**

Create `server-ts/src/autopilots/cron.ts`:

```ts
import { Cron } from 'croner';
import { validTimezone } from '../http/validation.ts';

/**
 * When a schedule fires.
 *
 * Five fields only — minute, hour, day of month, month, day of week. croner
 * also reads a seconds field, and a schedule that fires every second would be
 * an agent task every second; the refusal is here rather than in the UI so an
 * API caller meets it too.
 *
 * The time zone is an IANA name and never `Local`: the server's own zone is a
 * deployment detail, and a schedule that moved when the host did would fire
 * at a time nobody chose.
 *
 * "Next" is always strictly after the moment asked about. The scheduler asks
 * "what comes after the slot I just claimed", and an answer equal to that
 * slot would claim it again forever.
 */

export const MAX_PREVIEW = 20;

export class InvalidSchedule extends Error {
   override readonly name = 'InvalidSchedule';
}

export function assertSchedule(expression: string, timezone: string): void {
   build(expression, timezone);
}

export function nextFireTimes(
   expression: string,
   timezone: string,
   from: Date,
   count: number
): Date[] {
   const n = Math.min(Math.max(1, Math.floor(Number.isFinite(count) ? count : 1)), MAX_PREVIEW);
   return build(expression, timezone).nextRuns(n, strictlyAfter(from));
}

export function nextFireAfter(expression: string, timezone: string, from: Date): Date | null {
   return build(expression, timezone).nextRun(strictlyAfter(from));
}

function build(expression: string, timezone: string): Cron {
   const trimmed = expression.trim();
   if (trimmed.split(/\s+/).length !== 5) {
      throw new InvalidSchedule(
         'A schedule has five fields: minute, hour, day of month, month and day of week.'
      );
   }
   if (timezone === 'Local' || !validTimezone(timezone)) {
      throw new InvalidSchedule('The time zone is not one this server knows.');
   }
   try {
      // Paused and without a callback: this instance is only ever asked
      // questions, and must never schedule a timer in the server process.
      return new Cron(trimmed, { timezone, paused: true });
   } catch (cause) {
      throw new InvalidSchedule('The schedule could not be read.', { cause });
   }
}

/**
 * One second past `from`. Every slot is on a whole minute, so this moves past
 * `from` when it is a slot and changes nothing when it is not — whichever way
 * croner treats its start date.
 */
function strictlyAfter(from: Date): Date {
   return new Date(from.getTime() + 1_000);
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/autopilots/cron.test.ts && pnpm typecheck`
Expected: PASS (6 tests), then `tsc --noEmit` exits 0.

- [ ] **Step 6: Commit**

```bash
git add server-ts/package.json pnpm-lock.yaml server-ts/src/autopilots/cron.ts server-ts/src/autopilots/cron.test.ts
git commit -m "feat(server-ts): read autopilot schedules with croner"
```

---

### Task 3: Prompt templates and webhook signing

**Files:**
- Create: `server-ts/src/autopilots/template.ts`, `server-ts/src/autopilots/signing.ts`
- Test: `server-ts/src/autopilots/template.test.ts`, `server-ts/src/autopilots/signing.test.ts`

**Interfaces:**
- Consumes: `verifySignature(body: string, signature: string, secret: string): boolean` from `server-ts/src/scm/webhook.ts`.
- Produces:
  - `interface PromptContext { autopilot: { id: string; name: string }; trigger: { source: string; firedAt: string }; payload: unknown }`
  - `renderPrompt(template: string, context: PromptContext): string`
  - `MAX_PROMPT_CHARS = 20_000`
  - `SIGNATURE_HEADER = 'x-berry-signature'` and `EVENT_HEADER = 'x-berry-event'`
  - `newWebhookToken(): string` (format `apw_` + 32 base64url characters) and `validTokenShape(token: string): boolean`
  - `newSigningSecret(): string` (format `whsec_` + 43 base64url characters)
  - `hashToken(token: string): Buffer` (32 bytes) and `tokenHint(token: string): string` (the last 4 characters)
  - `signBody(body: string, secret: string): string` (format `sha256=<hex>`)
  - a re-export of `verifySignature`

- [ ] **Step 1: Write the failing tests**

Create `server-ts/src/autopilots/template.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_PROMPT_CHARS, renderPrompt, type PromptContext } from './template.ts';

const context: PromptContext = {
   autopilot: { id: 'a1', name: 'Nightly triage' },
   trigger: { source: 'webhook', firedAt: '2026-09-10T07:00:00.000Z' },
   payload: { event: 'deploy', build: { id: 42, ok: true }, items: ['x', 'y'] },
};

test('placeholders read the autopilot, the trigger and the payload by path', () => {
   assert.equal(
      renderPrompt('{{autopilot.name}} on {{ trigger.source }} at {{trigger.firedAt}}: build {{payload.build.id}} ok={{payload.build.ok}} first={{payload.items.0}}', context),
      'Nightly triage on webhook at 2026-09-10T07:00:00.000Z: build 42 ok=true first=x'
   );
});

test('a path that leads nowhere renders as nothing rather than as the placeholder', () => {
   assert.equal(renderPrompt('[{{payload.missing.deep}}]', context), '[]');
});

test('an object renders as its JSON', () => {
   assert.equal(renderPrompt('{{payload.build}}', context), '{"id":42,"ok":true}');
});

test('inherited properties are not reachable from a template', () => {
   assert.equal(renderPrompt('[{{payload.constructor}}][{{payload.__proto__}}]', context), '[][]');
});

test('text arriving in a payload is not expanded a second time', () => {
   const sneaky = { ...context, payload: { note: '{{autopilot.id}}' } };
   assert.equal(renderPrompt('{{payload.note}}', sneaky), '{{autopilot.id}}');
});

test('the rendered prompt is capped', () => {
   const long = { ...context, payload: { text: 'x'.repeat(4_000) } };
   const rendered = renderPrompt('{{payload.text}}'.repeat(10), long);
   assert.equal(rendered.length, MAX_PROMPT_CHARS);
});
```

Create `server-ts/src/autopilots/signing.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
   hashToken,
   newSigningSecret,
   newWebhookToken,
   signBody,
   tokenHint,
   validTokenShape,
   verifySignature,
} from './signing.ts';

test('a body signed with the secret verifies, and a tampered one does not', () => {
   const secret = newSigningSecret();
   const body = JSON.stringify({ event: 'deploy' });
   const signature = signBody(body, secret);
   assert.match(signature, /^sha256=[0-9a-f]{64}$/);
   assert.equal(verifySignature(body, signature, secret), true);
   assert.equal(verifySignature(body + ' ', signature, secret), false);
   assert.equal(verifySignature(body, signature, newSigningSecret()), false);
});

test('tokens are unguessable, well-shaped and distinct', () => {
   const first = newWebhookToken();
   const second = newWebhookToken();
   assert.notEqual(first, second);
   assert.equal(validTokenShape(first), true);
   assert.equal(validTokenShape('apw_short'), false);
   assert.equal(validTokenShape('../../etc/passwd'), false);
});

test('a token is looked up by a fixed-length hash, and only its tail is shown', () => {
   const token = newWebhookToken();
   assert.equal(hashToken(token).length, 32);
   assert.deepEqual(hashToken(token), hashToken(token));
   assert.equal(tokenHint(token), token.slice(-4));
});

test('a signing secret is long enough to be a key', () => {
   assert.match(newSigningSecret(), /^whsec_[A-Za-z0-9_-]{43}$/);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/autopilots/template.test.ts src/autopilots/signing.test.ts`
Expected: FAIL with `Cannot find module` for both files.

- [ ] **Step 3: Implement `template.ts`**

```ts
/**
 * An autopilot's prompt, with the firing's facts filled in.
 *
 * Substitution only: `{{autopilot.name}}`, `{{trigger.firedAt}}`,
 * `{{payload.build.id}}`. No expressions, no helpers, no loops — a template
 * language that can evaluate anything is a way for a webhook sender to run
 * code on this server. One pass, so text that arrives in a payload is never
 * itself treated as a template.
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*\}\}/g;
const MAX_VALUE_CHARS = 4_000;
export const MAX_PROMPT_CHARS = 20_000;

export interface PromptContext {
   autopilot: { id: string; name: string };
   trigger: { source: string; firedAt: string };
   payload: unknown;
}

export function renderPrompt(template: string, context: PromptContext): string {
   const rendered = template.replace(PLACEHOLDER, (_whole, path: string) =>
      stringify(lookup(context, path.split('.')))
   );
   return rendered.length > MAX_PROMPT_CHARS ? rendered.slice(0, MAX_PROMPT_CHARS) : rendered;
}

function lookup(root: unknown, path: string[]): unknown {
   let current: unknown = root;
   for (const key of path) {
      if (current === null || typeof current !== 'object') return undefined;
      // Own properties only: `constructor` and `__proto__` are not data.
      if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
      current = (current as Record<string, unknown>)[key];
   }
   return current;
}

function stringify(value: unknown): string {
   if (value === undefined || value === null) return '';
   if (typeof value === 'string') return value.slice(0, MAX_VALUE_CHARS);
   if (typeof value === 'number' || typeof value === 'boolean') return String(value);
   return JSON.stringify(value).slice(0, MAX_VALUE_CHARS);
}
```

- [ ] **Step 4: Implement `signing.ts`**

```ts
import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * What makes an autopilot webhook safe to leave on the public internet.
 *
 * The token in the URL says which trigger is meant; it is stored only as a
 * SHA-256 hash, so a database read does not hand anyone a working URL. The
 * signing secret proves the sender knows it: the raw body is signed with
 * HMAC-SHA256 and sent as `X-Berry-Signature: sha256=<hex>`, the same
 * packaging GitHub uses, so the constant-time check in scm/webhook serves
 * both.
 */

export { verifySignature } from '../scm/webhook.ts';

export const SIGNATURE_HEADER = 'x-berry-signature';
export const EVENT_HEADER = 'x-berry-event';

const TOKEN_SHAPE = /^apw_[A-Za-z0-9_-]{32}$/;

export function newWebhookToken(): string {
   return `apw_${randomBytes(24).toString('base64url')}`;
}

export function validTokenShape(token: string): boolean {
   return TOKEN_SHAPE.test(token);
}

export function newSigningSecret(): string {
   return `whsec_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): Buffer {
   return createHash('sha256').update(token, 'utf8').digest();
}

export function tokenHint(token: string): string {
   return token.slice(-4);
}

export function signBody(body: string, secret: string): string {
   return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/autopilots/template.test.ts src/autopilots/signing.test.ts && pnpm typecheck`
Expected: PASS (10 tests), and typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add server-ts/src/autopilots/template.ts server-ts/src/autopilots/template.test.ts server-ts/src/autopilots/signing.ts server-ts/src/autopilots/signing.test.ts
git commit -m "feat(server-ts): render autopilot prompts and sign autopilot webhooks"
```

---
### Task 4: Outbox events, test fixture and `AutopilotRepository`

**Files:**
- Create: `server-ts/src/autopilots/events.ts`
- Create: `server-ts/src/autopilots/test-fixture.ts`
- Create: `server-ts/src/autopilots/repository.ts`
- Test: `server-ts/src/autopilots/repository.test.ts`

**Interfaces:**
- Consumes:
  - `Sql` and `toRFC3339(value: string | null | undefined): string | null` from `../db/pool.ts`.
  - `NotFound` from `../identity/errors.ts`.
  - `Sealer` from `../integrations/sealing.ts`.
  - `assertSchedule` and `nextFireAfter` (Task 2).
  - `hashToken`, `newSigningSecret`, `newWebhookToken` and `tokenHint` (Task 3).
- Produces (`events.ts`):
  - `AUTOPILOT_TOPICS = ['autopilot.created', 'autopilot.updated', 'autopilot.archived', 'autopilot.run.created', 'autopilot.delivery.received'] as const`
  - `type AutopilotTopic`
  - `writeAutopilotEvent(tx: Sql, input: { workspaceId: string; topic: AutopilotTopic; autopilotId: string; payload: Record<string, unknown>; occurredAt: string }): Promise<string>`
- Produces (`test-fixture.ts`):
  - `interface Fixture { userId: string; workspaceId: string; boardId: string; agentId: string }`
  - `seedWorkspace(sql: Sql, label: string): Promise<Fixture>`
  - `cleanupWorkspace(sql: Sql, fixture: Fixture): Promise<void>`
  - `testSealer(): Sealer`
- Produces (`repository.ts`): the types `Autopilot`, `AutopilotDraft`, `AutopilotPatch`, `AutopilotVersion`, `AutopilotMember`, `AutopilotTrigger`, `WebhookSecrets`, `AutopilotRunRecord`, `WebhookDeliveryRecord`, `RunSource`, `DeliveryStatus`, the constants `ASSIGNEE_TYPES`, `EXECUTION_MODES` and `QUOTA_PERIODS`, the error class `InvalidAutopilot` (`field: string`), and `class AutopilotRepository`:

  | Method | Returns |
  |---|---|
  | `constructor({ sql, sealer, clock? })` | |
  | `workspaceOf(id)` | `Promise<string>`, throws `NotFound` |
  | `list(workspaceId)` | `Promise<Autopilot[]>` |
  | `get(workspaceId, id)` | `Promise<Autopilot>` |
  | `create(workspaceId, draft, actorId)` | `Promise<Autopilot>` |
  | `update(workspaceId, id, patch, actorId)` | `Promise<Autopilot>` |
  | `archive(workspaceId, id, actorId)` | `Promise<void>` |
  | `versions(workspaceId, id)` | `Promise<AutopilotVersion[]>` |
  | `members(workspaceId, id)` | `Promise<AutopilotMember[]>` |
  | `setMembers(workspaceId, id, members)` | `Promise<AutopilotMember[]>` |
  | `triggers(workspaceId, id)` | `Promise<AutopilotTrigger[]>` |
  | `addCronTrigger(workspaceId, id, { expression, timezone, enabled })` | `Promise<AutopilotTrigger>` |
  | `addWebhookTrigger(workspaceId, id, { eventFilters, enabled })` | `Promise<{ trigger; secrets }>` |
  | `updateTrigger(workspaceId, id, triggerId, patch)` | `Promise<AutopilotTrigger>` |
  | `rotateWebhook(workspaceId, id, triggerId)` | `Promise<{ trigger; secrets }>` |
  | `deleteTrigger(workspaceId, id, triggerId)` | `Promise<void>` |
  | `runs(workspaceId, id)` | `Promise<AutopilotRunRecord[]>` |
  | `deliveries(workspaceId, id)` | `Promise<WebhookDeliveryRecord[]>` |
  | `deliveryPayload(workspaceId, id, deliveryId)` | `Promise<{ delivery; payload: unknown }>` |
  | `webhookByToken(token)` | `Promise<{ trigger; workspaceId; signingSecret } \| null>` |
  | `recordDelivery(input)` | `Promise<string>` |
  | `linkDelivery(deliveryId, autopilotRunId, status)` | `Promise<void>` |

- [ ] **Step 1: Write the outbox helper**

Create `server-ts/src/autopilots/events.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/pool.ts';

/**
 * Autopilot facts on the workspace stream.
 *
 * Same envelope as a goal's (core/goals.ts): no board, so it replays on the
 * workspace stream only, and the aggregate is the autopilot so a detail page
 * can tell whether a frame is about the one it shows.
 */

export const AUTOPILOT_TOPICS = [
   'autopilot.created',
   'autopilot.updated',
   'autopilot.archived',
   'autopilot.run.created',
   'autopilot.delivery.received',
] as const;

export type AutopilotTopic = (typeof AUTOPILOT_TOPICS)[number];

export async function writeAutopilotEvent(
   tx: Sql,
   input: {
      workspaceId: string;
      topic: AutopilotTopic;
      autopilotId: string;
      payload: Record<string, unknown>;
      occurredAt: string;
   }
): Promise<string> {
   const id = randomUUID();
   const envelope = {
      id,
      type: input.topic,
      occurredAt: input.occurredAt,
      workspaceId: input.workspaceId,
      boardId: null,
      aggregateType: 'autopilot',
      aggregateId: input.autopilotId,
      payload: { autopilotId: input.autopilotId, ...input.payload },
   };
   await tx`
      INSERT INTO outbox_events (
         id, topic, aggregate_type, aggregate_id, workspace_id, board_id,
         payload, occurred_at, available_at
      ) VALUES (
         ${id}, ${input.topic}, 'autopilot', ${input.autopilotId}, ${input.workspaceId}, NULL,
         ${tx.json(envelope as never)}, ${input.occurredAt}, ${input.occurredAt}
      )`;
   return id;
}
```

- [ ] **Step 2: Write the shared test fixture**

Create `server-ts/src/autopilots/test-fixture.ts`. It is modelled on `seed` and `cleanup` in `src/runs/dispatcher.test.ts`. The name does not end in `.test.ts`, so the runner never executes it.

```ts
import { randomBytes, randomUUID } from 'node:crypto';
import type { Sql } from '../db/pool.ts';
import { sealerFromKey, type Sealer } from '../integrations/sealing.ts';

/**
 * One workspace with an owner, a board and an agent — what every autopilot
 * test needs before it can create one. Shared so the five DB-backed files
 * seed and tidy the same way, including the protected Orchestrator the
 * workspace-insert trigger provisions (see server-ts/ROUTING.md).
 */

export interface Fixture {
   userId: string;
   workspaceId: string;
   boardId: string;
   agentId: string;
}

export function testSealer(): Sealer {
   return sealerFromKey(randomBytes(32).toString('base64'));
}

export async function seedWorkspace(sql: Sql, label: string): Promise<Fixture> {
   const suffix = randomUUID().slice(0, 8);
   const [user] = await sql`
      INSERT INTO users (id, email, name)
      VALUES (${randomUUID()}, ${`${label}-${suffix}@berry.test`}, ${`Autopilot ${label}`})
      RETURNING id`;
   if (!user) throw new Error('user insert returned no row');
   const userId = user.id as string;

   const [workspace] = await sql`
      INSERT INTO workspaces (id, name, slug, settings, created_by)
      VALUES (${randomUUID()}, ${`Autopilot ${label} ${suffix}`}, ${`ap-${label}-${suffix}`},
              ${sql.json({ issuePrefix: 'APX', defaultRole: 'member', allowMemberInvites: false } as never)},
              ${userId})
      RETURNING id`;
   if (!workspace) throw new Error('workspace insert returned no row');
   const workspaceId = workspace.id as string;

   await sql`
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')`;

   const [board] = await sql`
      INSERT INTO boards (id, workspace_id, name, slug, created_by)
      VALUES (${randomUUID()}, ${workspaceId}, 'Autopilot board', ${`ap-${suffix}`}, ${userId})
      RETURNING id`;
   if (!board) throw new Error('board insert returned no row');

   const [agent] = await sql`
      INSERT INTO agents (id, workspace_id, board_id, name, instructions)
      VALUES (${randomUUID()}, ${workspaceId}, ${board.id as string}, 'Pilot', 'Be brief.')
      RETURNING id`;
   if (!agent) throw new Error('agent insert returned no row');

   return { userId, workspaceId, boardId: board.id as string, agentId: agent.id as string };
}

export async function cleanupWorkspace(sql: Sql, fixture: Fixture): Promise<void> {
   await sql`DELETE FROM outbox_events WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM autopilots WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`
      DELETE FROM issues
       WHERE board_id IN (SELECT id FROM boards WHERE workspace_id = ${fixture.workspaceId})`;
   await sql`ALTER TABLE agents DISABLE TRIGGER berry_agents_block_protected_delete`;
   try {
      await sql`DELETE FROM agents WHERE workspace_id = ${fixture.workspaceId}`;
   } finally {
      await sql`ALTER TABLE agents ENABLE TRIGGER berry_agents_block_protected_delete`;
   }
   await sql`DELETE FROM boards WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspaces WHERE id = ${fixture.workspaceId}`;
   await sql`DELETE FROM users WHERE id = ${fixture.userId}`;
}
```

- [ ] **Step 3: Write the failing repository test**

Create `server-ts/src/autopilots/repository.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { InvalidSchedule } from './cron.ts';
import { AutopilotRepository, InvalidAutopilot, type AutopilotDraft } from './repository.ts';
import { cleanupWorkspace, seedWorkspace, testSealer, type Fixture } from './test-fixture.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('autopilot repository', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let repo: AutopilotRepository;
   let mine: Fixture;
   let theirs: Fixture;

   before(async () => {
      sql = openDatabase({ url: url as string });
      repo = new AutopilotRepository({ sql, sealer: testSealer() });
      mine = await seedWorkspace(sql, 'repo-a');
      theirs = await seedWorkspace(sql, 'repo-b');
   });

   after(async () => {
      await cleanupWorkspace(sql, mine);
      await cleanupWorkspace(sql, theirs);
      await closeDatabase(sql);
   });

   function draft(overrides: Partial<AutopilotDraft> = {}): AutopilotDraft {
      return {
         name: 'Nightly triage',
         description: null,
         assigneeType: 'agent',
         assigneeId: mine.agentId,
         promptTemplate: 'Triage what came in overnight.',
         executionMode: 'create_issue',
         boardId: mine.boardId,
         issueId: null,
         quotaPeriod: 'none',
         quotaMax: null,
         ...overrides,
      };
   }

   test('creating an autopilot records version 1 and announces it', async () => {
      const created = await repo.create(mine.workspaceId, draft(), mine.userId);
      assert.equal(created.version, 1);
      assert.equal(created.status, 'active');
      const versions = await repo.versions(mine.workspaceId, created.id);
      assert.deepEqual(versions.map((v) => v.version), [1]);
      assert.equal(versions[0]?.snapshot.promptTemplate, 'Triage what came in overnight.');
      const [event] = await sql`
         SELECT topic FROM outbox_events WHERE aggregate_id = ${created.id} AND topic = 'autopilot.created'`;
      assert.ok(event);
   });

   test('an agent from another workspace cannot be the assignee', async () => {
      await assert.rejects(
         repo.create(mine.workspaceId, draft({ assigneeId: theirs.agentId }), mine.userId),
         (error: unknown) => error instanceof InvalidAutopilot && error.field === '/assigneeId'
      );
   });

   test('a board from another workspace cannot be the target', async () => {
      await assert.rejects(
         repo.create(mine.workspaceId, draft({ boardId: theirs.boardId }), mine.userId),
         (error: unknown) => error instanceof InvalidAutopilot && error.field === '/boardId'
      );
   });

   test('changing the prompt is a new version; pausing is not', async () => {
      const created = await repo.create(mine.workspaceId, draft(), mine.userId);
      const paused = await repo.update(mine.workspaceId, created.id, { status: 'paused' }, mine.userId);
      assert.equal(paused.version, 1);
      assert.equal(paused.status, 'paused');
      const edited = await repo.update(mine.workspaceId, created.id, { promptTemplate: 'New words.' }, mine.userId);
      assert.equal(edited.version, 2);
      const versions = await repo.versions(mine.workspaceId, created.id);
      assert.deepEqual(versions.map((v) => v.version), [2, 1]);
   });

   test('an autopilot is not found through another workspace', async () => {
      const created = await repo.create(mine.workspaceId, draft(), mine.userId);
      await assert.rejects(repo.get(theirs.workspaceId, created.id), { name: 'NotFound' });
      assert.equal(await repo.workspaceOf(created.id), mine.workspaceId);
   });

   test('a webhook token is shown once, stored as a hash, and stops working when rotated', async () => {
      const created = await repo.create(mine.workspaceId, draft(), mine.userId);
      const { trigger, secrets } = await repo.addWebhookTrigger(mine.workspaceId, created.id, {
         eventFilters: ['deploy'],
         enabled: true,
      });
      assert.equal(trigger.tokenHint, secrets.token.slice(-4));
      assert.deepEqual(trigger.eventFilters, ['deploy']);

      const [row] = await sql`
         SELECT webhook_token_hash, signing_secret_sealed FROM autopilot_triggers WHERE id = ${trigger.id}`;
      assert.ok(row);
      assert.equal(Buffer.from(row.webhook_token_hash as Buffer).includes(Buffer.from(secrets.token)), false);
      assert.equal(Buffer.from(row.signing_secret_sealed as Buffer).includes(Buffer.from(secrets.signingSecret)), false);

      const found = await repo.webhookByToken(secrets.token);
      assert.equal(found?.signingSecret, secrets.signingSecret);
      assert.equal(found?.trigger.id, trigger.id);

      const rotated = await repo.rotateWebhook(mine.workspaceId, created.id, trigger.id);
      assert.equal(await repo.webhookByToken(secrets.token), null);
      assert.equal((await repo.webhookByToken(rotated.secrets.token))?.trigger.id, trigger.id);
   });

   test('a cron trigger knows when it fires next, and a bad zone is refused', async () => {
      const created = await repo.create(mine.workspaceId, draft(), mine.userId);
      const trigger = await repo.addCronTrigger(mine.workspaceId, created.id, {
         expression: '0 9 * * *',
         timezone: 'Europe/Rome',
         enabled: true,
      });
      assert.ok(trigger.nextFireAt && Date.parse(trigger.nextFireAt) > Date.now());
      await assert.rejects(
         repo.addCronTrigger(mine.workspaceId, created.id, {
            expression: '0 9 * * *',
            timezone: 'Nowhere/At_All',
            enabled: true,
         }),
         InvalidSchedule
      );
   });

   test('only workspace members can be collaborators or subscribers', async () => {
      const created = await repo.create(mine.workspaceId, draft(), mine.userId);
      const members = await repo.setMembers(mine.workspaceId, created.id, [
         { userId: mine.userId, role: 'subscriber' },
      ]);
      assert.deepEqual(members.map((m) => [m.userId, m.role]), [[mine.userId, 'subscriber']]);
      await assert.rejects(
         repo.setMembers(mine.workspaceId, created.id, [{ userId: theirs.userId, role: 'collaborator' }]),
         (error: unknown) => error instanceof InvalidAutopilot && error.field === '/members'
      );
      await assert.rejects(
         repo.setMembers(mine.workspaceId, created.id, [{ userId: randomUUID(), role: 'collaborator' }]),
         InvalidAutopilot
      );
   });
});
```

- [ ] **Step 4: Run the test and confirm it fails**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/autopilots/repository.test.ts`
Expected: FAIL with `Cannot find module '.../src/autopilots/repository.ts'`. The import is resolved before the DB gate applies, so this fails even offline.

- [ ] **Step 5: Implement the repository**

Create `server-ts/src/autopilots/repository.ts`:

```ts
import { toRFC3339, type Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import type { Sealer } from '../integrations/sealing.ts';
import { assertSchedule, nextFireAfter } from './cron.ts';
import { writeAutopilotEvent } from './events.ts';
import { hashToken, newSigningSecret, newWebhookToken, tokenHint } from './signing.ts';

/**
 * Autopilots, their triggers, and the record of what they did.
 *
 * Every method takes the workspace the caller was confirmed in and puts it in
 * the WHERE clause, so a row in another workspace is simply not there
 * (`NotFound`), never "there but forbidden".
 *
 * Secrets: a webhook's token is kept as a hash and its signing secret sealed.
 * Both are returned in plaintext exactly once — from the call that made them
 * — and no read path can produce them again.
 */

export const ASSIGNEE_TYPES = ['agent', 'squad'] as const;
export const EXECUTION_MODES = ['create_issue', 'fixed_issue'] as const;
export const QUOTA_PERIODS = ['none', 'hour', 'day', 'week'] as const;

export type AssigneeType = (typeof ASSIGNEE_TYPES)[number];
export type ExecutionMode = (typeof EXECUTION_MODES)[number];
export type QuotaPeriod = (typeof QUOTA_PERIODS)[number];
export type AutopilotStatus = 'active' | 'paused' | 'archived';
export type RunSource = 'cron' | 'webhook' | 'manual' | 'replay';
export type RunStatus = 'pending' | 'enqueued' | 'skipped' | 'failed';
export type DeliveryStatus = 'accepted' | 'filtered' | 'rejected' | 'failed';
export type MemberRole = 'collaborator' | 'subscriber';

export interface AutopilotDraft {
   name: string;
   description: string | null;
   assigneeType: AssigneeType;
   assigneeId: string;
   promptTemplate: string;
   executionMode: ExecutionMode;
   boardId: string | null;
   issueId: string | null;
   quotaPeriod: QuotaPeriod;
   quotaMax: number | null;
}

export interface Autopilot extends AutopilotDraft {
   id: string;
   workspaceId: string;
   status: AutopilotStatus;
   version: number;
   createdBy: string | null;
   createdAt: string;
   updatedAt: string;
}

export interface AutopilotPatch {
   name?: string;
   description?: string | null;
   assigneeType?: AssigneeType;
   assigneeId?: string;
   promptTemplate?: string;
   executionMode?: ExecutionMode;
   boardId?: string | null;
   issueId?: string | null;
   quotaPeriod?: QuotaPeriod;
   quotaMax?: number | null;
   status?: 'active' | 'paused';
}

export interface AutopilotVersion {
   version: number;
   snapshot: AutopilotDraft;
   createdBy: string | null;
   createdAt: string;
}

export interface AutopilotMember {
   userId: string;
   role: MemberRole;
   createdAt: string;
}

export interface AutopilotTrigger {
   id: string;
   autopilotId: string;
   kind: 'cron' | 'webhook';
   enabled: boolean;
   cronExpression: string | null;
   timezone: string | null;
   nextFireAt: string | null;
   lastFiredAt: string | null;
   tokenHint: string | null;
   eventFilters: string[];
   createdAt: string;
   updatedAt: string;
}

export interface TriggerPatch {
   enabled?: boolean;
   expression?: string;
   timezone?: string;
   eventFilters?: string[];
}

export interface WebhookSecrets {
   token: string;
   signingSecret: string;
}

export interface AutopilotRunRecord {
   id: string;
   autopilotId: string;
   autopilotVersion: number;
   triggerId: string | null;
   source: RunSource;
   status: RunStatus;
   reasonCode: string | null;
   reasonMessage: string | null;
   issueId: string | null;
   runId: string | null;
   taskStatus: string | null;
   slot: string | null;
   requestedBy: string | null;
   createdAt: string;
}

export interface WebhookDeliveryRecord {
   id: string;
   autopilotId: string;
   triggerId: string | null;
   event: string | null;
   status: DeliveryStatus;
   failureReason: string | null;
   autopilotRunId: string | null;
   replayOf: string | null;
   receivedAt: string;
}

/** A definition this workspace cannot hold. `field` is a JSON pointer into the request. */
export class InvalidAutopilot extends Error {
   override readonly name = 'InvalidAutopilot';
   readonly field: string;

   constructor(field: string, message: string) {
      super(message);
      this.field = field;
   }
}

const HISTORY_LIMIT = 100;

type Row = Record<string, unknown>;

export class AutopilotRepository {
   readonly #sql: Sql;
   readonly #sealer: Sealer;
   readonly #clock: () => Date;

   constructor(options: { sql: Sql; sealer: Sealer; clock?: () => Date }) {
      this.#sql = options.sql;
      this.#sealer = options.sealer;
      this.#clock = options.clock ?? (() => new Date());
   }

   /** The workspace an autopilot belongs to, for a route that only has its id. */
   async workspaceOf(autopilotId: string): Promise<string> {
      const [row] = await this.#sql`SELECT workspace_id FROM autopilots WHERE id = ${autopilotId}`;
      if (!row) throw new NotFound();
      return row.workspace_id as string;
   }

   async list(workspaceId: string): Promise<Autopilot[]> {
      const rows = await this.#sql`
         SELECT * FROM autopilots
          WHERE workspace_id = ${workspaceId} AND archived_at IS NULL
          ORDER BY updated_at DESC, id DESC
          LIMIT 500`;
      return rows.map(toAutopilot);
   }

   async get(workspaceId: string, autopilotId: string): Promise<Autopilot> {
      const [row] = await this.#sql`
         SELECT * FROM autopilots WHERE workspace_id = ${workspaceId} AND id = ${autopilotId}`;
      if (!row) throw new NotFound();
      return toAutopilot(row);
   }

   async create(workspaceId: string, draft: AutopilotDraft, actorId: string): Promise<Autopilot> {
      const now = this.#clock().toISOString();
      return this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         await validateDraft(tx, workspaceId, draft);
         const [row] = await tx`
            INSERT INTO autopilots (
               workspace_id, name, description, assignee_type, assignee_id, prompt_template,
               execution_mode, board_id, issue_id, quota_period, quota_max, created_by,
               created_at, updated_at
            ) VALUES (
               ${workspaceId}, ${draft.name}, ${draft.description}, ${draft.assigneeType},
               ${draft.assigneeId}, ${draft.promptTemplate}, ${draft.executionMode},
               ${draft.boardId}, ${draft.issueId}, ${draft.quotaPeriod}, ${draft.quotaMax},
               ${actorId}, ${now}, ${now}
            ) RETURNING *`;
         if (!row) throw new Error('autopilot insert returned no row');
         const autopilot = toAutopilot(row);
         await writeVersion(tx, autopilot, actorId, now);
         await writeAutopilotEvent(tx, {
            workspaceId,
            topic: 'autopilot.created',
            autopilotId: autopilot.id,
            payload: { name: autopilot.name, version: autopilot.version },
            occurredAt: now,
         });
         return autopilot;
      }) as Promise<Autopilot>;
   }

   /**
    * A definition change and a status change in one call.
    *
    * Only the definition bumps the version: pausing is an operating decision,
    * not a new rule, and the versions list is a history of what the
    * autopilot was told to do.
    */
   async update(
      workspaceId: string,
      autopilotId: string,
      patch: AutopilotPatch,
      actorId: string
   ): Promise<Autopilot> {
      const now = this.#clock().toISOString();
      return this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const [locked] = await tx`
            SELECT * FROM autopilots
             WHERE workspace_id = ${workspaceId} AND id = ${autopilotId} AND archived_at IS NULL
             FOR UPDATE`;
         if (!locked) throw new NotFound();
         const current = toAutopilot(locked);
         const before = draftOf(current);
         const next: AutopilotDraft = {
            name: patch.name ?? before.name,
            description: patch.description === undefined ? before.description : patch.description,
            assigneeType: patch.assigneeType ?? before.assigneeType,
            assigneeId: patch.assigneeId ?? before.assigneeId,
            promptTemplate: patch.promptTemplate ?? before.promptTemplate,
            executionMode: patch.executionMode ?? before.executionMode,
            boardId: patch.boardId === undefined ? before.boardId : patch.boardId,
            issueId: patch.issueId === undefined ? before.issueId : patch.issueId,
            quotaPeriod: patch.quotaPeriod ?? before.quotaPeriod,
            quotaMax: patch.quotaMax === undefined ? before.quotaMax : patch.quotaMax,
         };
         const changed = JSON.stringify(next) !== JSON.stringify(before);
         if (changed) await validateDraft(tx, workspaceId, next);
         const status = patch.status ?? current.status;
         const version = changed ? current.version + 1 : current.version;

         const [row] = await tx`
            UPDATE autopilots
               SET name = ${next.name}, description = ${next.description},
                   assignee_type = ${next.assigneeType}, assignee_id = ${next.assigneeId},
                   prompt_template = ${next.promptTemplate}, execution_mode = ${next.executionMode},
                   board_id = ${next.boardId}, issue_id = ${next.issueId},
                   quota_period = ${next.quotaPeriod}, quota_max = ${next.quotaMax},
                   status = ${status}, version = ${version}, updated_at = ${now}
             WHERE id = ${autopilotId}
             RETURNING *`;
         if (!row) throw new NotFound();
         const updated = toAutopilot(row);
         if (changed) await writeVersion(tx, updated, actorId, now);
         // Resuming starts the schedule from now. Without this, every slot
         // that passed while paused would look due, and the first tick after
         // resume would fire one of them as if it were on time.
         if (current.status === 'paused' && status === 'active') {
            await rescheduleCron(tx, autopilotId, new Date(now));
         }
         await writeAutopilotEvent(tx, {
            workspaceId,
            topic: 'autopilot.updated',
            autopilotId,
            payload: { version, status },
            occurredAt: now,
         });
         return updated;
      }) as Promise<Autopilot>;
   }

   async archive(workspaceId: string, autopilotId: string, actorId: string): Promise<void> {
      const now = this.#clock().toISOString();
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const [row] = await tx`
            UPDATE autopilots SET status = 'archived', archived_at = ${now}, updated_at = ${now}
             WHERE workspace_id = ${workspaceId} AND id = ${autopilotId} AND archived_at IS NULL
             RETURNING id`;
         if (!row) throw new NotFound();
         await writeAutopilotEvent(tx, {
            workspaceId,
            topic: 'autopilot.archived',
            autopilotId,
            payload: { archivedBy: actorId },
            occurredAt: now,
         });
      });
   }

   async versions(workspaceId: string, autopilotId: string): Promise<AutopilotVersion[]> {
      await this.get(workspaceId, autopilotId);
      const rows = await this.#sql`
         SELECT version, snapshot, created_by, created_at FROM autopilot_versions
          WHERE workspace_id = ${workspaceId} AND autopilot_id = ${autopilotId}
          ORDER BY version DESC`;
      return rows.map((row) => ({
         version: row.version as number,
         snapshot: row.snapshot as AutopilotDraft,
         createdBy: (row.created_by as string | null) ?? null,
         createdAt: toRFC3339(row.created_at as string) ?? '',
      }));
   }

   async members(workspaceId: string, autopilotId: string): Promise<AutopilotMember[]> {
      const rows = await this.#sql`
         SELECT user_id, role, created_at FROM autopilot_members
          WHERE workspace_id = ${workspaceId} AND autopilot_id = ${autopilotId}
          ORDER BY created_at, user_id`;
      return rows.map(toMember);
   }

   /** Replaces the whole list: the settings form edits it as one thing. */
   async setMembers(
      workspaceId: string,
      autopilotId: string,
      members: { userId: string; role: MemberRole }[]
   ): Promise<AutopilotMember[]> {
      const byUser = new Map(members.map((member) => [member.userId, member.role]));
      const ids = [...byUser.keys()];
      return this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         await lockOwned(tx, workspaceId, autopilotId);
         if (ids.length > 0) {
            const found = await tx`
               SELECT user_id FROM workspace_memberships
                WHERE workspace_id = ${workspaceId} AND user_id = ANY(${ids}::uuid[])`;
            if (found.length !== ids.length) {
               throw new InvalidAutopilot('/members', 'Every member must belong to this workspace.');
            }
         }
         await tx`DELETE FROM autopilot_members WHERE autopilot_id = ${autopilotId}`;
         for (const [userId, role] of byUser) {
            await tx`
               INSERT INTO autopilot_members (workspace_id, autopilot_id, user_id, role)
               VALUES (${workspaceId}, ${autopilotId}, ${userId}, ${role})`;
         }
         const rows = await tx`
            SELECT user_id, role, created_at FROM autopilot_members
             WHERE autopilot_id = ${autopilotId} ORDER BY created_at, user_id`;
         return rows.map(toMember);
      }) as Promise<AutopilotMember[]>;
   }

   async triggers(workspaceId: string, autopilotId: string): Promise<AutopilotTrigger[]> {
      const rows = await this.#sql`
         SELECT * FROM autopilot_triggers
          WHERE workspace_id = ${workspaceId} AND autopilot_id = ${autopilotId}
          ORDER BY created_at, id`;
      return rows.map(toTrigger);
   }

   async addCronTrigger(
      workspaceId: string,
      autopilotId: string,
      input: { expression: string; timezone: string; enabled: boolean }
   ): Promise<AutopilotTrigger> {
      const expression = input.expression.trim();
      assertSchedule(expression, input.timezone);
      const next = input.enabled ? nextFireAfter(expression, input.timezone, this.#clock()) : null;
      return this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         await lockOwned(tx, workspaceId, autopilotId);
         const [row] = await tx`
            INSERT INTO autopilot_triggers (
               workspace_id, autopilot_id, kind, enabled, cron_expression, timezone, next_fire_at
            ) VALUES (
               ${workspaceId}, ${autopilotId}, 'cron', ${input.enabled}, ${expression},
               ${input.timezone}, ${next ? next.toISOString() : null}
            ) RETURNING *`;
         if (!row) throw new Error('trigger insert returned no row');
         return toTrigger(row);
      }) as Promise<AutopilotTrigger>;
   }

   async addWebhookTrigger(
      workspaceId: string,
      autopilotId: string,
      input: { eventFilters: string[]; enabled: boolean }
   ): Promise<{ trigger: AutopilotTrigger; secrets: WebhookSecrets }> {
      const secrets = { token: newWebhookToken(), signingSecret: newSigningSecret() };
      // Sealed before anything is written: a server with no key refuses here
      // (SealingUnavailable) rather than after a half-made trigger exists.
      const sealed = this.#sealer.seal(secrets.signingSecret);
      return this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         await lockOwned(tx, workspaceId, autopilotId);
         const [row] = await tx`
            INSERT INTO autopilot_triggers (
               workspace_id, autopilot_id, kind, enabled, webhook_token_hash,
               webhook_token_hint, signing_secret_sealed, event_filters
            ) VALUES (
               ${workspaceId}, ${autopilotId}, 'webhook', ${input.enabled},
               ${hashToken(secrets.token)}, ${tokenHint(secrets.token)}, ${sealed},
               ${input.eventFilters}::text[]
            ) RETURNING *`;
         if (!row) throw new Error('trigger insert returned no row');
         return { trigger: toTrigger(row), secrets };
      }) as Promise<{ trigger: AutopilotTrigger; secrets: WebhookSecrets }>;
   }

   async updateTrigger(
      workspaceId: string,
      autopilotId: string,
      triggerId: string,
      patch: TriggerPatch
   ): Promise<AutopilotTrigger> {
      return this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const [locked] = await tx`
            SELECT * FROM autopilot_triggers
             WHERE workspace_id = ${workspaceId} AND autopilot_id = ${autopilotId} AND id = ${triggerId}
             FOR UPDATE`;
         if (!locked) throw new NotFound();
         const current = toTrigger(locked);
         const enabled = patch.enabled ?? current.enabled;

         if (current.kind === 'cron') {
            if (patch.eventFilters !== undefined) {
               throw new InvalidAutopilot('/eventFilters', 'A schedule has no event filters.');
            }
            const expression = (patch.expression ?? current.cronExpression ?? '').trim();
            const timezone = patch.timezone ?? current.timezone ?? 'UTC';
            assertSchedule(expression, timezone);
            const next = enabled ? nextFireAfter(expression, timezone, this.#clock()) : null;
            const [row] = await tx`
               UPDATE autopilot_triggers
                  SET enabled = ${enabled}, cron_expression = ${expression}, timezone = ${timezone},
                      next_fire_at = ${next ? next.toISOString() : null}
                WHERE id = ${triggerId} RETURNING *`;
            if (!row) throw new NotFound();
            return toTrigger(row);
         }

         if (patch.expression !== undefined || patch.timezone !== undefined) {
            throw new InvalidAutopilot('/expression', 'A webhook has no schedule.');
         }
         const [row] = await tx`
            UPDATE autopilot_triggers
               SET enabled = ${enabled},
                   event_filters = ${patch.eventFilters ?? current.eventFilters}::text[]
             WHERE id = ${triggerId} RETURNING *`;
         if (!row) throw new NotFound();
         return toTrigger(row);
      }) as Promise<AutopilotTrigger>;
   }

   /** New token and new secret together: a leaked URL and a leaked secret are the same incident. */
   async rotateWebhook(
      workspaceId: string,
      autopilotId: string,
      triggerId: string
   ): Promise<{ trigger: AutopilotTrigger; secrets: WebhookSecrets }> {
      const secrets = { token: newWebhookToken(), signingSecret: newSigningSecret() };
      const sealed = this.#sealer.seal(secrets.signingSecret);
      const [row] = await this.#sql`
         UPDATE autopilot_triggers
            SET webhook_token_hash = ${hashToken(secrets.token)},
                webhook_token_hint = ${tokenHint(secrets.token)},
                signing_secret_sealed = ${sealed}
          WHERE workspace_id = ${workspaceId} AND autopilot_id = ${autopilotId}
            AND id = ${triggerId} AND kind = 'webhook'
          RETURNING *`;
      if (!row) throw new NotFound();
      return { trigger: toTrigger(row), secrets };
   }

   async deleteTrigger(workspaceId: string, autopilotId: string, triggerId: string): Promise<void> {
      const rows = await this.#sql`
         DELETE FROM autopilot_triggers
          WHERE workspace_id = ${workspaceId} AND autopilot_id = ${autopilotId} AND id = ${triggerId}
          RETURNING id`;
      if (rows.length === 0) throw new NotFound();
   }

   async runs(workspaceId: string, autopilotId: string): Promise<AutopilotRunRecord[]> {
      const rows = await this.#sql`
         SELECT ar.*, r.status AS task_status
           FROM autopilot_runs AS ar
           LEFT JOIN runs AS r ON r.id = ar.run_id
          WHERE ar.workspace_id = ${workspaceId} AND ar.autopilot_id = ${autopilotId}
          ORDER BY ar.created_at DESC, ar.id DESC
          LIMIT ${HISTORY_LIMIT}`;
      return rows.map(toRun);
   }

   async deliveries(workspaceId: string, autopilotId: string): Promise<WebhookDeliveryRecord[]> {
      const rows = await this.#sql`
         SELECT id, autopilot_id, trigger_id, event, status, failure_reason,
                autopilot_run_id, replay_of, received_at
           FROM webhook_deliveries
          WHERE workspace_id = ${workspaceId} AND autopilot_id = ${autopilotId}
          ORDER BY received_at DESC, id DESC
          LIMIT ${HISTORY_LIMIT}`;
      return rows.map(toDelivery);
   }

   async deliveryPayload(
      workspaceId: string,
      autopilotId: string,
      deliveryId: string
   ): Promise<{ delivery: WebhookDeliveryRecord; payload: unknown }> {
      const [row] = await this.#sql`
         SELECT * FROM webhook_deliveries
          WHERE workspace_id = ${workspaceId} AND autopilot_id = ${autopilotId} AND id = ${deliveryId}`;
      if (!row) throw new NotFound();
      return { delivery: toDelivery(row), payload: row.payload ?? null };
   }

   /**
    * The trigger a public webhook URL names, with its secret opened.
    *
    * Deliberately not scoped by workspace: the token is the only thing the
    * caller has, and it identifies exactly one trigger by its hash.
    */
   async webhookByToken(
      token: string
   ): Promise<{ trigger: AutopilotTrigger; workspaceId: string; signingSecret: string } | null> {
      const [row] = await this.#sql`
         SELECT * FROM autopilot_triggers
          WHERE webhook_token_hash = ${hashToken(token)} AND kind = 'webhook'`;
      if (!row) return null;
      const signingSecret = this.#sealer.open(Buffer.from(row.signing_secret_sealed as Buffer));
      return { trigger: toTrigger(row), workspaceId: row.workspace_id as string, signingSecret };
   }

   async recordDelivery(input: {
      workspaceId: string;
      autopilotId: string;
      triggerId: string | null;
      event: string | null;
      status: DeliveryStatus;
      payload: unknown;
      failureReason: string | null;
      replayOf: string | null;
   }): Promise<string> {
      const now = this.#clock().toISOString();
      return this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const [row] = await tx`
            INSERT INTO webhook_deliveries (
               workspace_id, autopilot_id, trigger_id, event, status, payload,
               failure_reason, replay_of, received_at
            ) VALUES (
               ${input.workspaceId}, ${input.autopilotId}, ${input.triggerId},
               ${input.event === null ? null : input.event.slice(0, 100)}, ${input.status},
               ${input.payload === null || input.payload === undefined ? null : tx.json(input.payload as never)},
               ${input.failureReason}, ${input.replayOf}, ${now}
            ) RETURNING id`;
         if (!row) throw new Error('delivery insert returned no row');
         await writeAutopilotEvent(tx, {
            workspaceId: input.workspaceId,
            topic: 'autopilot.delivery.received',
            autopilotId: input.autopilotId,
            payload: { deliveryId: row.id as string, status: input.status },
            occurredAt: now,
         });
         return row.id as string;
      }) as Promise<string>;
   }

   async linkDelivery(deliveryId: string, autopilotRunId: string | null, status: DeliveryStatus): Promise<void> {
      await this.#sql`
         UPDATE webhook_deliveries SET autopilot_run_id = ${autopilotRunId}, status = ${status}
          WHERE id = ${deliveryId}`;
   }
}

async function lockOwned(tx: Sql, workspaceId: string, autopilotId: string): Promise<void> {
   const [row] = await tx`
      SELECT id FROM autopilots
       WHERE workspace_id = ${workspaceId} AND id = ${autopilotId} AND archived_at IS NULL
       FOR UPDATE`;
   if (!row) throw new NotFound();
}

/**
 * The checks a CHECK constraint cannot make: that the agent, squad, board or
 * task named belongs to this workspace. A foreign key would accept one from
 * any workspace.
 */
async function validateDraft(tx: Sql, workspaceId: string, draft: AutopilotDraft): Promise<void> {
   if (draft.assigneeType === 'agent') {
      const [agent] = await tx`
         SELECT 1 FROM agents
          WHERE id = ${draft.assigneeId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
      if (!agent) throw new InvalidAutopilot('/assigneeId', 'That agent is not in this workspace.');
   } else {
      // Squads are workstream D's table. Asked about by name first, so a
      // server without it answers a validation error rather than a 500.
      const [table] = await tx`SELECT to_regclass('public.squads') IS NOT NULL AS present`;
      if (!table?.present) {
         throw new InvalidAutopilot('/assigneeType', 'Squads are not available on this server yet.');
      }
      const [squad] = await tx`
         SELECT 1 FROM squads
          WHERE id = ${draft.assigneeId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
      if (!squad) throw new InvalidAutopilot('/assigneeId', 'That squad is not in this workspace.');
   }

   if (draft.executionMode === 'create_issue') {
      if (!draft.boardId || draft.issueId) {
         throw new InvalidAutopilot(
            '/boardId',
            'An autopilot that opens a task per run needs a board, and no fixed task.'
         );
      }
      const [board] = await tx`
         SELECT 1 FROM boards WHERE id = ${draft.boardId} AND workspace_id = ${workspaceId}`;
      if (!board) throw new InvalidAutopilot('/boardId', 'That board is not in this workspace.');
   } else {
      if (!draft.issueId || draft.boardId) {
         throw new InvalidAutopilot(
            '/issueId',
            'An autopilot that works on one task needs that task, and no board.'
         );
      }
      const [issue] = await tx`
         SELECT 1 FROM issues AS issue JOIN boards AS board ON board.id = issue.board_id
          WHERE issue.id = ${draft.issueId} AND board.workspace_id = ${workspaceId}
            AND issue.deleted_at IS NULL`;
      if (!issue) throw new InvalidAutopilot('/issueId', 'That task is not in this workspace.');
   }

   if ((draft.quotaPeriod === 'none') !== (draft.quotaMax === null)) {
      throw new InvalidAutopilot('/quotaMax', 'A quota needs both a period and a limit.');
   }
}

async function writeVersion(tx: Sql, autopilot: Autopilot, actorId: string, now: string): Promise<void> {
   await tx`
      INSERT INTO autopilot_versions (workspace_id, autopilot_id, version, snapshot, created_by, created_at)
      VALUES (${autopilot.workspaceId}, ${autopilot.id}, ${autopilot.version},
              ${tx.json(draftOf(autopilot) as never)}, ${actorId}, ${now})`;
}

async function rescheduleCron(tx: Sql, autopilotId: string, now: Date): Promise<void> {
   const rows = await tx`
      SELECT id, cron_expression, timezone FROM autopilot_triggers
       WHERE autopilot_id = ${autopilotId} AND kind = 'cron' AND enabled`;
   for (const row of rows) {
      const next = nextFireAfter(row.cron_expression as string, row.timezone as string, now);
      await tx`
         UPDATE autopilot_triggers SET next_fire_at = ${next ? next.toISOString() : null}
          WHERE id = ${row.id as string}`;
   }
}

function draftOf(autopilot: Autopilot): AutopilotDraft {
   return {
      name: autopilot.name,
      description: autopilot.description,
      assigneeType: autopilot.assigneeType,
      assigneeId: autopilot.assigneeId,
      promptTemplate: autopilot.promptTemplate,
      executionMode: autopilot.executionMode,
      boardId: autopilot.boardId,
      issueId: autopilot.issueId,
      quotaPeriod: autopilot.quotaPeriod,
      quotaMax: autopilot.quotaMax,
   };
}

function toAutopilot(row: Row): Autopilot {
   return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      assigneeType: row.assignee_type as AssigneeType,
      assigneeId: row.assignee_id as string,
      promptTemplate: row.prompt_template as string,
      executionMode: row.execution_mode as ExecutionMode,
      boardId: (row.board_id as string | null) ?? null,
      issueId: (row.issue_id as string | null) ?? null,
      status: row.status as AutopilotStatus,
      version: row.version as number,
      quotaPeriod: row.quota_period as QuotaPeriod,
      quotaMax: (row.quota_max as number | null) ?? null,
      createdBy: (row.created_by as string | null) ?? null,
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}

function toTrigger(row: Row): AutopilotTrigger {
   return {
      id: row.id as string,
      autopilotId: row.autopilot_id as string,
      kind: row.kind as 'cron' | 'webhook',
      enabled: row.enabled as boolean,
      cronExpression: (row.cron_expression as string | null) ?? null,
      timezone: (row.timezone as string | null) ?? null,
      nextFireAt: toRFC3339(row.next_fire_at as string | null),
      lastFiredAt: toRFC3339(row.last_fired_at as string | null),
      tokenHint: (row.webhook_token_hint as string | null) ?? null,
      eventFilters: (row.event_filters as string[] | null) ?? [],
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}

function toMember(row: Row): AutopilotMember {
   return {
      userId: row.user_id as string,
      role: row.role as MemberRole,
      createdAt: toRFC3339(row.created_at as string) ?? '',
   };
}

function toRun(row: Row): AutopilotRunRecord {
   return {
      id: row.id as string,
      autopilotId: row.autopilot_id as string,
      autopilotVersion: row.autopilot_version as number,
      triggerId: (row.trigger_id as string | null) ?? null,
      source: row.source as RunSource,
      status: row.status as RunStatus,
      reasonCode: (row.reason_code as string | null) ?? null,
      reasonMessage: (row.reason_message as string | null) ?? null,
      issueId: (row.issue_id as string | null) ?? null,
      runId: (row.run_id as string | null) ?? null,
      taskStatus: (row.task_status as string | null) ?? null,
      slot: toRFC3339(row.slot as string | null),
      requestedBy: (row.requested_by as string | null) ?? null,
      createdAt: toRFC3339(row.created_at as string) ?? '',
   };
}

function toDelivery(row: Row): WebhookDeliveryRecord {
   return {
      id: row.id as string,
      autopilotId: row.autopilot_id as string,
      triggerId: (row.trigger_id as string | null) ?? null,
      event: (row.event as string | null) ?? null,
      status: row.status as DeliveryStatus,
      failureReason: (row.failure_reason as string | null) ?? null,
      autopilotRunId: (row.autopilot_run_id as string | null) ?? null,
      replayOf: (row.replay_of as string | null) ?? null,
      receivedAt: toRFC3339(row.received_at as string) ?? '',
   };
}
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `cd /Users/secret/Code/berry-circle/server-ts && pnpm typecheck && BERRY_TEST_DATABASE_URL="$BERRY_TEST_DATABASE_URL" node --test --experimental-strip-types src/autopilots/repository.test.ts`
Expected: typecheck exits 0. With the test DB (migration 100 applied in Task 1, Step 5), all 8 tests pass. Without it, the suite reports `skipped`.

- [ ] **Step 7: Commit**

```bash
git add server-ts/src/autopilots/events.ts server-ts/src/autopilots/test-fixture.ts server-ts/src/autopilots/repository.ts server-ts/src/autopilots/repository.test.ts
git commit -m "feat(server-ts): store autopilots, their triggers and their history"
```

---
### Task 5: `fireAutopilot` — one path for every trigger

**Files:**
- Create: `server-ts/src/autopilots/fire.ts`
- Test: `server-ts/src/autopilots/fire.test.ts`

**Interfaces:**
- Consumes:
  - `IssueRepository.create(params: { boardId; title; description: string | null; status; priority; sortOrder: number; dueDate: string | null; assignee: { type: string; id: string } | null; project: string | null; createdBy: string }): Promise<{ issue: Issue; events }>` from `../core/issues.ts`. `IssueRepository.create` writes its own outbox rows.
  - `renderPrompt` (Task 3), `writeAutopilotEvent` and `RunSource` (Task 4).
  - `NotFound` from `../identity/errors.ts`.
- Produces:
  - `interface AutopilotTaskInput { workspaceId: string; agentId: string; issueId?: string; kind: 'agent'; source: 'autopilot'; prompt?: string; autopilotRunId?: string; priority?: number }`. This is a structural subset of A's `enqueueTask` input.
  - `type EnqueueTask = (sql: Sql, input: AutopilotTaskInput) => Promise<{ runId: string }>`. A's `enqueueTask` is assignable to it.
  - `type ResolveSquadLeader = (sql: Sql, workspaceId: string, squadId: string) => Promise<string | null>`
  - `interface FireDeps { sql: Sql; issues: Pick<IssueRepository, 'create'>; enqueue: EnqueueTask; resolveSquadLeader: ResolveSquadLeader; clock?: () => Date }`
  - `interface FireInput { autopilotId: string; source: RunSource; triggerId?: string | null; slot?: Date | null; payload?: unknown; requestedBy?: string | null }`
  - `interface FireOutcome { autopilotRunId: string; status: 'enqueued' | 'skipped' | 'failed'; reasonCode: string | null; runId: string | null; issueId: string | null }`
  - `type FireFn = (input: FireInput) => Promise<FireOutcome>`
  - `fireAutopilot(deps: FireDeps, input: FireInput): Promise<FireOutcome>`

  Reason codes, a stable vocabulary shown in the UI:

  | Code | Kind |
  |---|---|
  | `ARCHIVED` | skipped |
  | `PAUSED` | skipped |
  | `QUOTA_EXCEEDED` | skipped |
  | `SQUAD_UNAVAILABLE` | failed |
  | `TARGET_MISSING` | failed |
  | `ENQUEUE_FAILED` | failed |

Behaviour:
1. In one transaction, lock the autopilot row and decide whether to skip:
   - archived means skip, for every source;
   - paused means skip, except for `manual`, because a person pressing "run now" means it;
   - a quota counts `pending` and `enqueued` runs since `date_trunc(period, now())`.

   Then insert the `autopilot_runs` row as `pending` or `skipped`. The row exists **before** `enqueue` is called, so A may reference `autopilotRunId`.
2. Resolve the agent: the assignee, or the squad leader through `resolveSquadLeader`.
3. `create_issue` opens a `todo` task on the board, assigned to the agent, created by the requester (or the autopilot's creator), with the rendered prompt as its description. `fixed_issue` uses the stored issue. This goes through `IssueRepository.create` directly, **not** through `mounts/issues.ts`: today only that mount calls `autoDispatch` on an agent-assigned `todo` task (`runs/auto-dispatch.ts`). So the autopilot's own `enqueue` is the task's only run. If A or D moves assignment dispatch into the repository or an `issue.created` consumer, this path would double-queue. Re-check this before Task 9 Step 5, and if it has moved, open the task unassigned and let `enqueue` carry the agent.
4. Call `enqueue(sql, { workspaceId, agentId, issueId, kind: 'agent', source: 'autopilot', prompt, autopilotRunId })`.
5. Settle the row as `enqueued` (with `runId`) or `failed` (with the code), and write `autopilot.run.created`.

- [ ] **Step 1: Write the failing test**

Create `server-ts/src/autopilots/fire.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { IssueRepository } from '../core/issues.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { fireAutopilot, type AutopilotTaskInput, type FireDeps } from './fire.ts';
import { AutopilotRepository, type AutopilotDraft } from './repository.ts';
import { cleanupWorkspace, seedWorkspace, testSealer, type Fixture } from './test-fixture.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('firing an autopilot', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let repo: AutopilotRepository;
   let fixture: Fixture;
   let queued: AutopilotTaskInput[];
   let deps: FireDeps;

   before(async () => {
      sql = openDatabase({ url: url as string });
      repo = new AutopilotRepository({ sql, sealer: testSealer() });
      fixture = await seedWorkspace(sql, 'fire');
   });

   after(async () => {
      await cleanupWorkspace(sql, fixture);
      await closeDatabase(sql);
   });

   beforeEach(() => {
      queued = [];
      deps = {
         sql,
         issues: new IssueRepository(sql),
         // The task queue is workstream A's. What is under test is what the
         // autopilot hands it, so the fake records the call and answers.
         enqueue: async (_sql, input) => {
            queued.push(input);
            return { runId: randomUUID() };
         },
         resolveSquadLeader: async () => null,
      };
   });

   function draft(overrides: Partial<AutopilotDraft> = {}): AutopilotDraft {
      return {
         name: 'Morning report',
         description: null,
         assigneeType: 'agent',
         assigneeId: fixture.agentId,
         promptTemplate: 'Report on {{payload.topic}} from {{trigger.source}}.',
         executionMode: 'create_issue',
         boardId: fixture.boardId,
         issueId: null,
         quotaPeriod: 'none',
         quotaMax: null,
         ...overrides,
      };
   }

   test('a firing opens a task for the agent and queues it with the rendered prompt', async () => {
      const autopilot = await repo.create(fixture.workspaceId, draft(), fixture.userId);
      const outcome = await fireAutopilot(deps, {
         autopilotId: autopilot.id,
         source: 'webhook',
         payload: { topic: 'deploys' },
      });

      assert.equal(outcome.status, 'enqueued');
      assert.equal(queued.length, 1);
      const call = queued[0];
      assert.ok(call);
      assert.equal(call.source, 'autopilot');
      assert.equal(call.kind, 'agent');
      assert.equal(call.agentId, fixture.agentId);
      assert.equal(call.autopilotRunId, outcome.autopilotRunId);
      assert.equal(call.prompt, 'Report on deploys from webhook.');
      assert.equal(call.issueId, outcome.issueId);

      const [issue] = await sql`
         SELECT board_id, status, assignee_type, assignee_id, description FROM issues WHERE id = ${outcome.issueId}`;
      assert.equal(issue?.board_id, fixture.boardId);
      assert.equal(issue?.status, 'todo');
      assert.equal(issue?.assignee_type, 'agent');
      assert.equal(issue?.assignee_id, fixture.agentId);

      const [record] = await sql`SELECT status, run_id FROM autopilot_runs WHERE id = ${outcome.autopilotRunId}`;
      assert.equal(record?.status, 'enqueued');
      assert.equal(record?.run_id, outcome.runId);
      const [event] = await sql`
         SELECT 1 FROM outbox_events WHERE aggregate_id = ${autopilot.id} AND topic = 'autopilot.run.created'`;
      assert.ok(event);
   });

   test('a fixed-task autopilot queues against that task and opens no new one', async () => {
      const issues = new IssueRepository(sql);
      const { issue } = await issues.create({
         boardId: fixture.boardId, title: 'Standing task', description: null, status: 'todo',
         priority: 'none', sortOrder: 0, dueDate: null, assignee: null, project: null,
         createdBy: fixture.userId,
      });
      const autopilot = await repo.create(
         fixture.workspaceId,
         draft({ executionMode: 'fixed_issue', boardId: null, issueId: issue.id }),
         fixture.userId
      );
      const outcome = await fireAutopilot(deps, { autopilotId: autopilot.id, source: 'manual', requestedBy: fixture.userId });
      assert.equal(outcome.status, 'enqueued');
      assert.equal(queued[0]?.issueId, issue.id);
   });

   test('a paused autopilot skips its schedule but still runs when a person asks', async () => {
      const autopilot = await repo.create(fixture.workspaceId, draft(), fixture.userId);
      await repo.update(fixture.workspaceId, autopilot.id, { status: 'paused' }, fixture.userId);

      const scheduled = await fireAutopilot(deps, { autopilotId: autopilot.id, source: 'cron', slot: new Date() });
      assert.equal(scheduled.status, 'skipped');
      assert.equal(scheduled.reasonCode, 'PAUSED');
      assert.equal(queued.length, 0);

      const manual = await fireAutopilot(deps, { autopilotId: autopilot.id, source: 'manual', requestedBy: fixture.userId });
      assert.equal(manual.status, 'enqueued');
   });

   test('a quota of one a day lets the first run through and skips the second', async () => {
      const autopilot = await repo.create(
         fixture.workspaceId,
         draft({ quotaPeriod: 'day', quotaMax: 1 }),
         fixture.userId
      );
      const first = await fireAutopilot(deps, { autopilotId: autopilot.id, source: 'webhook' });
      const second = await fireAutopilot(deps, { autopilotId: autopilot.id, source: 'webhook' });
      assert.equal(first.status, 'enqueued');
      assert.equal(second.status, 'skipped');
      assert.equal(second.reasonCode, 'QUOTA_EXCEEDED');
      assert.equal(queued.length, 1);
   });

   test('a queue that refuses is recorded as a failed run, not thrown at the trigger', async () => {
      const autopilot = await repo.create(fixture.workspaceId, draft(), fixture.userId);
      const refusing: FireDeps = {
         ...deps,
         enqueue: async () => {
            throw new Error('the task already has a run');
         },
      };
      const outcome = await fireAutopilot(refusing, { autopilotId: autopilot.id, source: 'manual', requestedBy: fixture.userId });
      assert.equal(outcome.status, 'failed');
      assert.equal(outcome.reasonCode, 'ENQUEUE_FAILED');
      const [record] = await sql`SELECT reason_message, issue_id FROM autopilot_runs WHERE id = ${outcome.autopilotRunId}`;
      assert.equal(record?.reason_message, 'the task already has a run');
      assert.ok(record?.issue_id, 'the task that was opened is still linked');
   });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/autopilots/fire.test.ts`
Expected: FAIL with `Cannot find module '.../src/autopilots/fire.ts'`.

- [ ] **Step 3: Implement**

Create `server-ts/src/autopilots/fire.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { IssueRepository } from '../core/issues.ts';
import type { Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import { writeAutopilotEvent } from './events.ts';
import type { RunSource } from './repository.ts';
import { renderPrompt } from './template.ts';

/**
 * What happens when an autopilot fires — whichever way it was fired.
 *
 * Schedule, webhook, a person pressing "run now" and a replayed delivery all
 * come through here, so they share one set of rules: an archived autopilot
 * never runs, a paused one runs only by hand, a quota is a quota, and every
 * firing leaves a row saying what became of it.
 *
 * The row is written *before* the task is queued. The queue may want to point
 * back at it, and a crash between the two leaves a `pending` row a person can
 * see rather than a task with no record of why it exists.
 *
 * Nothing here throws for a reason that belongs to the autopilot. A trigger
 * that fired correctly has not failed because the queue said no; the run
 * record says so instead.
 */

/** The subset of workstream A's `enqueueTask` input an autopilot sends. */
export interface AutopilotTaskInput {
   workspaceId: string;
   agentId: string;
   issueId?: string;
   kind: 'agent';
   source: 'autopilot';
   prompt?: string;
   autopilotRunId?: string;
   priority?: number;
}

export type EnqueueTask = (sql: Sql, input: AutopilotTaskInput) => Promise<{ runId: string }>;
export type ResolveSquadLeader = (
   sql: Sql,
   workspaceId: string,
   squadId: string
) => Promise<string | null>;

export interface FireDeps {
   sql: Sql;
   issues: Pick<IssueRepository, 'create'>;
   enqueue: EnqueueTask;
   resolveSquadLeader: ResolveSquadLeader;
   clock?: () => Date;
}

export interface FireInput {
   autopilotId: string;
   source: RunSource;
   triggerId?: string | null;
   slot?: Date | null;
   payload?: unknown;
   requestedBy?: string | null;
}

export interface FireOutcome {
   autopilotRunId: string;
   status: 'enqueued' | 'skipped' | 'failed';
   reasonCode: string | null;
   runId: string | null;
   issueId: string | null;
}

export type FireFn = (input: FireInput) => Promise<FireOutcome>;

interface Reason {
   code: string;
   message: string;
}

interface Admitted {
   id: string;
   workspaceId: string;
   name: string;
   assigneeType: string;
   assigneeId: string;
   promptTemplate: string;
   executionMode: string;
   boardId: string | null;
   issueId: string | null;
   createdBy: string | null;
   skipped: Reason | null;
}

export async function fireAutopilot(deps: FireDeps, input: FireInput): Promise<FireOutcome> {
   const clock = deps.clock ?? (() => new Date());
   const firedAt = clock().toISOString();
   const autopilotRunId = randomUUID();
   const admitted = await admit(deps.sql, input, autopilotRunId, firedAt);
   if (admitted.skipped) {
      return {
         autopilotRunId,
         status: 'skipped',
         reasonCode: admitted.skipped.code,
         runId: null,
         issueId: null,
      };
   }

   let issueId: string | null = admitted.executionMode === 'fixed_issue' ? admitted.issueId : null;
   const fail = (reason: Reason) =>
      settle(deps.sql, admitted, autopilotRunId, firedAt, { status: 'failed', reason, runId: null, issueId });

   try {
      const agentId =
         admitted.assigneeType === 'agent'
            ? admitted.assigneeId
            : await deps.resolveSquadLeader(deps.sql, admitted.workspaceId, admitted.assigneeId);
      if (!agentId) {
         return await fail({
            code: 'SQUAD_UNAVAILABLE',
            message: 'The squad has no agent leading it, so there is nobody to hand the run to.',
         });
      }

      const prompt = renderPrompt(admitted.promptTemplate, {
         autopilot: { id: admitted.id, name: admitted.name },
         trigger: { source: input.source, firedAt },
         payload: input.payload ?? null,
      });

      if (admitted.executionMode === 'create_issue') {
         const owner = input.requestedBy ?? admitted.createdBy;
         if (!owner || !admitted.boardId) {
            return await fail({
               code: 'TARGET_MISSING',
               message: 'The board this autopilot opens tasks on, or the person it opens them as, no longer exists.',
            });
         }
         const created = await deps.issues.create({
            boardId: admitted.boardId,
            title: taskTitle(admitted.name, firedAt),
            description: prompt,
            status: 'todo',
            priority: 'none',
            sortOrder: 0,
            dueDate: null,
            assignee: { type: 'agent', id: agentId },
            project: null,
            createdBy: owner,
         });
         issueId = created.issue.id;
      } else if (!issueId) {
         return await fail({
            code: 'TARGET_MISSING',
            message: 'The task this autopilot works on was deleted.',
         });
      }

      const { runId } = await deps.enqueue(deps.sql, {
         workspaceId: admitted.workspaceId,
         agentId,
         issueId,
         kind: 'agent',
         source: 'autopilot',
         prompt,
         autopilotRunId,
      });
      return await settle(deps.sql, admitted, autopilotRunId, firedAt, {
         status: 'enqueued',
         reason: null,
         runId,
         issueId,
      });
   } catch (error) {
      return await fail({
         code: 'ENQUEUE_FAILED',
         message: error instanceof Error ? error.message : String(error),
      });
   }
}

async function admit(sql: Sql, input: FireInput, autopilotRunId: string, firedAt: string): Promise<Admitted> {
   return sql.begin(async (transaction) => {
      const tx = transaction as unknown as Sql;
      // Locked so two firings counting against one quota see each other.
      const [row] = await tx`SELECT * FROM autopilots WHERE id = ${input.autopilotId} FOR UPDATE`;
      if (!row) throw new NotFound();
      const skipped = await reasonToSkip(tx, row, input.source);
      const workspaceId = row.workspace_id as string;

      await tx`
         INSERT INTO autopilot_runs (
            id, workspace_id, autopilot_id, autopilot_version, trigger_id, source, status,
            reason_code, reason_message, slot, requested_by, created_at
         ) VALUES (
            ${autopilotRunId}, ${workspaceId}, ${row.id as string}, ${row.version as number},
            ${input.triggerId ?? null}, ${input.source}, ${skipped ? 'skipped' : 'pending'},
            ${skipped?.code ?? null}, ${skipped?.message ?? null},
            ${input.slot ? input.slot.toISOString() : null}, ${input.requestedBy ?? null}, ${firedAt}
         )`;
      if (skipped) {
         await writeAutopilotEvent(tx, {
            workspaceId,
            topic: 'autopilot.run.created',
            autopilotId: row.id as string,
            payload: { autopilotRunId, status: 'skipped', reasonCode: skipped.code },
            occurredAt: firedAt,
         });
      }
      return {
         id: row.id as string,
         workspaceId,
         name: row.name as string,
         assigneeType: row.assignee_type as string,
         assigneeId: row.assignee_id as string,
         promptTemplate: row.prompt_template as string,
         executionMode: row.execution_mode as string,
         boardId: (row.board_id as string | null) ?? null,
         issueId: (row.issue_id as string | null) ?? null,
         createdBy: (row.created_by as string | null) ?? null,
         skipped,
      };
   }) as Promise<Admitted>;
}

async function reasonToSkip(
   tx: Sql,
   row: Record<string, unknown>,
   source: RunSource
): Promise<Reason | null> {
   if (row.status === 'archived') return { code: 'ARCHIVED', message: 'The autopilot is archived.' };
   if (row.status === 'paused' && source !== 'manual') {
      return { code: 'PAUSED', message: 'The autopilot is paused.' };
   }
   const period = row.quota_period as string;
   const limit = row.quota_max as number | null;
   if (period !== 'none' && limit !== null) {
      const [used] = await tx`
         SELECT count(*)::int AS n FROM autopilot_runs
          WHERE autopilot_id = ${row.id as string}
            AND status IN ('pending', 'enqueued')
            AND created_at >= date_trunc(${period}::text, now())`;
      if (((used?.n as number | undefined) ?? 0) >= limit) {
         return {
            code: 'QUOTA_EXCEEDED',
            message: `The autopilot has used its ${limit} runs for this ${period}.`,
         };
      }
   }
   return null;
}

async function settle(
   sql: Sql,
   admitted: Admitted,
   autopilotRunId: string,
   firedAt: string,
   result: { status: 'enqueued' | 'failed'; reason: Reason | null; runId: string | null; issueId: string | null }
): Promise<FireOutcome> {
   await sql.begin(async (transaction) => {
      const tx = transaction as unknown as Sql;
      await tx`
         UPDATE autopilot_runs
            SET status = ${result.status},
                reason_code = ${result.reason?.code ?? null},
                reason_message = ${result.reason ? result.reason.message.slice(0, 2000) : null},
                run_id = ${result.runId},
                issue_id = ${result.issueId}
          WHERE id = ${autopilotRunId}`;
      await writeAutopilotEvent(tx, {
         workspaceId: admitted.workspaceId,
         topic: 'autopilot.run.created',
         autopilotId: admitted.id,
         payload: {
            autopilotRunId,
            status: result.status,
            reasonCode: result.reason?.code ?? null,
            runId: result.runId,
            issueId: result.issueId,
         },
         occurredAt: firedAt,
      });
   });
   return {
      autopilotRunId,
      status: result.status,
      reasonCode: result.reason?.code ?? null,
      runId: result.runId,
      issueId: result.issueId,
   };
}

/** `Morning report · 2026-09-10 07:00 UTC` — the name, then when. */
function taskTitle(name: string, firedAt: string): string {
   return `${name} · ${firedAt.slice(0, 16).replace('T', ' ')} UTC`;
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd /Users/secret/Code/berry-circle/server-ts && pnpm typecheck && node --test --experimental-strip-types src/autopilots/fire.test.ts`
Expected: typecheck exits 0. With the test DB, the 5 tests pass. Without it, the suite is skipped.

- [ ] **Step 5: Commit**

```bash
git add server-ts/src/autopilots/fire.ts server-ts/src/autopilots/fire.test.ts
git commit -m "feat(server-ts): fire an autopilot into the task queue"
```

---

### Task 6: The leased cron scheduler beside the dispatcher

**Files:**
- Create: `server-ts/src/runs/scheduler.ts`
- Test: `server-ts/src/runs/scheduler.test.ts`

**Interfaces:**
- Consumes: `FireFn`, `FireInput` and `FireOutcome` (Task 5), `nextFireAfter` and `InvalidSchedule` (Task 2), and `Logger` from `../observability/log.ts`.
- Produces: `class AutopilotScheduler` with:
  - `constructor({ sql, fire, logger, pollMs?, batch?, clock? })`
  - `start(): void`
  - `stop(): Promise<void>`
  - `tick(): Promise<number>`, which returns the number of slots this process claimed and fired.

Claim protocol, one statement per step and no long transaction:
1. Select due cron triggers of active autopilots (`next_fire_at <= now`, `enabled`, `autopilots.status = 'active'`).
2. For each trigger, `INSERT INTO sys_cron_executions (workspace_id, trigger_id, slot) … ON CONFLICT (trigger_id, slot) DO NOTHING RETURNING id`. Only the process that gets a row back fires.
3. Advance `next_fire_at` to the first slot strictly after `max(now, slot)`. The `WHERE` clause includes `next_fire_at = slot`, which makes the advance idempotent across racers. Slots missed while the server was down collapse into one firing, not a burst.
4. The winner calls `fire({ autopilotId, source: 'cron', triggerId, slot })` and stores the returned `autopilotRunId` on its `sys_cron_executions` row.
5. An expression that no longer parses disables its trigger and logs it, so it is not retried every tick.
6. Retention: each tick deletes `sys_cron_executions` rows claimed more than 30 days ago (one statement, capped at 1,000 rows). `next_fire_at` only moves forward, so a pruned slot is never due again and can never be re-claimed. Without this the table gains a row per slot forever, which is over 500k rows a year for one every-minute schedule.

- [ ] **Step 1: Write the failing test**

Create `server-ts/src/runs/scheduler.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { IssueRepository } from '../core/issues.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { fireAutopilot, type FireInput } from '../autopilots/fire.ts';
import { AutopilotRepository } from '../autopilots/repository.ts';
import { cleanupWorkspace, seedWorkspace, testSealer, type Fixture } from '../autopilots/test-fixture.ts';
import { createLogger } from '../observability/log.ts';
import { AutopilotScheduler } from './scheduler.ts';

/**
 * The scheduler's promise is "each slot fires once, on however many
 * servers". That is a property of the unique index and the claim order, so
 * the database is real and two schedulers race for the same slot.
 *
 * Other files' triggers may be due in the same database; every assertion
 * filters to this file's autopilots.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;
const MANUAL = { pollMs: 3_600_000 };

describe('autopilot scheduler', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let repo: AutopilotRepository;
   let fixture: Fixture;
   let fired: FireInput[];

   before(async () => {
      sql = openDatabase({ url: url as string });
      repo = new AutopilotRepository({ sql, sealer: testSealer() });
      fixture = await seedWorkspace(sql, 'sched');
   });

   after(async () => {
      await cleanupWorkspace(sql, fixture);
      await closeDatabase(sql);
   });

   function build(): AutopilotScheduler {
      return new AutopilotScheduler({
         sql,
         logger: createLogger('scheduler-test'),
         ...MANUAL,
         fire: async (input) => {
            fired.push(input);
            return fireAutopilot(
               {
                  sql,
                  issues: new IssueRepository(sql),
                  enqueue: async () => ({ runId: randomUUID() }),
                  resolveSquadLeader: async () => null,
               },
               input
            );
         },
      });
   }

   async function dueAutopilot(): Promise<{ autopilotId: string; triggerId: string }> {
      const autopilot = await repo.create(
         fixture.workspaceId,
         {
            name: `Scheduled ${randomUUID().slice(0, 6)}`, description: null,
            assigneeType: 'agent', assigneeId: fixture.agentId, promptTemplate: 'Tick.',
            executionMode: 'create_issue', boardId: fixture.boardId, issueId: null,
            quotaPeriod: 'none', quotaMax: null,
         },
         fixture.userId
      );
      const trigger = await repo.addCronTrigger(fixture.workspaceId, autopilot.id, {
         expression: '*/5 * * * *', timezone: 'UTC', enabled: true,
      });
      await sql`
         UPDATE autopilot_triggers SET next_fire_at = date_trunc('minute', now()) - interval '5 minutes'
          WHERE id = ${trigger.id}`;
      return { autopilotId: autopilot.id, triggerId: trigger.id };
   }

   test('two schedulers reaching for one due slot fire it exactly once', async () => {
      fired = [];
      const { autopilotId, triggerId } = await dueAutopilot();
      await Promise.all([build().tick(), build().tick()]);

      assert.equal(fired.filter((input) => input.autopilotId === autopilotId).length, 1);
      const claims = await sql`SELECT autopilot_run_id FROM sys_cron_executions WHERE trigger_id = ${triggerId}`;
      assert.equal(claims.length, 1);
      assert.ok(claims[0]?.autopilot_run_id, 'the claim points at the run it produced');

      const [trigger] = await sql`SELECT next_fire_at, last_fired_at FROM autopilot_triggers WHERE id = ${triggerId}`;
      assert.ok(Date.parse(String(trigger?.next_fire_at)) > Date.now(), 'the next slot is in the future');
      assert.ok(trigger?.last_fired_at);

      await build().tick();
      assert.equal(fired.filter((input) => input.autopilotId === autopilotId).length, 1, 'not again');
   });

   test('a paused autopilot is not fired by its schedule', async () => {
      fired = [];
      const { autopilotId } = await dueAutopilot();
      await repo.update(fixture.workspaceId, autopilotId, { status: 'paused' }, fixture.userId);
      await build().tick();
      assert.equal(fired.filter((input) => input.autopilotId === autopilotId).length, 0);
   });

   test('a disabled trigger is not fired', async () => {
      fired = [];
      const { autopilotId, triggerId } = await dueAutopilot();
      await sql`UPDATE autopilot_triggers SET enabled = false WHERE id = ${triggerId}`;
      await build().tick();
      assert.equal(fired.filter((input) => input.autopilotId === autopilotId).length, 0);
   });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/runs/scheduler.test.ts`
Expected: FAIL with `Cannot find module '.../src/runs/scheduler.ts'`.

- [ ] **Step 3: Implement**

Create `server-ts/src/runs/scheduler.ts`:

```ts
import type { Sql } from '../db/pool.ts';
import type { Logger } from '../observability/log.ts';
import { InvalidSchedule, nextFireAfter } from '../autopilots/cron.ts';
import type { FireFn } from '../autopilots/fire.ts';

/**
 * What fires an autopilot's schedule.
 *
 * Lives beside the dispatcher and runs in the same process, for the same
 * reason: it is work the server does on its own clock, and it must be safe
 * with any number of servers doing it at once. The dispatcher gets that from
 * `SKIP LOCKED`; this gets it from `sys_cron_executions`, whose unique
 * `(trigger_id, slot)` lets exactly one insert win per slot. The winner
 * fires; everybody else moves on.
 *
 * The claim is written before the firing. A process that dies between the
 * two leaves a slot claimed and unfired — one missed report — rather than
 * a slot fired twice by the next server to look, which is the failure a
 * person would actually be harmed by.
 *
 * Missed slots (the server was down) collapse into one firing: the next slot
 * is computed from now, not from the last one. An autopilot that wakes up to
 * forty queued "daily summary" tasks is worse than one that skipped a few.
 */

const POLL_MS = 15_000;
const BATCH = 50;

export interface SchedulerOptions {
   sql: Sql;
   fire: FireFn;
   logger: Logger;
   pollMs?: number;
   batch?: number;
   clock?: () => Date;
}

export class AutopilotScheduler {
   readonly #sql: Sql;
   readonly #fire: FireFn;
   readonly #logger: Logger;
   readonly #pollMs: number;
   readonly #batch: number;
   readonly #clock: () => Date;

   #running = false;
   #loop: Promise<void> | null = null;
   #wake: (() => void) | null = null;

   constructor(options: SchedulerOptions) {
      this.#sql = options.sql;
      this.#fire = options.fire;
      this.#logger = options.logger;
      this.#pollMs = options.pollMs ?? POLL_MS;
      this.#batch = options.batch ?? BATCH;
      this.#clock = options.clock ?? (() => new Date());
   }

   start(): void {
      if (this.#running) return;
      this.#running = true;
      this.#loop = this.#poll();
   }

   async stop(): Promise<void> {
      this.#running = false;
      this.#wake?.();
      await this.#loop?.catch(() => undefined);
      this.#loop = null;
   }

   async #poll(): Promise<void> {
      while (this.#running) {
         try {
            await this.tick();
         } catch (error) {
            this.#logger.error('autopilot schedule tick failed', { error: message(error) });
         }
         await this.#sleep(this.#pollMs);
      }
   }

   /** One pass over what is due. Public so tests drive it without a timer. */
   async tick(): Promise<number> {
      const now = this.#clock();
      // Old claims are history nobody reads; next_fire_at only moves forward,
      // so a pruned slot is never due again and cannot be claimed twice.
      await this.#sql`
         DELETE FROM sys_cron_executions
          WHERE id IN (
             SELECT id FROM sys_cron_executions
              WHERE claimed_at < ${now.toISOString()}::timestamptz - interval '30 days'
              ORDER BY claimed_at, id
              LIMIT 1000)`;
      const due = await this.#sql`
         SELECT trigger.id, trigger.workspace_id, trigger.autopilot_id,
                trigger.cron_expression, trigger.timezone, trigger.next_fire_at
           FROM autopilot_triggers AS trigger
           JOIN autopilots AS autopilot ON autopilot.id = trigger.autopilot_id
          WHERE trigger.kind = 'cron' AND trigger.enabled
            AND trigger.next_fire_at <= ${now.toISOString()}
            AND autopilot.status = 'active'
          ORDER BY trigger.next_fire_at ASC
          LIMIT ${this.#batch}`;

      let firedCount = 0;
      for (const row of due) {
         const triggerId = row.id as string;
         try {
            if (await this.#claimAndFire(row, now)) firedCount += 1;
         } catch (error) {
            this.#logger.error('autopilot slot failed', { triggerId, error: message(error) });
         }
      }
      return firedCount;
   }

   async #claimAndFire(row: Record<string, unknown>, now: Date): Promise<boolean> {
      const triggerId = row.id as string;
      const slot = new Date(String(row.next_fire_at));

      let next: Date | null;
      try {
         next = nextFireAfter(row.cron_expression as string, row.timezone as string, now > slot ? now : slot);
      } catch (error) {
         if (!(error instanceof InvalidSchedule)) throw error;
         // Stored before a rule changed, or edited by hand. Retrying it every
         // tick would fill the log with one line forever.
         await this.#sql`UPDATE autopilot_triggers SET enabled = false WHERE id = ${triggerId}`;
         this.#logger.error('disabled an autopilot schedule that no longer reads', { triggerId });
         return false;
      }

      const [claim] = await this.#sql`
         INSERT INTO sys_cron_executions (workspace_id, trigger_id, slot)
         VALUES (${row.workspace_id as string}, ${triggerId}, ${slot.toISOString()})
         ON CONFLICT (trigger_id, slot) DO NOTHING
         RETURNING id`;

      // Every racer advances; the `next_fire_at = slot` guard makes the second
      // one a no-op instead of moving the schedule twice. `last_fired_at` is
      // the slot whoever wins the UPDATE: the slot is claimed by *someone* the
      // moment any racer gets here, and making it conditional on this racer's
      // claim would lose it whenever the loser's UPDATE lands first.
      await this.#sql`
         UPDATE autopilot_triggers
            SET next_fire_at = ${next ? next.toISOString() : null},
                last_fired_at = ${slot.toISOString()}
          WHERE id = ${triggerId} AND next_fire_at = ${slot.toISOString()}`;

      if (!claim) return false;

      const outcome = await this.#fire({
         autopilotId: row.autopilot_id as string,
         source: 'cron',
         triggerId,
         slot,
      });
      await this.#sql`
         UPDATE sys_cron_executions SET autopilot_run_id = ${outcome.autopilotRunId}
          WHERE id = ${claim.id as string}`;
      this.#logger.info('autopilot slot fired', {
         triggerId,
         slot: slot.toISOString(),
         status: outcome.status,
      });
      return true;
   }

   #sleep(ms: number): Promise<void> {
      return new Promise<void>((resolve) => {
         const timer = setTimeout(finish, ms);
         timer.unref?.();
         this.#wake = finish;

         function finish(): void {
            clearTimeout(timer);
            resolve();
         }
      });
   }
}

function message(error: unknown): string {
   return error instanceof Error ? error.message : String(error);
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd /Users/secret/Code/berry-circle/server-ts && pnpm typecheck && node --test --experimental-strip-types src/runs/scheduler.test.ts`
Expected: typecheck exits 0. With the test DB, the 3 tests pass. Without it, the suite is skipped.

- [ ] **Step 5: Commit**

```bash
git add server-ts/src/runs/scheduler.ts server-ts/src/runs/scheduler.test.ts
git commit -m "feat(server-ts): fire each autopilot schedule slot exactly once"
```

---
### Task 7: `/api/v1/autopilots` — management API and cron preview

**Files:**
- Create: `server-ts/src/mounts/autopilots.ts`
- Test: `server-ts/src/mounts/autopilots.test.ts`

**Interfaces:**
- Consumes:
  - `requireSession` and `AuthVariables` from `../auth/middleware.ts`; `SessionService` from `../auth/sessions.ts`.
  - `resolveScoped(sql, userId, workspaceId, required?)` from `./shared.ts`.
  - `json` from `../http/app.ts`; `assertValid` and `fieldError` from `../http/body.ts`; `ApiError` from `../http/errors.ts`.
  - `idempotent(store)` from `../http/idempotent.ts`; `IdempotencyStore` from `../http/idempotency.ts`.
  - `toApiError` from `../identity/errors.ts`; `Permission` from `../identity/roles.ts`; `SealingUnavailable` from `../integrations/sealing.ts`.
  - Task 4's repository, Task 2's `nextFireTimes` and `InvalidSchedule`, and Task 5's `FireFn`.
- Produces:
  - `interface AutopilotMountOptions { sessions: SessionService; sql: Sql; autopilots: AutopilotRepository; fire: FireFn; idempotency: IdempotencyStore; clock?: () => Date }`
  - `autopilotMounts(options): Mount[]`, which registers the prefix `/api/v1/autopilots`
  - `serializeAutopilot(autopilot: Autopilot): Record<string, unknown>`

Routes (all behind a session):

| Method and path | Permission | Answer |
|---|---|---|
| `GET /cron-preview?expression=&timezone=&count=` | session only | `{ expression, timezone, times: string[] }` |
| `GET /?workspaceId=` | `product.read` | `{ nodes: Autopilot[] }` |
| `POST /` (idempotent) | `product.write` | `201 Autopilot` |
| `GET /:id` | `product.read` | `Autopilot & { triggers, members }` |
| `PATCH /:id` | `product.write` | `Autopilot` |
| `DELETE /:id` | `product.write` | `204` |
| `POST /:id/run` (idempotent) | `runs.dispatch` | `202 FireOutcome` |
| `GET /:id/versions` | `product.read` | `{ nodes: AutopilotVersion[] }` |
| `PUT /:id/members` | `product.write` | `{ nodes: Member[] }` |
| `POST /:id/triggers` | `product.write` | `201 { trigger, secrets? }`, with `Cache-Control: no-store` |
| `PATCH /:id/triggers/:triggerId` | `product.write` | `Trigger` |
| `DELETE /:id/triggers/:triggerId` | `product.write` | `204` |
| `POST /:id/triggers/:triggerId/rotate` | `product.write` | `{ trigger, secrets }`, with `no-store` |
| `GET /:id/runs` | `product.read` | `{ nodes: AutopilotRun[] }` |
| `GET /:id/deliveries` | `product.read` | `{ nodes: WebhookDelivery[] }` |
| `GET /:id/deliveries/:deliveryId` | `product.read` | `WebhookDelivery & { payload }` |
| `POST /:id/deliveries/:deliveryId/replay` (idempotent) | `runs.dispatch` | `202 FireOutcome`; `409 DELIVERY_NOT_REPLAYABLE` for a `rejected` delivery |

Error mapping, done once in `mapError`:

| Error | Answer |
|---|---|
| `InvalidAutopilot` | `422` at its `field` |
| `InvalidSchedule` | `422` at `/expression` |
| `SealingUnavailable` | `412 INTEGRATIONS_NOT_CONFIGURED` |
| `NotFound` | `404 "Autopilot not found."` |
| a non-member's workspace `404` | rewritten to the same `"Autopilot not found."`, so another tenant's id and a random id are indistinguishable |

- [ ] **Step 1: Write the failing test**

Create `server-ts/src/mounts/autopilots.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { SessionService } from '../auth/sessions.ts';
import { AutopilotRepository } from '../autopilots/repository.ts';
import type { FireInput, FireOutcome } from '../autopilots/fire.ts';
import { cleanupWorkspace, seedWorkspace, testSealer, type Fixture } from '../autopilots/test-fixture.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { IdempotencyStore } from '../http/idempotency.ts';
import { Registry } from '../http/registry.ts';
import { autopilotMounts } from './autopilots.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('/api/v1/autopilots', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let repo: AutopilotRepository;
   let fixture: Fixture;
   let token: string;
   let fired: FireInput[];

   before(async () => {
      sql = openDatabase({ url: url as string });
      const sessions = new SessionService({ sql, sessionTtlMs: 3_600_000 });
      repo = new AutopilotRepository({ sql, sealer: testSealer() });
      const registry = new Registry();
      registry.registerAll(
         autopilotMounts({
            sessions,
            sql,
            autopilots: repo,
            idempotency: new IdempotencyStore(sql),
            fire: async (input): Promise<FireOutcome> => {
               fired.push(input);
               return { autopilotRunId: randomUUID(), status: 'enqueued', reasonCode: null, runId: randomUUID(), issueId: null };
            },
         })
      );
      app = createApp(registry);
      fixture = await seedWorkspace(sql, 'mount');
      token = (await sessions.issueForUser(fixture.userId)).token;
   });

   after(async () => {
      await cleanupWorkspace(sql, fixture);
      await closeDatabase(sql);
   });

   beforeEach(() => {
      fired = [];
   });

   function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
      return app.request(path, {
         method,
         headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            ...headers,
         },
         ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
   }

   function key(): Record<string, string> {
      return { 'idempotency-key': `test-${randomUUID()}` };
   }

   async function createOne(): Promise<Record<string, unknown>> {
      const response = await call('POST', '/api/v1/autopilots', {
         workspaceId: fixture.workspaceId,
         name: 'Nightly triage',
         assigneeType: 'agent',
         assigneeId: fixture.agentId,
         promptTemplate: 'Triage.',
         executionMode: 'create_issue',
         boardId: fixture.boardId,
      }, key());
      assert.equal(response.status, 201);
      return (await response.json()) as Record<string, unknown>;
   }

   test('an autopilot is created at version 1 and listed in its workspace', async () => {
      const created = await createOne();
      assert.equal(created.version, 1);
      assert.equal(created.status, 'active');
      assert.equal(created.quotaPeriod, 'none');
      const list = await call('GET', `/api/v1/autopilots?workspaceId=${fixture.workspaceId}`);
      const body = (await list.json()) as { nodes: { id: string }[] };
      assert.ok(body.nodes.some((node) => node.id === created.id));
   });

   test('an agent from nowhere is a validation error at the field that named it', async () => {
      const response = await call('POST', '/api/v1/autopilots', {
         workspaceId: fixture.workspaceId, name: 'x', assigneeType: 'agent', assigneeId: randomUUID(),
         promptTemplate: 'x', executionMode: 'create_issue', boardId: fixture.boardId,
      }, key());
      assert.equal(response.status, 422);
      const body = (await response.json()) as { error: { details: { fields: { path: string }[] } } };
      assert.equal(body.error.details.fields[0]?.path, '/assigneeId');
   });

   test('a webhook secret is shown once, never cached, and never read back', async () => {
      const created = await createOne();
      const response = await call('POST', `/api/v1/autopilots/${created.id}/triggers`, {
         kind: 'webhook', eventFilters: ['deploy'],
      });
      assert.equal(response.status, 201);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = (await response.json()) as { secrets: { token: string; signingSecret: string; ingressPath: string } };
      assert.equal(body.secrets.ingressPath, `/api/webhooks/autopilots/${body.secrets.token}`);

      const detail = await (await call('GET', `/api/v1/autopilots/${created.id}`)).text();
      assert.equal(detail.includes(body.secrets.token), false);
      assert.equal(detail.includes(body.secrets.signingSecret), false);
      assert.ok(detail.includes('"tokenHint"'));
   });

   test('the cron preview lists the next firings, and a bad schedule says where it is wrong', async () => {
      const ok = await call('GET', '/api/v1/autopilots/cron-preview?expression=0%209%20*%20*%201-5&timezone=Europe%2FRome&count=3');
      assert.equal(ok.status, 200);
      const body = (await ok.json()) as { times: string[] };
      assert.equal(body.times.length, 3);

      const bad = await call('GET', '/api/v1/autopilots/cron-preview?expression=nope&timezone=UTC');
      assert.equal(bad.status, 422);
      const failure = (await bad.json()) as { error: { details: { fields: { path: string }[] } } };
      assert.equal(failure.error.details.fields[0]?.path, '/expression');
   });

   test('run now fires the autopilot by hand, as the caller', async () => {
      const created = await createOne();
      const response = await call('POST', `/api/v1/autopilots/${created.id}/run`, {}, key());
      assert.equal(response.status, 202);
      assert.deepEqual(fired.map((input) => [input.autopilotId, input.source, input.requestedBy]), [
         [created.id, 'manual', fixture.userId],
      ]);
   });

   test('replaying a delivery fires again with the stored payload and records the replay', async () => {
      const created = await createOne();
      const deliveryId = await repo.recordDelivery({
         workspaceId: fixture.workspaceId, autopilotId: created.id as string, triggerId: null,
         event: 'deploy', status: 'accepted', payload: { build: 7 }, failureReason: null, replayOf: null,
      });
      const response = await call('POST', `/api/v1/autopilots/${created.id}/deliveries/${deliveryId}/replay`, {}, key());
      assert.equal(response.status, 202);
      assert.equal(fired[0]?.source, 'replay');
      assert.deepEqual(fired[0]?.payload, { build: 7 });
      const [replay] = await sql`SELECT status FROM webhook_deliveries WHERE replay_of = ${deliveryId}`;
      assert.equal(replay?.status, 'accepted');

      const detail = await call('GET', `/api/v1/autopilots/${created.id}/deliveries/${deliveryId}`);
      assert.equal(detail.status, 200);
      assert.deepEqual(((await detail.json()) as { payload: unknown }).payload, { build: 7 });
   });

   test('a delivery refused at the signature check cannot be replayed', async () => {
      const created = await createOne();
      const deliveryId = await repo.recordDelivery({
         workspaceId: fixture.workspaceId, autopilotId: created.id as string, triggerId: null,
         event: null, status: 'rejected', payload: null, failureReason: 'SIGNATURE_MISMATCH', replayOf: null,
      });
      const response = await call('POST', `/api/v1/autopilots/${created.id}/deliveries/${deliveryId}/replay`, {}, key());
      assert.equal(response.status, 409);
      assert.equal(fired.length, 0);
   });

   test('pausing then archiving takes it off the list', async () => {
      const created = await createOne();
      const paused = await call('PATCH', `/api/v1/autopilots/${created.id}`, { status: 'paused' });
      assert.equal(((await paused.json()) as { status: string }).status, 'paused');
      assert.equal((await call('DELETE', `/api/v1/autopilots/${created.id}`)).status, 204);
      const list = (await (await call('GET', `/api/v1/autopilots?workspaceId=${fixture.workspaceId}`)).json()) as { nodes: { id: string }[] };
      assert.equal(list.nodes.some((node) => node.id === created.id), false);
   });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/mounts/autopilots.test.ts`
Expected: FAIL with `Cannot find module '.../src/mounts/autopilots.ts'`.

- [ ] **Step 3: Implement the mount**

Create `server-ts/src/mounts/autopilots.ts`:

```ts
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { InvalidSchedule, nextFireTimes } from '../autopilots/cron.ts';
import type { FireFn } from '../autopilots/fire.ts';
import {
   ASSIGNEE_TYPES,
   EXECUTION_MODES,
   InvalidAutopilot,
   QUOTA_PERIODS,
   type Autopilot,
   type AutopilotRepository,
   type AutopilotTrigger,
   type WebhookSecrets,
} from '../autopilots/repository.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { assertValid, fieldError } from '../http/body.ts';
import { ApiError } from '../http/errors.ts';
import { idempotent } from '../http/idempotent.ts';
import type { IdempotencyStore } from '../http/idempotency.ts';
import type { Mount } from '../http/registry.ts';
import { toApiError } from '../identity/errors.ts';
import type { Permission } from '../identity/roles.ts';
import { SealingUnavailable } from '../integrations/sealing.ts';
import { pathId, resolveScoped } from './shared.ts';

/**
 * `/api/v1/autopilots`.
 *
 * Workspace-scoped through `resolveScoped`, the same gate `/search` and
 * `/views` use for a query-parameter workspace. Routes that name an
 * autopilot find its workspace first and then gate on it; a caller who is
 * not a member gets the answer a random id gets, so an id from another
 * workspace cannot be told apart from one that does not exist.
 *
 * Trigger creation and rotation are the only places a token or signing
 * secret leaves the server, and they are deliberately not idempotent: the
 * idempotency store keeps response bodies, and a secret must not be kept.
 */

export interface AutopilotMountOptions {
   sessions: SessionService;
   sql: Sql;
   autopilots: AutopilotRepository;
   fire: FireFn;
   idempotency: IdempotencyStore;
   clock?: () => Date;
}

const UUID = z
   .string()
   .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
   .transform((value) => value.toLowerCase());
const EVENT_NAME = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/);

const draftFields = {
   name: z.string().trim().min(1).max(200),
   description: z.string().max(5000).nullable(),
   assigneeType: z.enum(ASSIGNEE_TYPES),
   assigneeId: UUID,
   promptTemplate: z.string().min(1).max(20000),
   executionMode: z.enum(EXECUTION_MODES),
   boardId: UUID.nullable(),
   issueId: UUID.nullable(),
   quotaPeriod: z.enum(QUOTA_PERIODS),
   quotaMax: z.number().int().min(1).max(10000).nullable(),
};

const createSchema = z.strictObject({
   workspaceId: UUID,
   ...draftFields,
   description: draftFields.description.default(null),
   boardId: draftFields.boardId.default(null),
   issueId: draftFields.issueId.default(null),
   quotaPeriod: draftFields.quotaPeriod.default('none'),
   quotaMax: draftFields.quotaMax.default(null),
});

const patchSchema = z
   .strictObject({ ...draftFields, status: z.enum(['active', 'paused']) })
   .partial();

const triggerSchema = z.discriminatedUnion('kind', [
   z.strictObject({
      kind: z.literal('cron'),
      expression: z.string().min(1).max(200),
      timezone: z.string().min(1).max(100),
      enabled: z.boolean().default(true),
   }),
   z.strictObject({
      kind: z.literal('webhook'),
      eventFilters: z.array(EVENT_NAME).max(50).default([]),
      enabled: z.boolean().default(true),
   }),
]);

const triggerPatchSchema = z
   .strictObject({
      enabled: z.boolean(),
      expression: z.string().min(1).max(200),
      timezone: z.string().min(1).max(100),
      eventFilters: z.array(EVENT_NAME).max(50),
   })
   .partial();

const membersSchema = z.strictObject({
   members: z
      .array(z.strictObject({ userId: UUID, role: z.enum(['collaborator', 'subscriber']) }))
      .max(200),
});

export function autopilotMounts(options: AutopilotMountOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));
   const { autopilots } = options;
   const clock = options.clock ?? (() => new Date());

   /** The workspace an autopilot belongs to, once the caller is proven a member with `required`. */
   async function scopeOf(
      context: Context<{ Variables: AuthVariables }>,
      autopilotId: string,
      required: Permission
   ): Promise<string> {
      const workspaceId = await autopilots.workspaceOf(autopilotId).catch(mapError);
      try {
         await resolveScoped(options.sql, context.get('user').id, workspaceId, required);
      } catch (error) {
         // "Workspace not found" would say the autopilot exists somewhere.
         if (error instanceof ApiError && error.status === 404) throw ApiError.notFound('Autopilot');
         throw error;
      }
      return workspaceId;
   }

   route.get('/cron-preview', (context) => {
      const url = new URL(context.req.url);
      const expression = url.searchParams.get('expression') ?? '';
      const timezone = url.searchParams.get('timezone') ?? 'UTC';
      const count = Number(url.searchParams.get('count') ?? '5');
      try {
         const times = nextFireTimes(expression, timezone, clock(), count);
         return json({ expression, timezone, times: times.map((time) => time.toISOString()) });
      } catch (error) {
         return mapError(error);
      }
   });

   route.get('/', async (context) => {
      const workspaceId = new URL(context.req.url).searchParams.get('workspaceId') ?? '';
      if (!workspaceId) assertValid([fieldError('/workspaceId', 'required', 'workspaceId is required.')]);
      const scoped = await resolveScoped(options.sql, context.get('user').id, workspaceId);
      const nodes = await autopilots.list(scoped.ctx.workspaceId);
      return json({ nodes: nodes.map(serializeAutopilot) });
   });

   route.post('/', idempotent(options.idempotency), async (context) => {
      const body = await readJson(context, createSchema);
      const scoped = await resolveScoped(options.sql, context.get('user').id, body.workspaceId, 'product.write');
      const { workspaceId: _ignored, ...draft } = body;
      const created = await autopilots
         .create(scoped.ctx.workspaceId, draft, context.get('user').id)
         .catch(mapError);
      return json(serializeAutopilot(created), 201);
   });

   route.get('/:autopilotId', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.read');
      const [autopilot, triggers, members] = await Promise.all([
         autopilots.get(workspaceId, id),
         autopilots.triggers(workspaceId, id),
         autopilots.members(workspaceId, id),
      ]).catch(mapError);
      return json({ ...serializeAutopilot(autopilot), triggers: triggers.map(serializeTrigger), members });
   });

   route.patch('/:autopilotId', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.write');
      const patch = await readJson(context, patchSchema);
      const updated = await autopilots.update(workspaceId, id, patch, context.get('user').id).catch(mapError);
      return json(serializeAutopilot(updated));
   });

   route.delete('/:autopilotId', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.write');
      await autopilots.archive(workspaceId, id, context.get('user').id).catch(mapError);
      return new Response(null, { status: 204 });
   });

   route.post('/:autopilotId/run', idempotent(options.idempotency), async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      await scopeOf(context, id, 'runs.dispatch');
      const outcome = await options
         .fire({ autopilotId: id, source: 'manual', requestedBy: context.get('user').id })
         .catch(mapError);
      return json(outcome, 202);
   });

   route.get('/:autopilotId/versions', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.read');
      return json({ nodes: await autopilots.versions(workspaceId, id).catch(mapError) });
   });

   route.put('/:autopilotId/members', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.write');
      const body = await readJson(context, membersSchema);
      return json({ nodes: await autopilots.setMembers(workspaceId, id, body.members).catch(mapError) });
   });

   route.post('/:autopilotId/triggers', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.write');
      const body = await readJson(context, triggerSchema);
      if (body.kind === 'cron') {
         const trigger = await autopilots
            .addCronTrigger(workspaceId, id, {
               expression: body.expression,
               timezone: body.timezone,
               enabled: body.enabled,
            })
            .catch(mapError);
         return json({ trigger: serializeTrigger(trigger) }, 201);
      }
      const made = await autopilots
         .addWebhookTrigger(workspaceId, id, { eventFilters: body.eventFilters, enabled: body.enabled })
         .catch(mapError);
      return secretResponse(made.trigger, made.secrets, 201);
   });

   route.patch('/:autopilotId/triggers/:triggerId', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const triggerId = pathId(context.req.param('triggerId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.write');
      const patch = await readJson(context, triggerPatchSchema);
      const trigger = await autopilots.updateTrigger(workspaceId, id, triggerId, patch).catch(mapError);
      return json(serializeTrigger(trigger));
   });

   route.delete('/:autopilotId/triggers/:triggerId', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const triggerId = pathId(context.req.param('triggerId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.write');
      await autopilots.deleteTrigger(workspaceId, id, triggerId).catch(mapError);
      return new Response(null, { status: 204 });
   });

   route.post('/:autopilotId/triggers/:triggerId/rotate', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const triggerId = pathId(context.req.param('triggerId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.write');
      const made = await autopilots.rotateWebhook(workspaceId, id, triggerId).catch(mapError);
      return secretResponse(made.trigger, made.secrets, 200);
   });

   route.get('/:autopilotId/runs', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.read');
      return json({ nodes: await autopilots.runs(workspaceId, id) });
   });

   route.get('/:autopilotId/deliveries', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.read');
      return json({ nodes: await autopilots.deliveries(workspaceId, id) });
   });

   /** One delivery with the payload it carried, for the deliveries tab. */
   route.get('/:autopilotId/deliveries/:deliveryId', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const deliveryId = pathId(context.req.param('deliveryId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.read');
      const { delivery, payload } = await autopilots.deliveryPayload(workspaceId, id, deliveryId).catch(mapError);
      return json({ ...delivery, payload });
   });

   /**
    * Fires again with what the delivery carried. The signature was checked
    * when it first arrived; a replay is a member of the workspace asking,
    * which is why it needs `runs.dispatch` rather than the secret.
    */
   route.post('/:autopilotId/deliveries/:deliveryId/replay', idempotent(options.idempotency), async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const deliveryId = pathId(context.req.param('deliveryId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'runs.dispatch');
      const { delivery, payload } = await autopilots.deliveryPayload(workspaceId, id, deliveryId).catch(mapError);
      // A rejected delivery was refused at the door — a bad signature, a body
      // that was not a JSON object, or a disabled trigger. Replaying the
      // first would fire on the word of an unverified sender, and the others
      // were refused on purpose. Refused here, not only hidden in the UI.
      if (delivery.status === 'rejected') {
         throw new ApiError(
            409,
            'DELIVERY_NOT_REPLAYABLE',
            'This delivery was refused before it was read, so there is nothing to replay.'
         );
      }
      const replayId = await autopilots.recordDelivery({
         workspaceId,
         autopilotId: id,
         triggerId: delivery.triggerId,
         event: delivery.event,
         status: 'accepted',
         payload,
         failureReason: null,
         replayOf: deliveryId,
      });
      const outcome = await options
         .fire({
            autopilotId: id,
            source: 'replay',
            triggerId: delivery.triggerId,
            payload,
            requestedBy: context.get('user').id,
         })
         .catch(async (error: unknown) => {
            // The replay row exists already; it must not claim `accepted`
            // for a firing that never happened.
            await autopilots.linkDelivery(replayId, null, 'failed');
            return mapError(error);
         });
      await autopilots.linkDelivery(replayId, outcome.autopilotRunId, outcome.status === 'failed' ? 'failed' : 'accepted');
      return json(outcome, 202);
   });

   return [{ prefix: '/api/v1/autopilots', handler: route }];
}

export function serializeAutopilot(autopilot: Autopilot): Record<string, unknown> {
   return {
      id: autopilot.id,
      workspaceId: autopilot.workspaceId,
      name: autopilot.name,
      description: autopilot.description,
      assigneeType: autopilot.assigneeType,
      assigneeId: autopilot.assigneeId,
      promptTemplate: autopilot.promptTemplate,
      executionMode: autopilot.executionMode,
      boardId: autopilot.boardId,
      issueId: autopilot.issueId,
      status: autopilot.status,
      version: autopilot.version,
      quotaPeriod: autopilot.quotaPeriod,
      quotaMax: autopilot.quotaMax,
      createdBy: autopilot.createdBy,
      createdAt: autopilot.createdAt,
      updatedAt: autopilot.updatedAt,
   };
}

function serializeTrigger(trigger: AutopilotTrigger): Record<string, unknown> {
   return {
      id: trigger.id,
      autopilotId: trigger.autopilotId,
      kind: trigger.kind,
      enabled: trigger.enabled,
      cronExpression: trigger.cronExpression,
      timezone: trigger.timezone,
      nextFireAt: trigger.nextFireAt,
      lastFiredAt: trigger.lastFiredAt,
      tokenHint: trigger.tokenHint,
      eventFilters: trigger.eventFilters,
      createdAt: trigger.createdAt,
      updatedAt: trigger.updatedAt,
   };
}

function secretResponse(trigger: AutopilotTrigger, secrets: WebhookSecrets, status: number): Response {
   const response = json(
      {
         trigger: serializeTrigger(trigger),
         secrets: {
            token: secrets.token,
            signingSecret: secrets.signingSecret,
            ingressPath: `/api/webhooks/autopilots/${secrets.token}`,
         },
      },
      status
   );
   response.headers.set('cache-control', 'no-store');
   return response;
}

async function readJson<T extends z.ZodType>(
   context: Context<{ Variables: AuthVariables }>,
   schema: T
): Promise<z.output<T>> {
   let raw: unknown;
   try {
      raw = await context.req.json();
   } catch {
      throw ApiError.badRequest('Request body must be one JSON object.');
   }
   const result = schema.safeParse(raw);
   if (!result.success) {
      assertValid(
         result.error.issues.map((issue) =>
            fieldError(`/${issue.path.map(String).join('/')}`, 'invalid_value', issue.message)
         )
      );
      throw ApiError.badRequest('The request is invalid.');
   }
   return result.data;
}

/** Every domain failure mapped once, here. */
function mapError(error: unknown): never {
   if (error instanceof InvalidAutopilot) {
      assertValid([fieldError(error.field, 'invalid_value', error.message)]);
   }
   if (error instanceof InvalidSchedule) {
      assertValid([fieldError('/expression', 'invalid_value', error.message)]);
   }
   if (error instanceof SealingUnavailable) {
      throw new ApiError(
         412,
         'INTEGRATIONS_NOT_CONFIGURED',
         'This server has no encryption key, so it cannot hold a webhook signing secret.'
      );
   }
   throw toApiError(error, 'Autopilot');
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd /Users/secret/Code/berry-circle/server-ts && pnpm typecheck && node --test --experimental-strip-types src/mounts/autopilots.test.ts`
Expected: typecheck exits 0. With the test DB, the 8 tests pass. Without it, the suite is skipped. If `tsc` rejects `result.data` as `z.output<T>`, use `return result.data as z.output<T>;`, which is the same value narrowed for the generic.

- [ ] **Step 5: Commit**

```bash
git add server-ts/src/mounts/autopilots.ts server-ts/src/mounts/autopilots.test.ts
git commit -m "feat(server-ts): serve autopilots, triggers, runs and deliveries"
```

---
### Task 8: `POST /api/webhooks/autopilots/:token` — public, HMAC-verified ingress

**Files:**
- Create: `server-ts/src/mounts/autopilot-webhooks.ts`
- Test: `server-ts/src/mounts/autopilot-webhooks.test.ts`

**Interfaces:**
- Consumes: from Task 4, `AutopilotRepository.webhookByToken`, `recordDelivery` and `linkDelivery`. From Task 3, `verifySignature`, `validTokenShape`, `SIGNATURE_HEADER` and `EVENT_HEADER`. From Task 5, `FireFn`. Also `json`, `ApiError`, `Mount` and `Logger`.
- Produces:
  - `interface AutopilotWebhookOptions { autopilots: AutopilotRepository; fire: FireFn; logger: Logger }`
  - `autopilotWebhookMounts(options): Mount[]`, with prefix `/api/webhooks/autopilots`. That prefix is disjoint from `/api/v1/webhooks`, and the Next.js rewrite already proxies `/api/*`.

Contract, in order:
1. If the token is malformed or unknown, answer `404 NOT_FOUND "Autopilot webhook not found."`, identically in both cases, and record nothing, because there is no autopilot to record it against.
2. If the body is larger than 256 KiB, answer `413 PAYLOAD_TOO_LARGE`.
3. If the `X-Berry-Signature` header is missing or wrong, answer `401 WEBHOOK_UNVERIFIED` and record a delivery with status `rejected`, reason `SIGNATURE_MISMATCH` and no payload.
4. If the body is not a JSON object, answer `400 WEBHOOK_MALFORMED` and record a `rejected` delivery with reason `MALFORMED`.
5. The event name comes from the `X-Berry-Event` header, else the payload's string `event`, else its `type`. If filters are set and the event is not among them, answer `202 { accepted: false, reason: 'event filtered' }` and record a `filtered` delivery.
6. If the trigger is disabled, answer `202 { accepted: false, reason: 'trigger disabled' }` and record a `rejected` delivery with reason `TRIGGER_DISABLED`.
7. Otherwise, record an `accepted` delivery, then call `fire({ source: 'webhook', triggerId, payload })` and link the resulting run. Answer `202 { accepted: true, autopilotRunId, status }`. If `fire` throws, the delivery becomes `failed`, the error is logged, and the answer is `202 { accepted: false, reason: 'handler failed' }`. Once the signature holds the answer is always 2xx, which is the same reasoning as `mounts/webhooks.ts`.

- [ ] **Step 1: Write the failing test**

Create `server-ts/src/mounts/autopilot-webhooks.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { FireInput } from '../autopilots/fire.ts';
import { AutopilotRepository } from '../autopilots/repository.ts';
import { newWebhookToken, signBody } from '../autopilots/signing.ts';
import { cleanupWorkspace, seedWorkspace, testSealer, type Fixture } from '../autopilots/test-fixture.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { createLogger } from '../observability/log.ts';
import { autopilotWebhookMounts } from './autopilot-webhooks.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('autopilot webhook ingress', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let repo: AutopilotRepository;
   let fixture: Fixture;
   let fired: FireInput[];
   let autopilotId: string;
   let token: string;
   let secret: string;

   before(async () => {
      sql = openDatabase({ url: url as string });
      repo = new AutopilotRepository({ sql, sealer: testSealer() });
      const registry = new Registry();
      registry.registerAll(
         autopilotWebhookMounts({
            autopilots: repo,
            logger: createLogger('autopilot-webhook-test'),
            fire: async (input) => {
               fired.push(input);
               return { autopilotRunId: randomUUID(), status: 'enqueued', reasonCode: null, runId: randomUUID(), issueId: null };
            },
         })
      );
      app = createApp(registry);
      fixture = await seedWorkspace(sql, 'hook');
      const autopilot = await repo.create(fixture.workspaceId, {
         name: 'On deploy', description: null, assigneeType: 'agent', assigneeId: fixture.agentId,
         promptTemplate: 'Check build {{payload.build}}.', executionMode: 'create_issue',
         boardId: fixture.boardId, issueId: null, quotaPeriod: 'none', quotaMax: null,
      }, fixture.userId);
      autopilotId = autopilot.id;
      const made = await repo.addWebhookTrigger(fixture.workspaceId, autopilotId, { eventFilters: ['deploy'], enabled: true });
      token = made.secrets.token;
      secret = made.secrets.signingSecret;
   });

   after(async () => {
      await cleanupWorkspace(sql, fixture);
      await closeDatabase(sql);
   });

   beforeEach(() => {
      fired = [];
   });

   function post(body: string, headers: Record<string, string>, at = token) {
      return app.request(`/api/webhooks/autopilots/${at}`, {
         method: 'POST',
         headers: { 'content-type': 'application/json', ...headers },
         body,
      });
   }

   async function lastDelivery(): Promise<Record<string, unknown> | undefined> {
      const [row] = await sql`
         SELECT status, failure_reason, event, payload FROM webhook_deliveries
          WHERE autopilot_id = ${autopilotId} ORDER BY received_at DESC, id DESC LIMIT 1`;
      return row;
   }

   test('a signed delivery for a wanted event fires the autopilot with its payload', async () => {
      const body = JSON.stringify({ event: 'deploy', build: 12 });
      const response = await post(body, { 'x-berry-signature': signBody(body, secret) });
      assert.equal(response.status, 202);
      assert.equal(((await response.json()) as { accepted: boolean }).accepted, true);
      assert.deepEqual(fired.map((input) => [input.autopilotId, input.source, input.payload]), [
         [autopilotId, 'webhook', { event: 'deploy', build: 12 }],
      ]);
      const delivery = await lastDelivery();
      assert.equal(delivery?.status, 'accepted');
      assert.equal(delivery?.event, 'deploy');
   });

   test('a wrong signature is refused and recorded without its payload', async () => {
      const body = JSON.stringify({ event: 'deploy' });
      const response = await post(body, { 'x-berry-signature': signBody(body, 'whsec_not-the-secret') });
      assert.equal(response.status, 401);
      assert.equal(fired.length, 0);
      const delivery = await lastDelivery();
      assert.equal(delivery?.status, 'rejected');
      assert.equal(delivery?.failure_reason, 'SIGNATURE_MISMATCH');
      assert.equal(delivery?.payload, null);
   });

   test('an event outside the filters is acknowledged and not fired', async () => {
      const body = JSON.stringify({ build: 3 });
      const response = await post(body, { 'x-berry-signature': signBody(body, secret), 'x-berry-event': 'push' });
      assert.equal(response.status, 202);
      assert.equal(((await response.json()) as { accepted: boolean }).accepted, false);
      assert.equal(fired.length, 0);
      assert.equal((await lastDelivery())?.status, 'filtered');
   });

   test('an unknown token and a malformed one get the same 404', async () => {
      const unknown = await post('{}', {}, newWebhookToken());
      const malformed = await post('{}', {}, 'not-a-token');
      assert.equal(unknown.status, 404);
      assert.equal(malformed.status, 404);
      const a = (await unknown.json()) as { error: { code: string; message: string } };
      const b = (await malformed.json()) as { error: { code: string; message: string } };
      assert.deepEqual([a.error.code, a.error.message], [b.error.code, b.error.message]);
   });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/mounts/autopilot-webhooks.test.ts`
Expected: FAIL with `Cannot find module '.../src/mounts/autopilot-webhooks.ts'`.

- [ ] **Step 3: Implement**

Create `server-ts/src/mounts/autopilot-webhooks.ts`:

```ts
import { Hono } from 'hono';
import type { FireFn } from '../autopilots/fire.ts';
import type { AutopilotRepository, AutopilotTrigger } from '../autopilots/repository.ts';
import { EVENT_HEADER, SIGNATURE_HEADER, validTokenShape, verifySignature } from '../autopilots/signing.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import type { Logger } from '../observability/log.ts';

/**
 * `/api/webhooks/autopilots/:token` — another system telling an autopilot
 * to run.
 *
 * Outside `requireSession` for the reason GitHub's route is: the caller is a
 * machine holding a secret, and the HMAC over the raw body is its
 * credential. The token picks the trigger; the signature proves the sender.
 * Neither alone is enough — a URL leaks into logs far more easily than a
 * signing key does.
 *
 * Once the signature holds, the answer is 2xx whatever Berry decides: a
 * sender that is told 5xx retries, and a retry of a delivery Berry chose to
 * ignore gets the same decision forever. What happened is in the delivery
 * log on the autopilot's page instead.
 */

const MAX_BODY_BYTES = 256 * 1024;

export interface AutopilotWebhookOptions {
   autopilots: AutopilotRepository;
   fire: FireFn;
   logger: Logger;
}

export function autopilotWebhookMounts(options: AutopilotWebhookOptions): Mount[] {
   const route = new Hono();
   const { autopilots, logger } = options;

   route.post('/:token', async (context) => {
      const token = context.req.param('token') ?? '';
      // One answer for "no such trigger" and "not even a token", so the
      // route is no oracle for which URLs are live.
      if (!validTokenShape(token)) throw ApiError.notFound('Autopilot webhook');
      const hook = await autopilots.webhookByToken(token);
      if (!hook) throw ApiError.notFound('Autopilot webhook');

      // Refuse an announced oversize body before reading it into memory; the
      // byte count after reading still catches a missing or lying header.
      const announced = Number(context.req.header('content-length') ?? '0');
      if (Number.isFinite(announced) && announced > MAX_BODY_BYTES) {
         throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Webhook body is too large.');
      }
      const raw = await context.req.text();
      if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
         throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Webhook body is too large.');
      }

      const record = (
         trigger: AutopilotTrigger,
         status: 'accepted' | 'filtered' | 'rejected',
         event: string | null,
         payload: unknown,
         failureReason: string | null
      ) =>
         autopilots.recordDelivery({
            workspaceId: hook.workspaceId,
            autopilotId: trigger.autopilotId,
            triggerId: trigger.id,
            event,
            status,
            payload,
            failureReason,
            replayOf: null,
         });

      const signature = context.req.header(SIGNATURE_HEADER) ?? '';
      if (!verifySignature(raw, signature, hook.signingSecret)) {
         await record(hook.trigger, 'rejected', null, null, 'SIGNATURE_MISMATCH');
         logger.error('autopilot webhook signature rejected', { triggerId: hook.trigger.id });
         throw new ApiError(401, 'WEBHOOK_UNVERIFIED', 'Signature does not match.');
      }

      let payload: Record<string, unknown>;
      try {
         const parsed: unknown = JSON.parse(raw);
         if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
         payload = parsed as Record<string, unknown>;
      } catch {
         await record(hook.trigger, 'rejected', null, null, 'MALFORMED');
         throw new ApiError(400, 'WEBHOOK_MALFORMED', 'Webhook body is not a JSON object.');
      }

      const event = eventName(context.req.header(EVENT_HEADER), payload);
      const filters = hook.trigger.eventFilters;
      if (filters.length > 0 && (event === null || !filters.includes(event))) {
         await record(hook.trigger, 'filtered', event, payload, null);
         return json({ accepted: false, reason: 'event filtered' }, 202);
      }
      if (!hook.trigger.enabled) {
         await record(hook.trigger, 'rejected', event, payload, 'TRIGGER_DISABLED');
         return json({ accepted: false, reason: 'trigger disabled' }, 202);
      }

      const deliveryId = await record(hook.trigger, 'accepted', event, payload, null);
      try {
         const outcome = await options.fire({
            autopilotId: hook.trigger.autopilotId,
            source: 'webhook',
            triggerId: hook.trigger.id,
            payload,
         });
         await autopilots.linkDelivery(
            deliveryId,
            outcome.autopilotRunId,
            outcome.status === 'failed' ? 'failed' : 'accepted'
         );
         return json({ accepted: true, autopilotRunId: outcome.autopilotRunId, status: outcome.status }, 202);
      } catch (error) {
         await autopilots.linkDelivery(deliveryId, null, 'failed');
         logger.error('autopilot webhook handling failed', {
            triggerId: hook.trigger.id,
            error: error instanceof Error ? error.message : String(error),
         });
         return json({ accepted: false, reason: 'handler failed' }, 202);
      }
   });

   return [{ prefix: '/api/webhooks/autopilots', handler: route }];
}

function eventName(header: string | undefined, payload: Record<string, unknown>): string | null {
   const candidates = [header, payload.event, payload.type];
   for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim().slice(0, 100);
   }
   return null;
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd /Users/secret/Code/berry-circle/server-ts && pnpm typecheck && node --test --experimental-strip-types src/mounts/autopilot-webhooks.test.ts`
Expected: typecheck exits 0. With the test DB, the 4 tests pass. Without it, the suite is skipped.

- [ ] **Step 5: Commit**

```bash
git add server-ts/src/mounts/autopilot-webhooks.ts server-ts/src/mounts/autopilot-webhooks.test.ts
git commit -m "feat(server-ts): accept signed webhooks that fire an autopilot"
```

---

### Task 9: Isolation tests, the workspace stream, squads, and wiring

**Precondition:** workstream A is merged into this branch. Check with `test -f /Users/secret/Code/berry-circle/server-ts/src/runs/queue.ts && echo present`. If the command prints nothing, stop, and report Task 9 as blocked on A. Steps 1–4 do not need A, and may be done and committed first.

**Files:**
- Create: `server-ts/src/mounts/autopilots.cross-tenant.test.ts`
- Modify: `server-ts/src/realtime/replay.ts` (`WORKSPACE_TOPICS`)
- Create: `server-ts/src/realtime/replay.autopilot-topics.test.ts`
- Create: `server-ts/src/autopilots/squads.ts`, `server-ts/src/autopilots/squads.test.ts`
- Modify: `server-ts/src/index.ts`
- Modify: `server-ts/SCOPE.md`

**Interfaces:**
- Consumes:
  - `enqueueTask` from `./runs/queue.ts`, owned by A, which must be assignable to `EnqueueTask`.
  - `AUTOPILOT_TOPICS` (Task 4), `autopilotMounts` (Task 7), `autopilotWebhookMounts` (Task 8), `AutopilotScheduler` (Task 6) and `fireAutopilot` (Task 5).
  - `sealerFromKey` and `unavailableSealer` from `./integrations/sealing.ts`.
- Produces: `resolveSquadLeader(sql: Sql, workspaceId: string, squadId: string): Promise<string | null>`, exported from `server-ts/src/autopilots/squads.ts`.

- [ ] **Step 1: Write the failing topic test**

Create `server-ts/src/realtime/replay.autopilot-topics.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTOPILOT_TOPICS } from '../autopilots/events.ts';
import { WORKSPACE_TOPICS } from './replay.ts';

test('every autopilot fact reaches the workspace stream', () => {
   // The replay matches topics exactly: a topic missing from the list is a
   // fact that is written and never arrives.
   for (const topic of AUTOPILOT_TOPICS) {
      assert.ok((WORKSPACE_TOPICS as readonly string[]).includes(topic), topic);
   }
});
```

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/realtime/replay.autopilot-topics.test.ts`
Expected: FAIL with `AssertionError ... autopilot.created`.

- [ ] **Step 2: Add the topics to the workspace replay**

In `server-ts/src/realtime/replay.ts`, inside `WORKSPACE_TOPICS`, after the line `'artifact.created',`, add:

```ts
   'autopilot.created', 'autopilot.updated', 'autopilot.archived',
   'autopilot.run.created', 'autopilot.delivery.received',
```

Run the topic test again. Expected: PASS.

- [ ] **Step 3: Write the cross-tenant test**

Create `server-ts/src/mounts/autopilots.cross-tenant.test.ts`:

```ts
// Cross-tenant leakage for /api/v1/autopilots — the four guarantees of
// cross-tenant-leakage.test.ts, asserted for the new mount: U1 (member of W1
// only) never sees, reads, changes or fires W2's autopilot, and an
// unauthenticated caller is refused before any handler runs.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { SessionService } from '../auth/sessions.ts';
import type { FireInput } from '../autopilots/fire.ts';
import { AutopilotRepository } from '../autopilots/repository.ts';
import { cleanupWorkspace, seedWorkspace, testSealer, type Fixture } from '../autopilots/test-fixture.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { IdempotencyStore } from '../http/idempotency.ts';
import { Registry } from '../http/registry.ts';
import { autopilotMounts } from './autopilots.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('autopilots: cross-tenant leakage', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let w1: Fixture;
   let w2: Fixture;
   let u1Token: string;
   let w1AutopilotId: string;
   let w2AutopilotId: string;
   let w2TriggerId: string;
   let w2DeliveryId: string;
   const fired: FireInput[] = [];

   before(async () => {
      sql = openDatabase({ url: url as string });
      const sessions = new SessionService({ sql, sessionTtlMs: 3_600_000 });
      const repo = new AutopilotRepository({ sql, sealer: testSealer() });
      const registry = new Registry();
      registry.registerAll(
         autopilotMounts({
            sessions, sql, autopilots: repo, idempotency: new IdempotencyStore(sql),
            fire: async (input) => {
               fired.push(input);
               return { autopilotRunId: randomUUID(), status: 'enqueued', reasonCode: null, runId: null, issueId: null };
            },
         })
      );
      app = createApp(registry);
      w1 = await seedWorkspace(sql, 'leak-1');
      w2 = await seedWorkspace(sql, 'leak-2');
      u1Token = (await sessions.issueForUser(w1.userId)).token;
      const draft = (fixture: Fixture) => ({
         name: `Pilot ${fixture.workspaceId.slice(0, 4)}`, description: null, assigneeType: 'agent' as const,
         assigneeId: fixture.agentId, promptTemplate: 'Go.', executionMode: 'create_issue' as const,
         boardId: fixture.boardId, issueId: null, quotaPeriod: 'none' as const, quotaMax: null,
      });
      w1AutopilotId = (await repo.create(w1.workspaceId, draft(w1), w1.userId)).id;
      w2AutopilotId = (await repo.create(w2.workspaceId, draft(w2), w2.userId)).id;
      w2TriggerId = (
         await repo.addWebhookTrigger(w2.workspaceId, w2AutopilotId, { eventFilters: [], enabled: true })
      ).trigger.id;
      w2DeliveryId = await repo.recordDelivery({
         workspaceId: w2.workspaceId, autopilotId: w2AutopilotId, triggerId: w2TriggerId, event: 'deploy',
         status: 'accepted', payload: { owner: 'w2' }, failureReason: null, replayOf: null,
      });
   });

   after(async () => {
      await cleanupWorkspace(sql, w1);
      await cleanupWorkspace(sql, w2);
      await closeDatabase(sql);
   });

   function asU1(method: string, path: string, body?: unknown) {
      return app.request(path, {
         method,
         headers: {
            authorization: `Bearer ${u1Token}`,
            'content-type': 'application/json',
            'idempotency-key': `leak-${randomUUID()}`,
         },
         ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
   }

   test('(a) listing W1 never shows W2, and listing W2 is refused', async () => {
      const mine = (await (await asU1('GET', `/api/v1/autopilots?workspaceId=${w1.workspaceId}`)).json()) as { nodes: { id: string }[] };
      assert.ok(mine.nodes.some((node) => node.id === w1AutopilotId));
      assert.equal(mine.nodes.some((node) => node.id === w2AutopilotId), false);
      assert.equal((await asU1('GET', `/api/v1/autopilots?workspaceId=${w2.workspaceId}`)).status, 404);
   });

   test("(b) W2's autopilot reads exactly like one that does not exist", async () => {
      const theirs = await asU1('GET', `/api/v1/autopilots/${w2AutopilotId}`);
      const nobody = await asU1('GET', `/api/v1/autopilots/${randomUUID()}`);
      assert.equal(theirs.status, 404);
      assert.equal(nobody.status, 404);
      const a = (await theirs.json()) as { error: { code: string; message: string } };
      const b = (await nobody.json()) as { error: { code: string; message: string } };
      assert.deepEqual([a.error.code, a.error.message], [b.error.code, b.error.message]);
      for (const sub of ['runs', 'deliveries', 'versions', `deliveries/${w2DeliveryId}`]) {
         assert.equal((await asU1('GET', `/api/v1/autopilots/${w2AutopilotId}/${sub}`)).status, 404, sub);
      }
   });

   test('(c) changing, firing or adding a trigger to W2 is 404 and changes nothing', async () => {
      assert.equal((await asU1('PATCH', `/api/v1/autopilots/${w2AutopilotId}`, { name: 'pwned' })).status, 404);
      assert.equal((await asU1('POST', `/api/v1/autopilots/${w2AutopilotId}/run`, {})).status, 404);
      assert.equal((await asU1('POST', `/api/v1/autopilots/${w2AutopilotId}/triggers`, { kind: 'webhook' })).status, 404);
      assert.equal((await asU1('DELETE', `/api/v1/autopilots/${w2AutopilotId}`)).status, 404);
      assert.equal(
         (await asU1('PUT', `/api/v1/autopilots/${w2AutopilotId}/members`, { members: [{ userId: w1.userId, role: 'subscriber' }] })).status,
         404
      );
      const w2Members = await sql`SELECT 1 FROM autopilot_members WHERE autopilot_id = ${w2AutopilotId}`;
      assert.equal(w2Members.length, 0, 'W1 cannot subscribe itself to W2');
      assert.equal(fired.some((input) => input.autopilotId === w2AutopilotId), false);
      const [row] = await sql`SELECT name, status FROM autopilots WHERE id = ${w2AutopilotId}`;
      assert.notEqual(row?.name, 'pwned');
      assert.equal(row?.status, 'active');
      const triggers = await sql`SELECT 1 FROM autopilot_triggers WHERE autopilot_id = ${w2AutopilotId}`;
      assert.equal(triggers.length, 1, 'only the trigger W2 made itself');
   });

   test("(e) W2's trigger and delivery ids are unreachable through W1's own autopilot", async () => {
      const mine = `/api/v1/autopilots/${w1AutopilotId}`;
      assert.equal((await asU1('PATCH', `${mine}/triggers/${w2TriggerId}`, { enabled: false })).status, 404);
      assert.equal((await asU1('POST', `${mine}/triggers/${w2TriggerId}/rotate`)).status, 404);
      assert.equal((await asU1('DELETE', `${mine}/triggers/${w2TriggerId}`)).status, 404);
      assert.equal((await asU1('GET', `${mine}/deliveries/${w2DeliveryId}`)).status, 404);
      assert.equal((await asU1('POST', `${mine}/deliveries/${w2DeliveryId}/replay`, {})).status, 404);
      const [trigger] = await sql`SELECT enabled FROM autopilot_triggers WHERE id = ${w2TriggerId}`;
      assert.equal(trigger?.enabled, true);
      assert.equal(fired.length, 0);
      const replays = await sql`SELECT 1 FROM webhook_deliveries WHERE replay_of = ${w2DeliveryId}`;
      assert.equal(replays.length, 0);
   });

   test('(d) no session, no answer', async () => {
      const response = await app.request(`/api/v1/autopilots?workspaceId=${w1.workspaceId}`);
      assert.equal(response.status, 401);
   });

   // Property (spec §11 "added to the cross-tenant leakage property tests"),
   // in the style of workspace-reads.absent.property.test.ts: for any read
   // sub-route, W2's autopilot id and a random id answer the same 404 envelope.
   test('(P) any read of W2 is indistinguishable from a random id', async () => {
      const subs = ['', '/runs', '/deliveries', '/versions'];
      await fc.assert(
         fc.asyncProperty(fc.constantFrom(...subs), fc.uuid(), async (sub, random) => {
            const theirs = await asU1('GET', `/api/v1/autopilots/${w2AutopilotId}${sub}`);
            const nobody = await asU1('GET', `/api/v1/autopilots/${random}${sub}`);
            const a = (await theirs.json()) as { error: { code: string; message: string } };
            const b = (await nobody.json()) as { error: { code: string; message: string } };
            return (
               theirs.status === 404 &&
               nobody.status === 404 &&
               a.error.code === b.error.code &&
               a.error.message === b.error.message
            );
         }),
         { numRuns: 100 }
      );
   });
});
```

Add `import fc from 'fast-check';` to this file's imports (it is already a server dev dependency, used by `workspace-reads.absent.property.test.ts`).

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/mounts/autopilots.cross-tenant.test.ts`
Expected: with the test DB, PASS (6 tests), since Task 7 already routes every id through `scopeOf` and every repository method puts the workspace and autopilot in its `WHERE`. Without it, the suite is skipped. If (b) fails on the message, `scopeOf`'s 404 rewrite is missing: fix it in `mounts/autopilots.ts`, not in the test.

- [ ] **Step 4: Squad leader resolver**

Create `server-ts/src/autopilots/squads.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { resolveSquadLeader } from './squads.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('squad leader', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   before(() => {
      sql = openDatabase({ url: url as string });
   });
   after(async () => {
      await closeDatabase(sql);
   });

   test('a squad that does not exist — or a server without squads — has nobody leading it', async () => {
      assert.equal(await resolveSquadLeader(sql, randomUUID(), randomUUID()), null);
   });
});
```

Create `server-ts/src/autopilots/squads.ts`:

```ts
import type { Sql } from '../db/pool.ts';

/**
 * Who runs an autopilot assigned to a squad: its leading agent.
 *
 * Squads are workstream D's table (migration 088, `leader_agent_id NOT NULL`).
 * This reads it only if it is there, so a server without D's migration — or a
 * squad since archived — answers null, and the firing records
 * SQUAD_UNAVAILABLE rather than failing the whole request.
 */
export async function resolveSquadLeader(
   sql: Sql,
   workspaceId: string,
   squadId: string
): Promise<string | null> {
   const [column] = await sql`
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'squads' AND column_name = 'leader_agent_id'`;
   if (!column) return null;
   const [row] = await sql`
      SELECT leader_agent_id FROM squads
       WHERE id = ${squadId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
   return (row?.leader_agent_id as string | null | undefined) ?? null;
}
```

Run: `cd /Users/secret/Code/berry-circle/server-ts && pnpm typecheck && node --test --experimental-strip-types src/autopilots/squads.test.ts src/realtime/replay.autopilot-topics.test.ts`
Expected: PASS, or skipped for the DB-backed file.

Commit:

```bash
git add server-ts/src/realtime/replay.ts server-ts/src/realtime/replay.autopilot-topics.test.ts server-ts/src/mounts/autopilots.cross-tenant.test.ts server-ts/src/autopilots/squads.ts server-ts/src/autopilots/squads.test.ts
git commit -m "feat(server-ts): stream autopilot events and prove the mount stays in its workspace"
```

- [ ] **Step 5: Wire the composition root (needs A)**

In `server-ts/src/index.ts`:

1. Add these lines to the import block, after `import { sealerFromKey } from './integrations/sealing.ts';`, and change that line so it also imports `unavailableSealer`:

```ts
import { sealerFromKey, unavailableSealer } from './integrations/sealing.ts';
import { AutopilotRepository } from './autopilots/repository.ts';
import { fireAutopilot, type FireInput } from './autopilots/fire.ts';
import { resolveSquadLeader } from './autopilots/squads.ts';
import { autopilotMounts } from './mounts/autopilots.ts';
import { autopilotWebhookMounts } from './mounts/autopilot-webhooks.ts';
import { AutopilotScheduler } from './runs/scheduler.ts';
import { enqueueTask } from './runs/queue.ts';
```

2. Directly after `registry.registerAll(commentMounts(commentOptions));`, add:

```ts
/**
 * Autopilots. Always served: reading and editing them needs no model
 * credential. A webhook trigger needs the encryption key for its signing
 * secret, and without one the create answers 412 rather than storing a
 * secret in the clear.
 */
const autopilots = new AutopilotRepository({
   sql,
   sealer: config.integrationKey
      ? sealerFromKey(config.integrationKey)
      : unavailableSealer('INTEGRATION_ENCRYPTION_KEY is not set'),
});
const fireAutopilotNow = (input: FireInput) =>
   fireAutopilot({ sql, issues, enqueue: enqueueTask, resolveSquadLeader }, input);
registry.registerAll(
   autopilotMounts({ sessions, sql, autopilots, fire: fireAutopilotNow, idempotency })
);
registry.registerAll(autopilotWebhookMounts({ autopilots, fire: fireAutopilotNow, logger }));
```

3. Directly after `dispatcher?.start();`, add:

```ts
// Schedules fire only where tasks can run: a schedule on a server with no
// dispatcher would queue work nothing takes. Several servers may run this;
// sys_cron_executions lets exactly one fire each slot.
const autopilotScheduler = dispatcher
   ? new AutopilotScheduler({ sql, fire: fireAutopilotNow, logger })
   : null;
autopilotScheduler?.start();
```

4. In the shutdown handler, change `void (dispatcher ? dispatcher.stop() : Promise.resolve())` to:

```ts
         void Promise.all([
            dispatcher ? dispatcher.stop() : Promise.resolve(),
            autopilotScheduler ? autopilotScheduler.stop() : Promise.resolve(),
         ])
```

Leave the `.then(() => closeDatabase(sql))` chain that follows unchanged.

5. In the `logger.info('Berry server listening', { … })` object, add one field after `runDispatch`:

```ts
   autopilotSchedules: autopilotScheduler ? 'on' : 'off',
```

Run: `cd /Users/secret/Code/berry-circle/server-ts && pnpm typecheck`
Expected: exit 0. If `tsc` reports that `enqueueTask` is not assignable to `EnqueueTask`, A's signature has drifted from the shared contract. Stop and raise it with A's owner; do not widen `AutopilotTaskInput`.

- [ ] **Step 6: Update `SCOPE.md`**

In `server-ts/SCOPE.md`, in the "Served" code block, add `/api/v1/autopilots` in alphabetical position after `/api/v1/auth`. After the block's closing fence, add this line:

```
Public, outside `/api/v1`: `/api/webhooks/autopilots/:token` (HMAC-signed autopilot triggers).
```

In the "Not served" table, leave the Automations row alone: autopilots do not bring back `/api/v1/workflows` or `/api/v1/hooks`.

- [ ] **Step 7: Run the whole server gate**

Run: `cd /Users/secret/Code/berry-circle && pnpm typecheck:server && pnpm test:server`
Expected: exit 0 for both. Offline, the DB suites are reported as skipped. Then run `grep -rhoE "prefix: '/[^']+'" server-ts/src/mounts/*.ts | sort -u`. Expected: the output includes `/api/v1/autopilots` and `/api/webhooks/autopilots`.

- [ ] **Step 8: Commit**

```bash
git add server-ts/src/index.ts server-ts/SCOPE.md
git commit -m "feat(server-ts): serve autopilots and start their schedule beside the dispatcher"
```

---
### Task 10: Frontend API client and hooks

**Files:**
- Create: `frontend/lib/autopilots.ts`
- Create: `frontend/hooks/use-autopilots.ts`
- Create: `frontend/hooks/use-autopilot.ts`

**Interfaces:**
- Consumes:
  - `apiFetch` and `BerryApiError` from `@/lib/api`.
  - `newIdempotencyKey` from `@/lib/api-schemas`.
  - `subscribeWorkspaceEvents` and `EventEnvelope` from `@/lib/events`.
  - `useSessionStore` from `@/store/session-store`, which exposes `status` and `workspace?.id`.
  - The wire shapes defined above.
- Produces:
  - Types: `Autopilot`, `AutopilotDetail`, `AutopilotTrigger`, `AutopilotRun`, `WebhookDelivery`, `WebhookSecrets`, `FireOutcome`, `AutopilotDraft`, `AutopilotPatch`.
  - Autopilot calls: `listAutopilots(workspaceId)`, `getAutopilot(id, signal?)`, `createAutopilot(workspaceId, draft)`, `updateAutopilot(id, patch)`, `archiveAutopilot(id)`, `runAutopilot(id)`.
  - Trigger calls: `previewCron(expression, timezone, count?)`, `addCronTrigger(id, { expression, timezone })`, `addWebhookTrigger(id, eventFilters)`, `updateTrigger(id, triggerId, patch)`, `deleteTrigger(id, triggerId)`, `rotateWebhook(id, triggerId)`.
  - History calls: `listAutopilotRuns(id)`, `listWebhookDeliveries(id)`, `getWebhookDelivery(id, deliveryId)` (with payload), `replayDelivery(id, deliveryId)`.
  - Helpers: `describeAutopilotFailure(error)` and `isAutopilotEvent(event, autopilotId?)`.
  - `useAutopilots(): { autopilots; error; loaded; reload }` and `useAutopilot(id): { autopilot; runs; deliveries; error; loading; reload }`.

The frontend has no test runner, so this task's gate is lint plus build.

- [ ] **Step 1: Write `frontend/lib/autopilots.ts`**

```ts
import { z } from 'zod';
import { BerryApiError, apiFetch } from './api';
import { newIdempotencyKey } from './api-schemas';
import type { EventEnvelope } from './events';

/**
 * Autopilots: an agent, a prompt, and what makes it run — a schedule, a
 * signed webhook, or a person pressing "run now". Each firing becomes one
 * agent task. Shapes mirror `server-ts/src/mounts/autopilots.ts`.
 */

export const ASSIGNEE_TYPES = ['agent', 'squad'] as const;
export const EXECUTION_MODES = ['create_issue', 'fixed_issue'] as const;
export const QUOTA_PERIODS = ['none', 'hour', 'day', 'week'] as const;

export const autopilotSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   name: z.string(),
   description: z.string().nullable(),
   assigneeType: z.enum(ASSIGNEE_TYPES),
   assigneeId: z.string(),
   promptTemplate: z.string(),
   executionMode: z.enum(EXECUTION_MODES),
   boardId: z.string().nullable(),
   issueId: z.string().nullable(),
   status: z.enum(['active', 'paused', 'archived']),
   version: z.number(),
   quotaPeriod: z.enum(QUOTA_PERIODS),
   quotaMax: z.number().nullable(),
   createdBy: z.string().nullable(),
   createdAt: z.string(),
   updatedAt: z.string(),
});

export const autopilotTriggerSchema = z.object({
   id: z.string(),
   autopilotId: z.string(),
   kind: z.enum(['cron', 'webhook']),
   enabled: z.boolean(),
   cronExpression: z.string().nullable(),
   timezone: z.string().nullable(),
   nextFireAt: z.string().nullable(),
   lastFiredAt: z.string().nullable(),
   tokenHint: z.string().nullable(),
   eventFilters: z.array(z.string()),
   createdAt: z.string(),
   updatedAt: z.string(),
});

export const autopilotDetailSchema = autopilotSchema.extend({
   triggers: z.array(autopilotTriggerSchema),
   members: z.array(
      z.object({
         userId: z.string(),
         role: z.enum(['collaborator', 'subscriber']),
         createdAt: z.string(),
      })
   ),
});

export const webhookSecretsSchema = z.object({
   token: z.string(),
   signingSecret: z.string(),
   ingressPath: z.string(),
});

export const autopilotRunSchema = z.object({
   id: z.string(),
   autopilotId: z.string(),
   autopilotVersion: z.number(),
   triggerId: z.string().nullable(),
   source: z.enum(['cron', 'webhook', 'manual', 'replay']),
   status: z.enum(['pending', 'enqueued', 'skipped', 'failed']),
   reasonCode: z.string().nullable(),
   reasonMessage: z.string().nullable(),
   issueId: z.string().nullable(),
   runId: z.string().nullable(),
   taskStatus: z.string().nullable(),
   slot: z.string().nullable(),
   requestedBy: z.string().nullable(),
   createdAt: z.string(),
});

export const webhookDeliverySchema = z.object({
   id: z.string(),
   autopilotId: z.string(),
   triggerId: z.string().nullable(),
   event: z.string().nullable(),
   status: z.enum(['accepted', 'filtered', 'rejected', 'failed']),
   failureReason: z.string().nullable(),
   autopilotRunId: z.string().nullable(),
   replayOf: z.string().nullable(),
   receivedAt: z.string(),
});

export const fireOutcomeSchema = z.object({
   autopilotRunId: z.string(),
   status: z.enum(['enqueued', 'skipped', 'failed']),
   reasonCode: z.string().nullable(),
   runId: z.string().nullable(),
   issueId: z.string().nullable(),
});

export type Autopilot = z.infer<typeof autopilotSchema>;
export type AutopilotDetail = z.infer<typeof autopilotDetailSchema>;
export type AutopilotTrigger = z.infer<typeof autopilotTriggerSchema>;
export type AutopilotRun = z.infer<typeof autopilotRunSchema>;
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;
export type WebhookSecrets = z.infer<typeof webhookSecretsSchema>;
export type FireOutcome = z.infer<typeof fireOutcomeSchema>;

export interface AutopilotDraft {
   name: string;
   description: string | null;
   assigneeType: (typeof ASSIGNEE_TYPES)[number];
   assigneeId: string;
   promptTemplate: string;
   executionMode: (typeof EXECUTION_MODES)[number];
   boardId: string | null;
   issueId: string | null;
   quotaPeriod: (typeof QUOTA_PERIODS)[number];
   quotaMax: number | null;
}

export type AutopilotPatch = Partial<AutopilotDraft> & { status?: 'active' | 'paused' };

function parse<T extends z.ZodTypeAny>(schema: T, json: unknown, what: string): z.infer<T> {
   const parsed = schema.safeParse(json);
   if (!parsed.success) throw new Error(`${what} was not recognized`);
   return parsed.data;
}

const base = '/api/v1/autopilots';
const at = (id: string) => `${base}/${encodeURIComponent(id)}`;

function send(method: string, body: unknown, idempotent = false): RequestInit {
   return {
      method,
      headers: {
         'content-type': 'application/json',
         ...(idempotent ? { 'Idempotency-Key': newIdempotencyKey() } : {}),
      },
      body: JSON.stringify(body),
   };
}

export async function listAutopilots(workspaceId: string): Promise<Autopilot[]> {
   const json: unknown = await apiFetch(`${base}?workspaceId=${encodeURIComponent(workspaceId)}`);
   return parse(z.object({ nodes: z.array(autopilotSchema) }), json, 'Autopilot list').nodes;
}

export async function getAutopilot(id: string, signal?: AbortSignal): Promise<AutopilotDetail> {
   const json: unknown = await apiFetch(at(id), undefined, { signal });
   return parse(autopilotDetailSchema, json, 'Autopilot');
}

export async function createAutopilot(workspaceId: string, draft: AutopilotDraft): Promise<Autopilot> {
   const json: unknown = await apiFetch(base, send('POST', { workspaceId, ...draft }, true));
   return parse(autopilotSchema, json, 'Created autopilot');
}

export async function updateAutopilot(id: string, patch: AutopilotPatch): Promise<Autopilot> {
   const json: unknown = await apiFetch(at(id), send('PATCH', patch));
   return parse(autopilotSchema, json, 'Updated autopilot');
}

export async function archiveAutopilot(id: string): Promise<void> {
   await apiFetch(at(id), { method: 'DELETE' });
}

export async function runAutopilot(id: string): Promise<FireOutcome> {
   const json: unknown = await apiFetch(`${at(id)}/run`, send('POST', {}, true));
   return parse(fireOutcomeSchema, json, 'Run');
}

export async function previewCron(expression: string, timezone: string, count = 5): Promise<string[]> {
   const params = new URLSearchParams({ expression, timezone, count: String(count) });
   const json: unknown = await apiFetch(`${base}/cron-preview?${params.toString()}`);
   return parse(z.object({ times: z.array(z.string()) }), json, 'Schedule preview').times;
}

export async function addCronTrigger(
   id: string,
   input: { expression: string; timezone: string }
): Promise<AutopilotTrigger> {
   const json: unknown = await apiFetch(`${at(id)}/triggers`, send('POST', { kind: 'cron', ...input }));
   return parse(z.object({ trigger: autopilotTriggerSchema }), json, 'Schedule').trigger;
}

/** The secrets come back once. The caller must show them now; nothing can fetch them again. */
export async function addWebhookTrigger(
   id: string,
   eventFilters: string[]
): Promise<{ trigger: AutopilotTrigger; secrets: WebhookSecrets }> {
   const json: unknown = await apiFetch(
      `${at(id)}/triggers`,
      send('POST', { kind: 'webhook', eventFilters })
   );
   return parse(
      z.object({ trigger: autopilotTriggerSchema, secrets: webhookSecretsSchema }),
      json,
      'Webhook'
   );
}

export async function updateTrigger(
   id: string,
   triggerId: string,
   patch: { enabled?: boolean; expression?: string; timezone?: string; eventFilters?: string[] }
): Promise<AutopilotTrigger> {
   const json: unknown = await apiFetch(
      `${at(id)}/triggers/${encodeURIComponent(triggerId)}`,
      send('PATCH', patch)
   );
   return parse(autopilotTriggerSchema, json, 'Trigger');
}

export async function deleteTrigger(id: string, triggerId: string): Promise<void> {
   await apiFetch(`${at(id)}/triggers/${encodeURIComponent(triggerId)}`, { method: 'DELETE' });
}

export async function rotateWebhook(
   id: string,
   triggerId: string
): Promise<{ trigger: AutopilotTrigger; secrets: WebhookSecrets }> {
   const json: unknown = await apiFetch(
      `${at(id)}/triggers/${encodeURIComponent(triggerId)}/rotate`,
      send('POST', {})
   );
   return parse(
      z.object({ trigger: autopilotTriggerSchema, secrets: webhookSecretsSchema }),
      json,
      'Rotated webhook'
   );
}

export async function listAutopilotRuns(id: string): Promise<AutopilotRun[]> {
   const json: unknown = await apiFetch(`${at(id)}/runs`);
   return parse(z.object({ nodes: z.array(autopilotRunSchema) }), json, 'Runs').nodes;
}

export async function listWebhookDeliveries(id: string): Promise<WebhookDelivery[]> {
   const json: unknown = await apiFetch(`${at(id)}/deliveries`);
   return parse(z.object({ nodes: z.array(webhookDeliverySchema) }), json, 'Deliveries').nodes;
}

export const webhookDeliveryDetailSchema = webhookDeliverySchema.extend({ payload: z.unknown() });
export type WebhookDeliveryDetail = z.infer<typeof webhookDeliveryDetailSchema>;

export async function getWebhookDelivery(id: string, deliveryId: string): Promise<WebhookDeliveryDetail> {
   const json: unknown = await apiFetch(`${at(id)}/deliveries/${encodeURIComponent(deliveryId)}`);
   return parse(webhookDeliveryDetailSchema, json, 'Delivery');
}

export async function replayDelivery(id: string, deliveryId: string): Promise<FireOutcome> {
   const json: unknown = await apiFetch(
      `${at(id)}/deliveries/${encodeURIComponent(deliveryId)}/replay`,
      send('POST', {}, true)
   );
   return parse(fireOutcomeSchema, json, 'Replay');
}

/** A message a person can act on; the thrown error keeps the detail. */
export function describeAutopilotFailure(error: unknown): string {
   if (error instanceof BerryApiError) {
      if (error.status === 404) return 'This autopilot does not exist, or is in another workspace.';
      if (error.status === 403) return 'Your role cannot change autopilots in this workspace.';
      if (error.code === 'INTEGRATIONS_NOT_CONFIGURED') {
         return 'This server has no encryption key, so it cannot keep a webhook secret.';
      }
      return error.message;
   }
   return error instanceof Error ? error.message : 'Something went wrong.';
}

/** Whether a stream frame is about autopilots — and, given an id, about that one. */
export function isAutopilotEvent(event: EventEnvelope, autopilotId?: string): boolean {
   if (!event.type.startsWith('autopilot.')) return false;
   if (!autopilotId) return true;
   const payload = event.payload;
   if (typeof payload !== 'object' || payload === null) return false;
   return (payload as { autopilotId?: unknown }).autopilotId === autopilotId;
}

/** Reads a stored reason code the way the run history shows it. */
export function describeReason(code: string | null): string {
   switch (code) {
      case null:
         return '';
      case 'PAUSED':
         return 'Paused';
      case 'ARCHIVED':
         return 'Archived';
      case 'QUOTA_EXCEEDED':
         return 'Over quota';
      case 'SQUAD_UNAVAILABLE':
         return 'No squad leader';
      case 'TARGET_MISSING':
         return 'Task or board gone';
      case 'ENQUEUE_FAILED':
         return 'Could not queue';
      default:
         return code;
   }
}
```

- [ ] **Step 2: Write `frontend/hooks/use-autopilots.ts`**

```ts
'use client';

import { describeAutopilotFailure, isAutopilotEvent, listAutopilots, type Autopilot } from '@/lib/autopilots';
import { subscribeWorkspaceEvents } from '@/lib/events';
import { useSessionStore } from '@/store/session-store';
import { useCallback, useEffect, useState } from 'react';

interface AutopilotsView {
   autopilots: Autopilot[];
   error: string | null;
   loaded: boolean;
   reload: () => void;
}

/** The workspace's autopilots, re-read when any autopilot fact arrives on the stream. */
export function useAutopilots(): AutopilotsView {
   const status = useSessionStore((state) => state.status);
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [autopilots, setAutopilots] = useState<Autopilot[]>([]);
   const [error, setError] = useState<string | null>(null);
   const [loaded, setLoaded] = useState(false);
   const [nonce, setNonce] = useState(0);
   const reload = useCallback(() => setNonce((value) => value + 1), []);

   useEffect(() => {
      if (status !== 'ready' || !workspaceId) return;
      let cancelled = false;
      void listAutopilots(workspaceId)
         .then((nodes) => {
            if (cancelled) return;
            setAutopilots(nodes);
            setError(null);
         })
         .catch((failure: unknown) => {
            if (!cancelled) setError(describeAutopilotFailure(failure));
         })
         .finally(() => {
            if (!cancelled) setLoaded(true);
         });
      return () => {
         cancelled = true;
      };
   }, [status, workspaceId, nonce]);

   useEffect(() => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = subscribeWorkspaceEvents((event) => {
         if (!isAutopilotEvent(event)) return;
         if (timer) clearTimeout(timer);
         timer = setTimeout(reload, 400);
      });
      return () => {
         unsubscribe();
         if (timer) clearTimeout(timer);
      };
   }, [reload]);

   return { autopilots, error, loaded, reload };
}
```

- [ ] **Step 3: Write `frontend/hooks/use-autopilot.ts`**

```ts
'use client';

import {
   describeAutopilotFailure,
   getAutopilot,
   isAutopilotEvent,
   listAutopilotRuns,
   listWebhookDeliveries,
   type AutopilotDetail,
   type AutopilotRun,
   type WebhookDelivery,
} from '@/lib/autopilots';
import { subscribeWorkspaceEvents } from '@/lib/events';
import { useSessionStore } from '@/store/session-store';
import { useCallback, useEffect, useState } from 'react';

interface AutopilotView {
   autopilot: AutopilotDetail | undefined;
   runs: AutopilotRun[];
   deliveries: WebhookDelivery[];
   error: string | null;
   loading: boolean;
   reload: () => void;
}

/**
 * One autopilot with its history. Re-read quietly when a frame about this
 * autopilot arrives — a run recorded, a delivery received — because the
 * history is what someone opened the page to watch.
 */
export function useAutopilot(autopilotId: string): AutopilotView {
   const status = useSessionStore((state) => state.status);
   const [autopilot, setAutopilot] = useState<AutopilotDetail | undefined>(undefined);
   const [runs, setRuns] = useState<AutopilotRun[]>([]);
   const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
   const [error, setError] = useState<string | null>(null);
   const [loading, setLoading] = useState(true);
   const [nonce, setNonce] = useState(0);
   const reload = useCallback(() => setNonce((value) => value + 1), []);

   useEffect(() => {
      if (status !== 'ready' || !autopilotId) return;
      const controller = new AbortController();
      void Promise.all([
         getAutopilot(autopilotId, controller.signal),
         listAutopilotRuns(autopilotId),
         listWebhookDeliveries(autopilotId),
      ])
         .then(([detail, runRows, deliveryRows]) => {
            if (controller.signal.aborted) return;
            setAutopilot(detail);
            setRuns(runRows);
            setDeliveries(deliveryRows);
            setError(null);
         })
         .catch((failure: unknown) => {
            if (!controller.signal.aborted) setError(describeAutopilotFailure(failure));
         })
         .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
         });
      return () => controller.abort();
   }, [status, autopilotId, nonce]);

   useEffect(() => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = subscribeWorkspaceEvents((event) => {
         if (!isAutopilotEvent(event, autopilotId)) return;
         if (timer) clearTimeout(timer);
         timer = setTimeout(reload, 400);
      });
      return () => {
         unsubscribe();
         if (timer) clearTimeout(timer);
      };
   }, [autopilotId, reload]);

   return { autopilot, runs, deliveries, error, loading: loading && !autopilot, reload };
}
```

- [ ] **Step 4: Lint and build**

Run: `cd /Users/secret/Code/berry-circle && pnpm lint:frontend && cd frontend && pnpm build:check`
Expected: lint reports no errors, and `next build` completes. The new modules are type-checked even though no page imports them yet.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/autopilots.ts frontend/hooks/use-autopilots.ts frontend/hooks/use-autopilot.ts
git commit -m "feat(frontend): add the autopilot API client and hooks"
```

---

### Task 11: Autopilots list page, create/edit dialog, rail entry

**Files:**
- Create: `frontend/app/[orgId]/autopilots/page.tsx`
- Create: `frontend/components/layout/headers/autopilots/header.tsx`
- Create: `frontend/components/common/autopilots/autopilots.tsx`
- Create: `frontend/components/common/autopilots/autopilot-dialog.tsx`
- Modify: `frontend/components/layout/shell/shell-routes.ts`
- Modify: `frontend/store/sidebar-prefs-store.ts`
- Modify: `frontend/components/layout/sidebar/customize-sidebar-dialog.tsx`

**Interfaces:**
- Consumes:
  - From Task 10: `useAutopilots`, `createAutopilot`, `updateAutopilot`, `describeAutopilotFailure`, `AutopilotDraft` and `Autopilot`.
  - Agents: `useAgentsStore((s) => s.agents)`, where each `Agent` has `id` and `name`.
  - Boards: `listBoards(): Promise<BoardSummary[]>`, where each board has `id` and `name`.
  - Issues: `useIssuesStore((s) => s.getAllIssues())`, where each issue has `id`, `identifier` and `title`.
  - UI: `MainLayout`, `Button`, `Input`, `Textarea`, `Label`, `Badge`, `Dialog*`, `Select*`.
- Produces:
  - `AutopilotDialog` (default export) with props `{ open: boolean; onOpenChange: (open: boolean) => void; autopilot?: Autopilot }`. It creates when `autopilot` is absent and edits otherwise. After a create it navigates to the detail page.
  - The route `/{orgId}/autopilots`.
  - The rail item `autopilots` (`prefsKey: 'autopilot'`).

Squads are not offered in the form until workstream D ships a squad list on the frontend. The server accepts `assigneeType: 'squad'` already. See Open Questions.

- [ ] **Step 1: Write the dialog**

Create `frontend/components/common/autopilots/autopilot-dialog.tsx`:

```tsx
'use client';

import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
   createAutopilot,
   describeAutopilotFailure,
   updateAutopilot,
   type Autopilot,
   type AutopilotDraft,
} from '@/lib/autopilots';
import { listBoards, type BoardSummary } from '@/lib/boards';
import { WORKSPACE_SLUG } from '@/lib/config';
import { useAgentsStore } from '@/store/agents-store';
import { useIssuesStore } from '@/store/issues-store';
import { useSessionStore } from '@/store/session-store';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

interface Props {
   open: boolean;
   onOpenChange: (open: boolean) => void;
   autopilot?: Autopilot;
}

function initialDraft(autopilot?: Autopilot): AutopilotDraft {
   if (autopilot) {
      const { name, description, assigneeType, assigneeId, promptTemplate, executionMode } = autopilot;
      return {
         name,
         description,
         assigneeType,
         assigneeId,
         promptTemplate,
         executionMode,
         boardId: autopilot.boardId,
         issueId: autopilot.issueId,
         quotaPeriod: autopilot.quotaPeriod,
         quotaMax: autopilot.quotaMax,
      };
   }
   return {
      name: '',
      description: null,
      assigneeType: 'agent',
      assigneeId: '',
      promptTemplate: '',
      executionMode: 'create_issue',
      boardId: null,
      issueId: null,
      quotaPeriod: 'none',
      quotaMax: null,
   };
}

export default function AutopilotDialog({ open, onOpenChange, autopilot }: Props) {
   const router = useRouter();
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const agents = useAgentsStore((state) => state.agents);
   const issues = useIssuesStore((state) => state.getAllIssues());
   const [boards, setBoards] = useState<BoardSummary[]>([]);
   const [draft, setDraft] = useState<AutopilotDraft>(() => initialDraft(autopilot));
   const [error, setError] = useState<string | null>(null);
   const [saving, setSaving] = useState(false);

   // Keyed on the id, not the object: the detail page re-reads the autopilot
   // whenever a stream frame about it arrives (a run, a delivery), and a
   // dependency on the object would wipe what the person is typing mid-edit.
   // (`react-hooks/exhaustive-deps` is off in this repo, so this is deliberate.)
   const autopilotKey = autopilot?.id ?? null;
   useEffect(() => {
      if (!open) return;
      setDraft(initialDraft(autopilot));
      setError(null);
      void listBoards()
         .then(setBoards)
         .catch(() => setBoards([]));
   }, [open, autopilotKey]);

   const set = <K extends keyof AutopilotDraft>(key: K, value: AutopilotDraft[K]) =>
      setDraft((current) => ({ ...current, [key]: value }));

   const ready =
      draft.name.trim() !== '' &&
      draft.assigneeId !== '' &&
      draft.promptTemplate.trim() !== '' &&
      (draft.executionMode === 'create_issue' ? draft.boardId !== null : draft.issueId !== null) &&
      (draft.quotaPeriod === 'none' || (draft.quotaMax !== null && draft.quotaMax >= 1));

   async function submit(event: FormEvent) {
      event.preventDefault();
      if (!ready || saving) return;
      setSaving(true);
      setError(null);
      try {
         if (autopilot) {
            await updateAutopilot(autopilot.id, draft);
            onOpenChange(false);
         } else {
            const created = await createAutopilot(workspaceId, draft);
            onOpenChange(false);
            router.push(`/${orgId}/autopilot/${created.id}`);
         }
      } catch (failure) {
         setError(describeAutopilotFailure(failure));
      } finally {
         setSaving(false);
      }
   }

   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent className="sm:max-w-xl">
            <form onSubmit={submit} className="flex flex-col gap-4">
               <DialogHeader>
                  <DialogTitle>{autopilot ? 'Edit autopilot' : 'New autopilot'}</DialogTitle>
                  <DialogDescription>
                     An agent and a prompt. Add a schedule or a webhook after saving, or run it by
                     hand.
                  </DialogDescription>
               </DialogHeader>

               <div className="grid gap-2">
                  <Label htmlFor="autopilot-name">Name</Label>
                  <Input
                     id="autopilot-name"
                     value={draft.name}
                     maxLength={200}
                     onChange={(event) => set('name', event.target.value)}
                  />
               </div>

               <div className="grid gap-2">
                  <Label>Agent</Label>
                  <Select value={draft.assigneeId} onValueChange={(value) => set('assigneeId', value)}>
                     <SelectTrigger>
                        <SelectValue placeholder="Choose an agent" />
                     </SelectTrigger>
                     <SelectContent>
                        {agents.map((agent) => (
                           <SelectItem key={agent.id} value={agent.id}>
                              {agent.name}
                           </SelectItem>
                        ))}
                     </SelectContent>
                  </Select>
               </div>

               <div className="grid gap-2">
                  <Label>Each run</Label>
                  <Select
                     value={draft.executionMode}
                     onValueChange={(value) =>
                        setDraft((current) => ({
                           ...current,
                           executionMode: value === 'fixed_issue' ? 'fixed_issue' : 'create_issue',
                           boardId: null,
                           issueId: null,
                        }))
                     }
                  >
                     <SelectTrigger>
                        <SelectValue />
                     </SelectTrigger>
                     <SelectContent>
                        <SelectItem value="create_issue">opens a new task on a board</SelectItem>
                        <SelectItem value="fixed_issue">works on one existing task</SelectItem>
                     </SelectContent>
                  </Select>
               </div>

               {draft.executionMode === 'create_issue' ? (
                  <div className="grid gap-2">
                     <Label>Board</Label>
                     <Select value={draft.boardId ?? ''} onValueChange={(value) => set('boardId', value)}>
                        <SelectTrigger>
                           <SelectValue placeholder="Choose a board" />
                        </SelectTrigger>
                        <SelectContent>
                           {boards.map((board) => (
                              <SelectItem key={board.id} value={board.id}>
                                 {board.name}
                              </SelectItem>
                           ))}
                        </SelectContent>
                     </Select>
                  </div>
               ) : (
                  <div className="grid gap-2">
                     <Label>Task</Label>
                     <Select value={draft.issueId ?? ''} onValueChange={(value) => set('issueId', value)}>
                        <SelectTrigger>
                           <SelectValue placeholder="Choose a task" />
                        </SelectTrigger>
                        <SelectContent>
                           {issues.map((issue) => (
                              <SelectItem key={issue.id} value={issue.id}>
                                 {issue.identifier} · {issue.title}
                              </SelectItem>
                           ))}
                        </SelectContent>
                     </Select>
                  </div>
               )}

               <div className="grid gap-2">
                  <Label htmlFor="autopilot-prompt">Prompt</Label>
                  <Textarea
                     id="autopilot-prompt"
                     rows={6}
                     maxLength={20000}
                     value={draft.promptTemplate}
                     onChange={(event) => set('promptTemplate', event.target.value)}
                  />
                  <p className="text-muted-foreground">
                     {'Fill in facts with {{trigger.firedAt}}, {{trigger.source}} or {{payload.field}}.'}
                  </p>
               </div>

               <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                     <Label>Quota</Label>
                     <Select
                        value={draft.quotaPeriod}
                        onValueChange={(value) =>
                           setDraft((current) => ({
                              ...current,
                              quotaPeriod:
                                 value === 'hour' || value === 'day' || value === 'week' ? value : 'none',
                              quotaMax: value === 'none' ? null : (current.quotaMax ?? 1),
                           }))
                        }
                     >
                        <SelectTrigger>
                           <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                           <SelectItem value="none">no limit</SelectItem>
                           <SelectItem value="hour">per hour</SelectItem>
                           <SelectItem value="day">per day</SelectItem>
                           <SelectItem value="week">per week</SelectItem>
                        </SelectContent>
                     </Select>
                  </div>
                  {draft.quotaPeriod !== 'none' && (
                     <div className="grid gap-2">
                        <Label htmlFor="autopilot-quota">Runs at most</Label>
                        <Input
                           id="autopilot-quota"
                           type="number"
                           min={1}
                           max={10000}
                           value={draft.quotaMax ?? 1}
                           onChange={(event) => set('quotaMax', Math.max(1, Number(event.target.value) || 1))}
                        />
                     </div>
                  )}
               </div>

               {error && (
                  <p className="text-destructive" role="alert">
                     {error}
                  </p>
               )}

               <DialogFooter>
                  <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                     cancel
                  </Button>
                  <Button type="submit" disabled={!ready || saving}>
                     {autopilot ? 'save' : 'create autopilot'}
                  </Button>
               </DialogFooter>
            </form>
         </DialogContent>
      </Dialog>
   );
}
```

- [ ] **Step 2: Write the list body, header and page**

Create `frontend/components/common/autopilots/autopilots.tsx`:

```tsx
'use client';

import { Badge } from '@/components/ui/badge';
import { useAutopilots } from '@/hooks/use-autopilots';
import type { Autopilot } from '@/lib/autopilots';
import { WORKSPACE_SLUG } from '@/lib/config';
import { useAgentsStore } from '@/store/agents-store';
import Link from 'next/link';
import { useParams } from 'next/navigation';

function modeLabel(autopilot: Autopilot): string {
   return autopilot.executionMode === 'create_issue' ? 'new task per run' : 'one standing task';
}

export default function Autopilots() {
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const { autopilots, error, loaded } = useAutopilots();
   // Select the stable array, not a new closure: a selector that returns a
   // fresh function on every call re-renders forever under zustand.
   const agents = useAgentsStore((state) => state.agents);
   const agentName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? 'an agent';

   return (
      <div className="w-full">
         <div className="sticky top-0 z-10 flex items-center border-b bg-container px-6 py-1.5 text-muted-foreground">
            <div className="min-w-0 flex-1">Autopilot</div>
            <div className="w-24 shrink-0">Status</div>
            <div className="hidden w-44 shrink-0 md:block">Quota</div>
            <div className="hidden w-28 shrink-0 sm:block">Updated</div>
         </div>
         {!loaded && !error ? (
            <div className="px-6 py-10 text-muted-foreground">Loading autopilots…</div>
         ) : error ? (
            <div className="px-6 py-10 text-muted-foreground" role="alert">
               {error}
            </div>
         ) : autopilots.length === 0 ? (
            <div className="px-6 py-12 text-muted-foreground">
               No autopilots yet. An autopilot hands an agent the same prompt on a schedule, on a
               webhook, or whenever you press run.
            </div>
         ) : (
            autopilots.map((autopilot) => (
               <Link
                  key={autopilot.id}
                  href={`/${orgId}/autopilot/${autopilot.id}`}
                  className="flex items-center border-b px-6 py-2.5 hover:bg-accent/40"
               >
                  <div className="min-w-0 flex-1">
                     <div className="truncate font-medium">{autopilot.name}</div>
                     <div className="truncate text-muted-foreground">
                        {agentName(autopilot.assigneeId)} · {modeLabel(autopilot)}
                     </div>
                  </div>
                  <div className="w-24 shrink-0">
                     <Badge variant={autopilot.status === 'active' ? 'default' : 'secondary'}>
                        {autopilot.status}
                     </Badge>
                  </div>
                  <div className="hidden w-44 shrink-0 text-muted-foreground md:block">
                     {autopilot.quotaPeriod === 'none'
                        ? 'no limit'
                        : `${autopilot.quotaMax ?? 0} per ${autopilot.quotaPeriod}`}
                  </div>
                  <div className="hidden w-28 shrink-0 text-muted-foreground sm:block">
                     {new Date(autopilot.updatedAt).toLocaleDateString()}
                  </div>
               </Link>
            ))
         )}
      </div>
   );
}
```

Create `frontend/components/layout/headers/autopilots/header.tsx`:

```tsx
'use client';

import AutopilotDialog from '@/components/common/autopilots/autopilot-dialog';
import { Button } from '@/components/ui/button';
import { useState } from 'react';

export default function Header() {
   const [open, setOpen] = useState(false);
   return (
      <header className="flex h-auto w-full items-start justify-between gap-4 border-b px-6 py-3">
         <div className="min-w-0">
            <span className="font-medium">Autopilots</span>
            <p className="mt-1 max-w-2xl text-muted-foreground">
               Standing instructions for agents. Each firing — scheduled, from a webhook or by hand
               — becomes one agent task you can follow like any other.
            </p>
         </div>
         <Button className="h-9 shrink-0" onClick={() => setOpen(true)}>
            new autopilot
         </Button>
         <AutopilotDialog open={open} onOpenChange={setOpen} />
      </header>
   );
}
```

Create `frontend/app/[orgId]/autopilots/page.tsx`:

```tsx
import Autopilots from '@/components/common/autopilots/autopilots';
import Header from '@/components/layout/headers/autopilots/header';
import MainLayout from '@/components/layout/main-layout';

export default function AutopilotsPage() {
   return (
      <MainLayout header={<Header />} headersNumber={1}>
         <Autopilots />
      </MainLayout>
   );
}
```

- [ ] **Step 3: Add the rail entry**

Workstream I owns the rail's structure and its plan deletes the `analytics` entry from `MANAGE` and drops `'analytics'` from `DEFAULT_ORDER.configure`. So anchor every edit below on the entry *before* it (`members` / `'agents'`), never on `analytics`, so they apply the same whether or not I has merged.

In `frontend/components/layout/shell/shell-routes.ts`, add `| 'autopilots'` to the `ShellRoute` union after `| 'members'`. Then, in the `MANAGE` array, add this entry directly after the closing `},` of the `members` entry (the one with `id: 'members'`):

```ts
   {
      id: 'autopilots',
      label: 'autopilots',
      href: '/autopilots',
      match: ['/autopilot/'],
      prefsKey: 'autopilot',
      icon: '<circle cx="12" cy="13" r="7.5" /><path d="M12 9v4l2.5 2.5" /><path d="M9.5 3h5" />',
   },
```

In `frontend/store/sidebar-prefs-store.ts`, in `DEFAULT_ORDER.configure`, insert `'autopilot'` directly after `'agents'` and keep whatever follows it. Today that gives:

```ts
   configure: ['agent', 'agents', 'autopilot', 'analytics'],
```

and after I has merged it gives `configure: ['agent', 'agents', 'autopilot'],`.

The `'autopilot'` key already exists in `SidebarItemKey` and `DEFAULT_VISIBILITY`, so no other edit is needed there. `resolveOrder` inserts the new default after its predecessor, so stored preferences keep working.

In `frontend/components/layout/sidebar/customize-sidebar-dialog.tsx`, add `Timer` to the `lucide-react` import list, keeping alphabetical order: `Sparkles, Target, Timer,`. Then add this entry to `CONFIGURE_ITEMS` after the `agents` entry:

```ts
   { key: 'autopilot', label: 'autopilots', icon: Timer },
```

- [ ] **Step 4: Lint, build and check by hand**

Run: `cd /Users/secret/Code/berry-circle && pnpm lint:frontend && cd frontend && pnpm build:check`
Expected: no lint errors, and the build lists the route `/[orgId]/autopilots`. Then, with the server and `pnpm dev:frontend` running, open `/<org>/autopilots`:
- the rail shows "autopilots" under Manage;
- "new autopilot" opens the dialog;
- creating one navigates to `/<org>/autopilot/<id>`, which 404s until Task 12 lands;
- the new autopilot appears in the list.

- [ ] **Step 5: Commit**

```bash
git add "frontend/app/[orgId]/autopilots/page.tsx" frontend/components/layout/headers/autopilots/header.tsx frontend/components/common/autopilots/autopilots.tsx frontend/components/common/autopilots/autopilot-dialog.tsx frontend/components/layout/shell/shell-routes.ts frontend/store/sidebar-prefs-store.ts frontend/components/layout/sidebar/customize-sidebar-dialog.tsx
git commit -m "feat(frontend): list and create autopilots"
```

---
### Task 12: Autopilot detail — triggers, runs, deliveries and replay

**Files:**
- Create: `frontend/app/[orgId]/autopilot/[autopilotId]/page.tsx`
- Create: `frontend/components/common/autopilots/autopilot-detail.tsx`
- Create: `frontend/components/common/autopilots/triggers-tab.tsx`
- Create: `frontend/components/common/autopilots/history-tabs.tsx`

**Interfaces:**
- Consumes:
  - From Task 10: `useAutopilot`, `updateAutopilot`, `archiveAutopilot`, `runAutopilot`, `previewCron`, `addCronTrigger`, `addWebhookTrigger`, `updateTrigger`, `deleteTrigger`, `rotateWebhook`, `replayDelivery`, `describeAutopilotFailure`, `describeReason`, and the types.
  - From Task 11: `AutopilotDialog`.
  - `absoluteApiUrl(path)` from `@/lib/api`.
  - UI: `Tabs*`, `Switch`, `Badge`, `Button`, `Input`, `Label` and `MainLayout`.
- Produces:
  - `AutopilotDetail({ autopilotId })`
  - `TriggersTab({ autopilot, onChanged })`
  - `RunsTable({ runs, orgId })`
  - `DeliveriesTable({ autopilotId, deliveries, onReplayed })`

- [ ] **Step 1: Write the triggers tab**

Create `frontend/components/common/autopilots/triggers-tab.tsx`:

```tsx
'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { absoluteApiUrl } from '@/lib/api';
import {
   addCronTrigger,
   addWebhookTrigger,
   deleteTrigger,
   describeAutopilotFailure,
   previewCron,
   rotateWebhook,
   updateTrigger,
   type AutopilotDetail,
   type AutopilotTrigger,
   type WebhookSecrets,
} from '@/lib/autopilots';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

interface Props {
   autopilot: AutopilotDetail;
   onChanged: () => void;
}

function localZone(): string {
   return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * Shown once, straight after a webhook is made or rotated. The server keeps
 * only a hash of the token and a sealed secret, so closing this is final.
 */
function SecretsNotice({ secrets, onDismiss }: { secrets: WebhookSecrets; onDismiss: () => void }) {
   const endpoint = absoluteApiUrl(secrets.ingressPath);
   const copy = (value: string) => {
      void navigator.clipboard.writeText(value).then(() => toast.success('Copied'));
   };
   return (
      <div className="rounded-md border border-dashed p-4" role="status">
         <p className="font-medium">Copy these now — Berry will not show them again.</p>
         <div className="mt-3 grid gap-2">
            <Label>Endpoint (POST)</Label>
            <div className="flex gap-2">
               <Input readOnly value={endpoint} />
               <Button type="button" variant="outline" onClick={() => copy(endpoint)}>
                  copy
               </Button>
            </div>
            <Label>Signing secret</Label>
            <div className="flex gap-2">
               <Input readOnly value={secrets.signingSecret} />
               <Button type="button" variant="outline" onClick={() => copy(secrets.signingSecret)}>
                  copy
               </Button>
            </div>
            <p className="text-muted-foreground">
               Sign the raw body with HMAC-SHA256 and send it as{' '}
               <code>X-Berry-Signature: sha256=&lt;hex&gt;</code>. Name the event in{' '}
               <code>X-Berry-Event</code> or a top-level <code>event</code> field.
            </p>
         </div>
         <Button type="button" className="mt-3" variant="ghost" onClick={onDismiss}>
            I have copied them
         </Button>
      </div>
   );
}

function CronForm({ autopilotId, onAdded }: { autopilotId: string; onAdded: () => void }) {
   const [expression, setExpression] = useState('0 9 * * 1-5');
   const [timezone, setTimezone] = useState(localZone);
   const [preview, setPreview] = useState<string[]>([]);
   const [problem, setProblem] = useState<string | null>(null);

   useEffect(() => {
      const timer = setTimeout(() => {
         void previewCron(expression, timezone, 5)
            .then((times) => {
               setPreview(times);
               setProblem(null);
            })
            .catch((failure: unknown) => {
               setPreview([]);
               setProblem(describeAutopilotFailure(failure));
            });
      }, 300);
      return () => clearTimeout(timer);
   }, [expression, timezone]);

   async function add() {
      try {
         await addCronTrigger(autopilotId, { expression, timezone });
         onAdded();
      } catch (failure) {
         toast.error(describeAutopilotFailure(failure));
      }
   }

   return (
      <div className="grid gap-2 rounded-md border p-4">
         <p className="font-medium">Schedule</p>
         <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="grid gap-1">
               <Label htmlFor="cron-expression">Cron (minute hour day month weekday)</Label>
               <Input id="cron-expression" value={expression} onChange={(e) => setExpression(e.target.value)} />
            </div>
            <div className="grid gap-1">
               <Label htmlFor="cron-zone">Time zone</Label>
               <Input id="cron-zone" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            </div>
         </div>
         {problem ? (
            <p className="text-destructive" role="alert">
               {problem}
            </p>
         ) : (
            <ul className="text-muted-foreground">
               {preview.map((time) => (
                  <li key={time}>{new Date(time).toLocaleString()}</li>
               ))}
            </ul>
         )}
         <div>
            <Button type="button" disabled={problem !== null} onClick={() => void add()}>
               add schedule
            </Button>
         </div>
      </div>
   );
}

function WebhookForm({
   autopilotId,
   onAdded,
}: {
   autopilotId: string;
   onAdded: (secrets: WebhookSecrets) => void;
}) {
   const [filters, setFilters] = useState('');

   async function add() {
      const eventFilters = filters
         .split(',')
         .map((name) => name.trim())
         .filter((name) => name !== '');
      try {
         const { secrets } = await addWebhookTrigger(autopilotId, eventFilters);
         setFilters('');
         onAdded(secrets);
      } catch (failure) {
         toast.error(describeAutopilotFailure(failure));
      }
   }

   return (
      <div className="grid gap-2 rounded-md border p-4">
         <p className="font-medium">Webhook</p>
         <Label htmlFor="webhook-filters">Only these events (comma separated, empty for all)</Label>
         <Input id="webhook-filters" value={filters} onChange={(e) => setFilters(e.target.value)} />
         <div>
            <Button type="button" onClick={() => void add()}>
               add webhook
            </Button>
         </div>
      </div>
   );
}

function TriggerRow({
   autopilotId,
   trigger,
   onChanged,
   onSecrets,
}: {
   autopilotId: string;
   trigger: AutopilotTrigger;
   onChanged: () => void;
   onSecrets: (secrets: WebhookSecrets) => void;
}) {
   const act = async (work: () => Promise<unknown>) => {
      try {
         await work();
         onChanged();
      } catch (failure) {
         toast.error(describeAutopilotFailure(failure));
      }
   };
   return (
      <div className="flex flex-wrap items-center gap-3 border-b py-3">
         <Switch
            checked={trigger.enabled}
            onCheckedChange={(enabled) => void act(() => updateTrigger(autopilotId, trigger.id, { enabled }))}
            aria-label="Enabled"
         />
         <div className="min-w-0 flex-1">
            {trigger.kind === 'cron' ? (
               <>
                  <div className="font-medium">
                     <code>{trigger.cronExpression}</code> · {trigger.timezone}
                  </div>
                  <div className="text-muted-foreground">
                     {trigger.nextFireAt
                        ? `next ${new Date(trigger.nextFireAt).toLocaleString()}`
                        : 'not scheduled'}
                  </div>
               </>
            ) : (
               <>
                  <div className="font-medium">Webhook ····{trigger.tokenHint}</div>
                  <div className="text-muted-foreground">
                     {trigger.eventFilters.length > 0 ? trigger.eventFilters.join(', ') : 'every event'}
                  </div>
               </>
            )}
         </div>
         {trigger.kind === 'webhook' && (
            <Button
               type="button"
               variant="outline"
               onClick={() =>
                  void act(async () => {
                     const { secrets } = await rotateWebhook(autopilotId, trigger.id);
                     onSecrets(secrets);
                  })
               }
            >
               rotate
            </Button>
         )}
         <Button
            type="button"
            variant="ghost"
            onClick={() => void act(() => deleteTrigger(autopilotId, trigger.id))}
         >
            remove
         </Button>
      </div>
   );
}

export default function TriggersTab({ autopilot, onChanged }: Props) {
   const [secrets, setSecrets] = useState<WebhookSecrets | null>(null);
   return (
      <div className="grid gap-4 px-6 py-4">
         {secrets && <SecretsNotice secrets={secrets} onDismiss={() => setSecrets(null)} />}
         <div>
            {autopilot.triggers.length === 0 ? (
               <p className="text-muted-foreground">
                  No triggers yet. It runs only when someone presses run now.
               </p>
            ) : (
               autopilot.triggers.map((trigger) => (
                  <TriggerRow
                     key={trigger.id}
                     autopilotId={autopilot.id}
                     trigger={trigger}
                     onChanged={onChanged}
                     onSecrets={(next) => {
                        setSecrets(next);
                        onChanged();
                     }}
                  />
               ))
            )}
         </div>
         <div className="grid gap-4 md:grid-cols-2">
            <CronForm autopilotId={autopilot.id} onAdded={onChanged} />
            <WebhookForm
               autopilotId={autopilot.id}
               onAdded={(next) => {
                  setSecrets(next);
                  onChanged();
               }}
            />
         </div>
      </div>
   );
}
```

- [ ] **Step 2: Write the history tables**

Create `frontend/components/common/autopilots/history-tabs.tsx`:

```tsx
'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
   describeAutopilotFailure,
   describeReason,
   getWebhookDelivery,
   replayDelivery,
   type AutopilotRun,
   type WebhookDelivery,
} from '@/lib/autopilots';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { toast } from 'sonner';

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
   if (status === 'enqueued' || status === 'accepted') return 'default';
   if (status === 'failed' || status === 'rejected') return 'destructive';
   if (status === 'skipped' || status === 'filtered') return 'secondary';
   return 'outline';
}

export function RunsTable({ runs, orgId }: { runs: AutopilotRun[]; orgId: string }) {
   if (runs.length === 0) {
      return <p className="px-6 py-6 text-muted-foreground">It has not run yet.</p>;
   }
   return (
      <div className="overflow-x-auto">
         <table className="w-full">
            <thead className="text-left text-muted-foreground">
               <tr className="border-b">
                  <th className="px-6 py-2 font-normal">When</th>
                  <th className="px-2 py-2 font-normal">Source</th>
                  <th className="px-2 py-2 font-normal">Outcome</th>
                  <th className="px-2 py-2 font-normal">Task</th>
                  <th className="px-2 py-2 font-normal">Version</th>
               </tr>
            </thead>
            <tbody>
               {runs.map((run) => (
                  <tr key={run.id} className="border-b">
                     <td className="px-6 py-2">{new Date(run.createdAt).toLocaleString()}</td>
                     <td className="px-2 py-2">{run.source}</td>
                     <td className="px-2 py-2">
                        <Badge variant={statusVariant(run.status)}>{run.status}</Badge>{' '}
                        <span className="text-muted-foreground" title={run.reasonMessage ?? undefined}>
                           {describeReason(run.reasonCode)}
                           {run.taskStatus ? ` · task ${run.taskStatus}` : ''}
                        </span>
                     </td>
                     <td className="px-2 py-2">
                        {run.issueId ? (
                           <Link className="underline" href={`/${orgId}/issue/${run.issueId}`}>
                              open
                           </Link>
                        ) : (
                           <span className="text-muted-foreground">—</span>
                        )}
                     </td>
                     <td className="px-2 py-2 text-muted-foreground">v{run.autopilotVersion}</td>
                  </tr>
               ))}
            </tbody>
         </table>
      </div>
   );
}

export function DeliveriesTable({
   autopilotId,
   deliveries,
   onReplayed,
}: {
   autopilotId: string;
   deliveries: WebhookDelivery[];
   onReplayed: () => void;
}) {
   const [openId, setOpenId] = useState<string | null>(null);
   const [payload, setPayload] = useState<string>('');

   async function togglePayload(deliveryId: string) {
      if (openId === deliveryId) {
         setOpenId(null);
         return;
      }
      try {
         const detail = await getWebhookDelivery(autopilotId, deliveryId);
         setPayload(detail.payload === null ? '(no payload stored)' : JSON.stringify(detail.payload, null, 2));
         setOpenId(deliveryId);
      } catch (failure) {
         toast.error(describeAutopilotFailure(failure));
      }
   }

   async function replay(deliveryId: string) {
      try {
         const outcome = await replayDelivery(autopilotId, deliveryId);
         toast.success(`Replayed — ${outcome.status}`);
         onReplayed();
      } catch (failure) {
         toast.error(describeAutopilotFailure(failure));
      }
   }

   if (deliveries.length === 0) {
      return <p className="px-6 py-6 text-muted-foreground">No webhook deliveries yet.</p>;
   }
   return (
      <div className="overflow-x-auto">
         <table className="w-full">
            <thead className="text-left text-muted-foreground">
               <tr className="border-b">
                  <th className="px-6 py-2 font-normal">Received</th>
                  <th className="px-2 py-2 font-normal">Event</th>
                  <th className="px-2 py-2 font-normal">Status</th>
                  <th className="px-2 py-2 font-normal" />
               </tr>
            </thead>
            <tbody>
               {deliveries.map((delivery) => (
                  <Fragment key={delivery.id}>
                     <tr className="border-b">
                        <td className="px-6 py-2">
                           {new Date(delivery.receivedAt).toLocaleString()}
                           {delivery.replayOf && <span className="text-muted-foreground"> · replay</span>}
                        </td>
                        <td className="px-2 py-2">{delivery.event ?? '—'}</td>
                        <td className="px-2 py-2">
                           <Badge variant={statusVariant(delivery.status)}>{delivery.status}</Badge>{' '}
                           <span className="text-muted-foreground">{delivery.failureReason ?? ''}</span>
                        </td>
                        <td className="px-2 py-2 text-right">
                           <Button
                              type="button"
                              variant="ghost"
                              onClick={() => void togglePayload(delivery.id)}
                           >
                              {openId === delivery.id ? 'hide payload' : 'payload'}
                           </Button>{' '}
                           {delivery.status !== 'rejected' && (
                              <Button
                                 type="button"
                                 variant="outline"
                                 onClick={() => void replay(delivery.id)}
                              >
                                 replay
                              </Button>
                           )}
                        </td>
                     </tr>
                     {openId === delivery.id && (
                        <tr className="border-b">
                           <td colSpan={4} className="px-6 py-2">
                              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border p-3 text-muted-foreground">
                                 {payload}
                              </pre>
                           </td>
                        </tr>
                     )}
                  </Fragment>
               ))}
            </tbody>
         </table>
      </div>
   );
}
```

Replay is not offered for `rejected` deliveries, and the server refuses it with `409 DELIVERY_NOT_REPLAYABLE` (Task 7). They were refused at the door: a bad signature or a malformed body (neither stores a payload), or a disabled trigger (refused on purpose). "payload" fetches `GET /:id/deliveries/:deliveryId` on demand, so the list response stays small.

- [ ] **Step 3: Write the detail shell and page**

Create `frontend/components/common/autopilots/autopilot-detail.tsx`:

```tsx
'use client';

import AutopilotDialog from '@/components/common/autopilots/autopilot-dialog';
import { DeliveriesTable, RunsTable } from '@/components/common/autopilots/history-tabs';
import TriggersTab from '@/components/common/autopilots/triggers-tab';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAutopilot } from '@/hooks/use-autopilot';
import {
   archiveAutopilot,
   describeAutopilotFailure,
   runAutopilot,
   updateAutopilot,
} from '@/lib/autopilots';
import { WORKSPACE_SLUG } from '@/lib/config';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

export default function AutopilotDetail({ autopilotId }: { autopilotId: string }) {
   const router = useRouter();
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const { autopilot, runs, deliveries, error, loading, reload } = useAutopilot(autopilotId);
   const [editing, setEditing] = useState(false);

   if (loading) return <div className="px-6 py-10 text-muted-foreground">Loading autopilot…</div>;
   if (error || !autopilot) {
      return (
         <div className="px-6 py-10 text-muted-foreground" role="alert">
            {error ?? 'This autopilot could not be loaded.'}
         </div>
      );
   }

   const act = async (work: () => Promise<unknown>, done: string) => {
      try {
         await work();
         toast.success(done);
         reload();
      } catch (failure) {
         toast.error(describeAutopilotFailure(failure));
      }
   };
   const paused = autopilot.status === 'paused';

   return (
      <div className="w-full">
         <div className="flex flex-wrap items-start justify-between gap-3 border-b px-6 py-4">
            <div className="min-w-0">
               <Link href={`/${orgId}/autopilots`} className="text-muted-foreground">
                  autopilots
               </Link>
               <h1 className="mt-1 font-display tracking-[-0.025em]">{autopilot.name}</h1>
               <div className="mt-1 flex items-center gap-2 text-muted-foreground">
                  <Badge variant={paused ? 'secondary' : 'default'}>{autopilot.status}</Badge>
                  <span>v{autopilot.version}</span>
               </div>
            </div>
            <div className="flex flex-wrap gap-2">
               <Button
                  type="button"
                  onClick={() => void act(async () => {
                     const outcome = await runAutopilot(autopilot.id);
                     if (outcome.status !== 'enqueued') throw new Error(`Not queued: ${outcome.reasonCode ?? outcome.status}`);
                  }, 'Queued a run')}
               >
                  run now
               </Button>
               <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                     void act(
                        () => updateAutopilot(autopilot.id, { status: paused ? 'active' : 'paused' }),
                        paused ? 'Resumed' : 'Paused'
                     )
                  }
               >
                  {paused ? 'resume' : 'pause'}
               </Button>
               <Button type="button" variant="outline" onClick={() => setEditing(true)}>
                  edit
               </Button>
               <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                     void archiveAutopilot(autopilot.id)
                        .then(() => router.push(`/${orgId}/autopilots`))
                        .catch((failure: unknown) => toast.error(describeAutopilotFailure(failure)))
                  }
               >
                  archive
               </Button>
            </div>
         </div>

         <pre className="mx-6 mt-4 whitespace-pre-wrap rounded-md border p-3 text-muted-foreground">
            {autopilot.promptTemplate}
         </pre>

         <Tabs defaultValue="triggers" className="mt-4">
            <TabsList className="mx-6">
               <TabsTrigger value="triggers">Triggers</TabsTrigger>
               <TabsTrigger value="runs">Runs</TabsTrigger>
               <TabsTrigger value="deliveries">Deliveries</TabsTrigger>
            </TabsList>
            <TabsContent value="triggers">
               <TriggersTab autopilot={autopilot} onChanged={reload} />
            </TabsContent>
            <TabsContent value="runs">
               <RunsTable runs={runs} orgId={orgId} />
            </TabsContent>
            <TabsContent value="deliveries">
               <DeliveriesTable autopilotId={autopilot.id} deliveries={deliveries} onReplayed={reload} />
            </TabsContent>
         </Tabs>

         <AutopilotDialog
            open={editing}
            onOpenChange={(open) => {
               setEditing(open);
               if (!open) reload();
            }}
            autopilot={autopilot}
         />
      </div>
   );
}
```

Create `frontend/app/[orgId]/autopilot/[autopilotId]/page.tsx`:

```tsx
import AutopilotDetail from '@/components/common/autopilots/autopilot-detail';
import MainLayout from '@/components/layout/main-layout';

interface Props {
   params: Promise<{ orgId: string; autopilotId: string }>;
}

export default async function AutopilotPage({ params }: Props) {
   const { autopilotId } = await params;
   return (
      <MainLayout>
         <AutopilotDetail autopilotId={autopilotId} />
      </MainLayout>
   );
}
```

- [ ] **Step 4: Lint, build and check by hand**

Run: `cd /Users/secret/Code/berry-circle && pnpm lint:frontend && cd frontend && pnpm build:check`
Expected: no lint errors, and the build lists `/[orgId]/autopilot/[autopilotId]`. Then, in the running app, open an autopilot:
- Add a schedule. The preview lists five local times, and a typo such as `99 * * * *` shows the server's message instead.
- Add a webhook. The one-time notice shows the endpoint and secret. Reload the page: the secret is gone, and only `····<hint>` remains.
- Send a signed delivery. Its row appears in Deliveries within a second and its run in Runs, both refreshed by the workspace stream. Use this, filling in `<token>` and `<secret>`:
  ```
  body='{"event":"deploy","build":1}'
  sig="sha256=$(printf %s "$body" | openssl dgst -sha256 -hmac '<secret>' -hex | sed 's/^.* //')"
  curl -X POST "http://localhost:3000/api/webhooks/autopilots/<token>" -H 'content-type: application/json' -H "x-berry-signature: $sig" -d "$body"
  ```
- "replay" adds a replay row.
- "pause" makes the next scheduled firing record `skipped / Paused`, while "run now" still queues a run.

- [ ] **Step 5: Commit**

```bash
git add "frontend/app/[orgId]/autopilot/[autopilotId]/page.tsx" frontend/components/common/autopilots/autopilot-detail.tsx frontend/components/common/autopilots/triggers-tab.tsx frontend/components/common/autopilots/history-tabs.tsx
git commit -m "feat(frontend): show an autopilot's triggers, runs and deliveries"
```

---

## Self-review (done while writing; re-check before executing)

**Spec §6 coverage.**

| Spec item | Task(s) |
|---|---|
| `autopilots` (name, agent or squad, prompt template, execution mode create/fixed, paused) | 1, 4, 7, 11 |
| `autopilot_triggers`: cron with timezone | 1, 2, 4, 12 |
| `autopilot_triggers`: webhook with token + signing secret + event filters | 1, 3, 4, 8, 12 |
| `autopilot_runs` | 1, 5, 12 |
| `webhook_deliveries` (payload, status, replay) | 1, 4, 7 (`GET /:id/deliveries/:deliveryId`, replay refuses `rejected`), 8, 12 (payload viewer, replay) |
| collaborators and subscribers | 1, 4, 7 (`PUT /:id/members`). No UI yet; see Open Questions |
| quota periods | 1, 4, 5, 11 |
| rule versions | 1, 4, 7 (`GET /:id/versions`). The version number shows on the detail page and on each run |
| leased scheduler tick in the dispatcher process, `sys_cron_executions` unique on trigger and slot | 1, 6, 9 |
| cron preview | 2, 7, 12 |
| manual trigger | 5, 7, 12 |
| token rotation | 4, 7, 12 |
| public ingress `POST /api/webhooks/autopilots/:token` with HMAC | 3, 8 |
| UI: list and detail with triggers, runs, deliveries and replay | 11, 12 |
| §11 isolation, secrets, tests, realtime | 7, 8, 9 (cross-tenant file: autopilot, trigger and delivery ids from W2, including through W1's own autopilot; topics), 4 (sealing) |

**Type consistency.**
- `FireInput`, `FireOutcome` and `FireFn` are defined once, in Task 5. Tasks 6, 7, 8 and 9 import them.
- `EnqueueTask` is structurally A's `enqueueTask`, and is never re-exported under A's name.
- `AutopilotTrigger` and `WebhookSecrets` come from Task 4, are serialized in Task 7, and are parsed by the matching Zod v3 schemas in Task 10.
- The `ingressPath` format is `/api/webhooks/autopilots/<token>` in both Task 7 and Task 12.
- `AUTOPILOT_TOPICS` are listed in Task 4 and asserted against `WORKSPACE_TOPICS` in Task 9.

**No placeholders.** Every code step carries the code. The only conditional step is Task 9 Step 5, which is gated on workstream A being merged and states the command that checks it.

## Open Questions (need a human)

1. **Squad assignee in the UI.** This is checked against D's plan: migration 088 declares `squads.leader_agent_id uuid NOT NULL`, which references agents. `resolveSquadLeader` reads exactly that column and skips archived squads. The server accepts `assigneeType: 'squad'` today. The frontend form offers agents only, because no squad list exists on the frontend until D's Task 7 lands. Should E add a squad option to the dialog after D merges, or should D add it?
2. **History pagination.** Runs and deliveries return the newest 100, and autopilots the newest 500, without cursors. That is enough for day-one parity. If the public API contract requires cursor pagination on every list, adding `(created_at, id)` cursors is a follow-up to Task 7.
3. **Collaborators and subscribers: behaviour and UI.** Storage and `PUT /:id/members` exist, but nothing yet notifies subscribers when a run fails, and there is no members editor in the UI. Should failed-run notifications go into B's inbox and subscriber feed, and should that be E's work or B's?
4. **Missed-slot policy.** When the server was down across several slots, the scheduler fires once and moves on (see Task 6). Confirm that this "no catch-up burst" rule is the product behaviour wanted.
5. **One-time secret reveal vs spec §11.** §11 says secrets are "never sent to the browser". A webhook's token and signing secret must reach the person who configures the sender, so this plan returns them exactly once, in the create and rotate responses, with `no-store`, and never again. Confirm that this one-time reveal is an accepted exception to §11, or name another delivery channel for it.
6. **Replay protection on ingress.** The HMAC covers the body only. There is no timestamp or nonce, so a captured signed request can be re-sent later and fire again. Spec §6 asks only for "HMAC verification". If protection against re-sent requests is wanted, one option is a signed `X-Berry-Timestamp` with a 5-minute window and a nonce stored in `webhook_deliveries`, added to Tasks 3 and 8.
7. **History retention.** `sys_cron_executions` is pruned after 30 days (Task 6). `autopilot_runs` and `webhook_deliveries` (payloads up to 256 KiB each) are kept for as long as the autopilot exists. Should they have a retention window too?
