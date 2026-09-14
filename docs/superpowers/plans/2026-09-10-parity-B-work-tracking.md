# Work Tracking (Workstream B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship spec section 3 end to end: custom properties and metadata, reactions, comment resolve/edit/delete in the UI, subscribers feeding the inbox, sub-issues with stage barriers, custom statuses, saved views (CRUD, per-user preferences, server-side grouped and faceted queries) with table, swimlane and gantt layouts, a timeline, pins, quick actions, batch operations, move/reorder, quick create, assignee frequency, and workspace join links.

**Architecture:** The six existing-but-unused tables (`issue_reactions`, `comment_reactions`, `user_pins`, `issue_property_definitions`/`issue_property_values`, `quick_action_definitions`, `issue_subscribers`) plus `saved_issue_views`/`issue_view_preferences` get repository modules under a new `server-ts/src/work/` directory. Each is a set of plain functions taking a `Queryable`, so a mount can run them inside `ScopedDb.mutate` or `sql.begin`. Five migrations (060–064) add the missing columns and one table. HTTP stays in mounts, and the new routes hang off the existing prefixes through the nesting hooks those mounts already use (`issues`, `comments`, `catalogs`, `views`), plus two new prefixes (`/api/v1/pins`, `/api/v1/join-links`). Every write records an `outbox_events` row, which gives realtime and the timeline for free.

**Tech Stack:** Node 22 `--experimental-strip-types`, Hono, postgres.js, Zod v4 (server), `node --test`; Next.js 15, Zustand, Zod v3, shadcn/ui primitives in `frontend/components/ui`.

**Spec:** `docs/superpowers/specs/2026-09-10-multica-parity-design.md` §3 (plus §11 cross-cutting rules).

## Global Constraints

- Migrations use block **060–079** only (spec text saying "starts at 053" is superseded by the cross-plan block table). Forward-only, `.up.sql` only, never edit an applied file. The runner applies pending versions in name order, so 060+ may land before A's 053–059.
- Every new table carries `workspace_id`. Every new mount goes through the workspace guard (`mountWorkspaceScope`, `resolveScoped`, or `IssueRepository.authorize`) and is covered by a two-workspace leakage test.
- Server: no emitted TS syntax (no enums, namespaces, parameter properties), relative imports with `.ts` extensions, `import type` for types, 3-space indent, single quotes, no `any`, no `!` non-null assertions in new non-test code. Zod v4 (`import { z } from 'zod'`).
- Frontend: Prettier 3-space, single quotes, semicolons, `es5` trailing commas, width 100; Zod v3 (`z.string().uuid()`, not `z.uuid()`); all traffic through `apiFetch` in `frontend/lib/api.ts`. Gates: `pnpm lint` and `pnpm build:check` (never `pnpm build` while `next dev` runs).
- Errors: `ApiError(status, 'SCREAMING_SNAKE', message, details?)`, and 422 `VALIDATION_FAILED` with `{ fields }` for body problems.
- DB-backed tests self-skip when `BERRY_TEST_DATABASE_URL` is unset.
- Realtime: new events go through `outbox_events` and the SSE hub (`Broadcaster.publish`). No WebSocket.
- Clean-room: never copy multica source, schema, copy or UI. Web only. No new integrations. **No Google OAuth or any login/auth-provider work** (user decision).
- Shared cross-plan names are consumed, never redefined: `enqueueTask` (A, `server-ts/src/runs/queue.ts`) is taken by quick actions through an injected function whose type mirrors A's signature.
- Commits: `type(scope): imperative summary`, scope `server-ts` or `frontend`, ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. Do not push.

## Cross-workstream seams

| Seam | Owner | Consumer |
|---|---|---|
| `QuickActionEnqueue` param of `issueTrackingRoutes` | B | wired to A's `enqueueTask` in `index.ts` (Task 14) once `runs/queue.ts` exists |
| `StageGate` 4th param of `autoDispatch` (`runs/auto-dispatch.ts`) | B | A, if it rewrites `autoDispatch` onto `enqueueTask`, keeps the gate check |
| `parseMentions` in `server-ts/src/work/mentions.ts`, token `[@Name](mention://user/<uuid>)` / `mention://agent/<uuid>` | B | D (mention triggers) should reuse this syntax and parser |
| `settingsNav` in `frontend/components/layout/sidebar/nav-settings.tsx` | I (structure) | B appends three items (Task 16) |
| Outbox topics `issue.properties.changed`, `issue.metadata.changed`, `issue.hierarchy.changed`, `issue.reactions.changed`, `issue.subscribers.changed`, `comment.reactions.changed`, `comment.resolved`, `comment.unresolved` | B | realtime clients, the timeline (Task 10) |
| `inbox_items` written directly by `notifySubscribers` | B | the future inbox projector must skip items that already have a `source_event_id` |

## File Structure

**Server — migrations**
- `server-ts/migrations/060_issue_properties_people_and_metadata.up.sql` — person/multi-person kinds; `issues.metadata`.
- `061_issue_hierarchy_and_stages.up.sql` — `issues.parent_id`, `issues.stage`, same-workspace trigger.
- `062_custom_issue_statuses.up.sql` — `issues.status_id` + category trigger; `mentioned` subscriber reason.
- `063_issue_timeline_index.up.sql` — outbox index by issue.
- `064_workspace_join_links.up.sql` — `workspace_join_links`.

**Server — domain (`server-ts/src/work/`)**, one responsibility per file:
- `fixture.ts` — shared DB test world (imported by tests only).
- `http.ts` — `parseJsonBody`, `rethrowAs`, `failureCode`.
- `outbox.ts` — `recordIssueEvent`, `publishEvents`.
- `mentions.ts` — mention token parser.
- `properties.ts` — property definitions and values; `metadata.ts` — issue metadata.
- `reactions.ts` — issue and comment reactions; `comment-resolution.ts` — resolve/unresolve.
- `subscribers.ts` — subscriptions and inbox notification.
- `hierarchy.ts` — parent/child, stages, `stageGate`.
- `statuses.ts` — custom statuses.
- `views.ts` — saved views and preferences; `issue-query.ts` — grouped/faceted query.
- `activity.ts` — timeline; `pins.ts`; `quick-actions.ts`.
- `batch.ts` — batch/move/quick-create schemas and helpers, assignee frequency; `join-links.ts`.
- `hooks.ts` — after-write hooks (auto-subscribe, notify, stage release).

**Server — mounts**
- Create `server-ts/src/mounts/issue-tracking.ts` (routes nested under `/api/v1/issues`), `comment-tracking.ts` (under `/api/v1/comments`), `work-catalogs.ts` (under `/api/v1/catalogs/:workspaceId`), `view-routes.ts` (under `/api/v1/views`), `pins.ts` (`/api/v1/pins`), `join-links.ts` (`/api/v1/join-links`).
- Modify `mounts/issues.ts` (options `tracking`, `stages`, `hooks`; export `serializeIssue`; new fields), `mounts/comments.ts` (options `extensions`, `hooks`), `mounts/workspace-reads.ts` (options `catalogExtensions`, `viewExtensions`), `core/issues.ts` (row fields, `IssuePatch.statusId`), `runs/auto-dispatch.ts` (stage gate), `index.ts`, `SCOPE.md`.

**Frontend**
- Create `frontend/lib/parse-response.ts`, `lib/properties.ts`, `lib/reactions.ts`, `lib/subscribers.ts`, `lib/issue-tracking.ts`, `lib/activity.ts`, `lib/pins.ts`, `lib/quick-actions.ts`, `lib/join-links.ts`; modify `lib/comments.ts`, `lib/views.ts`, `lib/settings.ts`, `lib/issues.ts`.
- Settings: `components/common/settings/{issue-properties-settings,quick-actions-settings,join-links-settings}.tsx`, modify `project-statuses-settings.tsx`, pages `app/[orgId]/settings/{issue-properties,quick-actions,join-links}/page.tsx`, modify `components/layout/sidebar/nav-settings.tsx`.
- Issue detail: `components/common/issues/details/{issue-custom-properties,issue-reactions,issue-subscription,sub-issues,issue-quick-actions,custom-status-select,comment-actions}.tsx`; modify `issue-details.tsx`, `issue-properties-panel.tsx`, `activity-feed.tsx`, `data/issue-details.ts`.
- Views: `components/common/issues/{issue-table,issue-swimlanes,issue-gantt,batch-toolbar,quick-create}.tsx`, `lib/use-virtual-rows.ts`, `store/issue-selection-store.ts`, `store/pins-store.ts`, `components/common/views/{save-view-dialog,view-facets}.tsx`, `components/layout/shell/shell-pins.tsx`, `components/common/issues/details/issue-pin-button.tsx`, `app/join/[token]/page.tsx`; modify `store/view-store.ts`, `components/layout/headers/display-options.tsx`, `components/common/issues/all-issues.tsx`, `components/common/views/{views,view-details}.tsx`, `components/layout/shell/shell-rail.tsx`.

## Task order and parallelism

1 → 2 → 3 run in sequence. Then 4–11 are independent: each owns its own `work/*.ts` file and test. After that, 12 and 13 can run in parallel, and 14 runs last on the server.

The frontend can start once the wire shapes are frozen, which is the contract block in Task 15. It does not wait for the server. 15 runs first, then 16–21 in parallel, then 22.

## Running the DB-backed tests

The test database is a schema-only copy of the development database, so it has to be recreated after migrating. The commands below extend `server-ts/ROUTING.md`:

```bash
docker run -d --rm --name berry-pg-bridge --network berry-stack_default \
  -p 15432:15432 alpine/socat tcp-listen:15432,fork,reuseaddr tcp:postgres:5432
DATABASE_URL='postgres://berry:berry@127.0.0.1:15432/berry?sslmode=disable' pnpm migrate:server
docker compose exec -T postgres sh -c \
  'dropdb -U berry --if-exists berry_test; createdb -U berry berry_test; pg_dump -U berry --schema-only --no-owner --no-privileges berry | psql -U berry -d berry_test -q'
export BERRY_TEST_DATABASE_URL='postgres://berry:berry@127.0.0.1:15432/berry_test?sslmode=disable'
```

Single file: `cd server-ts && node --test --experimental-strip-types src/work/<file>.test.ts`.

---

### Task 1: Migrations 060–064 and the shared test world

**Files:**
- Create: `server-ts/migrations/060_issue_properties_people_and_metadata.up.sql`, `061_issue_hierarchy_and_stages.up.sql`, `062_custom_issue_statuses.up.sql`, `063_issue_timeline_index.up.sql`, `064_workspace_join_links.up.sql`
- Create: `server-ts/src/work/fixture.ts`
- Test: `server-ts/src/work/schema.test.ts`

**Interfaces:**
- Consumes: existing tables from migrations 001–008.
- Produces: columns `issues.metadata jsonb`, `issues.parent_id uuid`, `issues.stage integer`, `issues.status_id uuid`; property kinds `person`, `multi_person`; subscriber reason `mentioned`; table `workspace_join_links(id, workspace_id, role, token_hash, created_by, expires_at, max_uses, use_count, revoked_at, created_at)`; index `outbox_events_issue_timeline_idx`.
- Produces (`fixture.ts`): `interface World { workspaceId; boardId; ownerId; memberId; viewerId; agentId; issueId }`, `seedWorld(sql: Sql, tag: string): Promise<World>`, `createIssue(sql: Sql, world: World, fields?: IssueFields): Promise<string>`, `interface IssueFields { title?: string; status?: string; parentId?: string | null; stage?: number | null; agentAssignee?: boolean }`, `cleanupWorld(sql: Sql, world: World): Promise<void>`.

- [ ] **Step 1: Write the fixture**

`server-ts/src/work/fixture.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/pool.ts';

/**
 * A populated workspace for the work-tracking tests.
 *
 * Not a test file (no `.test.ts`), so the runner never executes it; tests
 * import it. `cleanupWorld` removes what `seedWorld` made in dependency order,
 * including the protected orchestrator the workspace trigger provisions.
 */
export interface World {
   workspaceId: string;
   boardId: string;
   ownerId: string;
   memberId: string;
   viewerId: string;
   agentId: string;
   issueId: string;
}

export interface IssueFields {
   title?: string;
   status?: string;
   parentId?: string | null;
   stage?: number | null;
   agentAssignee?: boolean;
}

function first(rows: ReadonlyArray<Record<string, unknown>>, what: string): Record<string, unknown> {
   const row = rows[0];
   if (!row) throw new Error(`${what} insert returned no row`);
   return row;
}

async function createUser(sql: Sql, handle: string, name: string): Promise<string> {
   const rows = await sql`
      INSERT INTO users (id, email, name)
      VALUES (${randomUUID()}, ${`${handle}@berry.test`}, ${name})
      RETURNING id`;
   return first(rows, 'user').id as string;
}

export async function seedWorld(sql: Sql, tag: string): Promise<World> {
   const suffix = `${tag}-${randomUUID().slice(0, 8)}`;
   const ownerId = await createUser(sql, `owner-${suffix}`, 'Owner');
   const memberId = await createUser(sql, `member-${suffix}`, 'Member');
   const viewerId = await createUser(sql, `viewer-${suffix}`, 'Viewer');

   const workspace = first(
      await sql`
         INSERT INTO workspaces (id, name, slug, settings, created_by)
         VALUES (${randomUUID()}, ${`Work ${suffix}`}, ${`work-${suffix}`},
                 ${sql.json({ issuePrefix: 'WRK', defaultRole: 'member', allowMemberInvites: false } as never)},
                 ${ownerId})
         RETURNING id`,
      'workspace'
   );
   const workspaceId = workspace.id as string;
   for (const [userId, role] of [
      [ownerId, 'owner'],
      [memberId, 'member'],
      [viewerId, 'viewer'],
   ] as const) {
      await sql`
         INSERT INTO workspace_memberships (workspace_id, user_id, role)
         VALUES (${workspaceId}, ${userId}, ${role})`;
   }

   const board = first(
      await sql`
         INSERT INTO boards (id, workspace_id, name, slug, created_by)
         VALUES (${randomUUID()}, ${workspaceId}, 'Work', ${`wrk-${suffix}`}, ${ownerId})
         RETURNING id`,
      'board'
   );
   const boardId = board.id as string;

   const agent = first(
      await sql`
         INSERT INTO agents (id, workspace_id, board_id, name, status)
         VALUES (${randomUUID()}, ${workspaceId}, ${boardId}, 'Worker', 'available')
         RETURNING id`,
      'agent'
   );

   const world: World = {
      workspaceId,
      boardId,
      ownerId,
      memberId,
      viewerId,
      agentId: agent.id as string,
      issueId: '',
   };
   world.issueId = await createIssue(sql, world, { title: 'Root task' });
   return world;
}

export async function createIssue(sql: Sql, world: World, fields: IssueFields = {}): Promise<string> {
   const id = randomUUID();
   const counter = first(
      await sql`
         UPDATE boards SET issue_counter = issue_counter + 1 WHERE id = ${world.boardId}
         RETURNING issue_counter`,
      'counter'
   );
   await sql`
      INSERT INTO issues (id, board_id, number, title, status, parent_id, stage,
                          assignee_type, assignee_id, created_by)
      VALUES (${id}, ${world.boardId}, ${Number(counter.issue_counter)}, ${fields.title ?? 'Task'},
              ${fields.status ?? 'backlog'}::issue_status, ${fields.parentId ?? null},
              ${fields.stage ?? null},
              ${fields.agentAssignee ? 'agent' : null}::assignee_type,
              ${fields.agentAssignee ? world.agentId : null}, ${world.ownerId})`;
   return id;
}

export async function cleanupWorld(sql: Sql, world: World): Promise<void> {
   if (!world.workspaceId) return;
   await sql`DELETE FROM inbox_items WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM outbox_events WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM quick_action_definitions WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM issues WHERE board_id = ${world.boardId}`;
   await sql`ALTER TABLE agents DISABLE TRIGGER berry_agents_block_protected_delete`;
   try {
      await sql`DELETE FROM agents WHERE workspace_id = ${world.workspaceId}`;
   } finally {
      await sql`ALTER TABLE agents ENABLE TRIGGER berry_agents_block_protected_delete`;
   }
   await sql`DELETE FROM boards WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM workspaces WHERE id = ${world.workspaceId}`;
   for (const id of [world.ownerId, world.memberId, world.viewerId]) {
      await sql`DELETE FROM users WHERE id = ${id}`;
   }
}
```

- [ ] **Step 2: Write the failing schema test**

`server-ts/src/work/schema.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { cleanupWorld, createIssue, seedWorld, type World } from './fixture.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

function hasCode(code: string): (error: unknown) => boolean {
   return (error) => (error as { code?: string }).code === code;
}

describe('work-tracking schema (060-064)', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let other: World;

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'schema');
      other = await seedWorld(sql, 'schema-other');
   });

   after(async () => {
      await cleanupWorld(sql, world);
      await cleanupWorld(sql, other);
      await closeDatabase(sql);
   });

   test('a person property carries no options, and a person property with options is refused', async () => {
      await sql`
         INSERT INTO issue_property_definitions (workspace_id, name, kind)
         VALUES (${world.workspaceId}, 'Reviewer', 'person')`;
      await assert.rejects(
         sql`
            INSERT INTO issue_property_definitions (workspace_id, name, kind, config)
            VALUES (${world.workspaceId}, 'Pair', 'multi_person',
                    ${sql.json({ options: [{ id: 'a', name: 'A', color: '#111111' }] } as never)})`,
         hasCode('23514')
      );
   });

   test('a person value is stored, and a malformed one is refused by the value trigger', async () => {
      const [definition] = await sql`
         INSERT INTO issue_property_definitions (workspace_id, name, kind)
         VALUES (${world.workspaceId}, 'Pairing', 'multi_person')
         RETURNING id`;
      const propertyId = definition?.id as string;
      await sql`
         INSERT INTO issue_property_values (workspace_id, issue_id, property_id, value)
         VALUES (${world.workspaceId}, ${world.issueId}, ${propertyId},
                 ${sql.json([{ type: 'user', id: world.memberId }, { type: 'agent', id: world.agentId }] as never)})`;
      await assert.rejects(
         sql`
            UPDATE issue_property_values SET value = ${sql.json([{ type: 'team', id: world.memberId }] as never)}
             WHERE issue_id = ${world.issueId} AND property_id = ${propertyId}`,
         hasCode('23514')
      );
   });

   test('an issue starts with empty metadata', async () => {
      const [row] = await sql`SELECT metadata FROM issues WHERE id = ${world.issueId}`;
      assert.deepEqual(row?.metadata, {});
   });

   test('a parent in another workspace is refused', async () => {
      await assert.rejects(
         sql`UPDATE issues SET parent_id = ${other.issueId} WHERE id = ${world.issueId}`,
         hasCode('23503')
      );
   });

   test('an issue cannot be its own parent', async () => {
      await assert.rejects(
         sql`UPDATE issues SET parent_id = id WHERE id = ${world.issueId}`,
         hasCode('23514')
      );
   });

   test('a custom status must match the category, and a plain status change drops it', async () => {
      const [definition] = await sql`
         INSERT INTO issue_status_definitions (workspace_id, key, name, category, color, sort_order)
         VALUES (${world.workspaceId}, 'cqa', 'QA', 'in_review', '#8b5cf6', 4100)
         RETURNING id`;
      const issueId = await createIssue(sql, world, { status: 'in_review' });
      await sql`UPDATE issues SET status_id = ${definition?.id as string} WHERE id = ${issueId}`;
      await sql`UPDATE issues SET status = 'todo' WHERE id = ${issueId}`;
      const [row] = await sql`SELECT status_id FROM issues WHERE id = ${issueId}`;
      assert.equal(row?.status_id, null);
      await assert.rejects(
         sql`UPDATE issues SET status_id = ${definition?.id as string} WHERE id = ${issueId}`,
         hasCode('23514')
      );
   });

   test('mentioned is a subscription reason', async () => {
      await sql`
         INSERT INTO issue_subscribers (workspace_id, issue_id, user_id, reason)
         VALUES (${world.workspaceId}, ${world.issueId}, ${world.memberId}, 'mentioned')
         ON CONFLICT (issue_id, user_id) DO UPDATE SET reason = 'mentioned'`;
   });

   test('a join link cannot grant owner', async () => {
      await assert.rejects(
         sql`
            INSERT INTO workspace_join_links (workspace_id, role, token_hash, created_by)
            VALUES (${world.workspaceId}, 'owner', ${Buffer.alloc(32, 1)}, ${world.ownerId})`,
         hasCode('23514')
      );
   });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run (with `BERRY_TEST_DATABASE_URL` set, before the new migrations exist): `cd server-ts && node --test --experimental-strip-types src/work/schema.test.ts`
Expected: FAIL. The fixture's `INSERT INTO issues (... parent_id, stage ...)` errors with `column "parent_id" of relation "issues" does not exist`.

- [ ] **Step 4: Write the migrations**

`060_issue_properties_people_and_metadata.up.sql`:

```sql
-- Berry 060: people-valued custom properties, and free key/value metadata on
-- an issue for agents and integrations.

ALTER TABLE issue_property_definitions
    DROP CONSTRAINT IF EXISTS issue_property_definitions_kind_ck;
ALTER TABLE issue_property_definitions
    ADD CONSTRAINT issue_property_definitions_kind_ck
    CHECK (kind IN ('text', 'number', 'boolean', 'date', 'url', 'select', 'multi_select',
                    'person', 'multi_person'));

ALTER TABLE issue_property_definitions
    DROP CONSTRAINT IF EXISTS issue_property_definitions_config_shape_ck;
ALTER TABLE issue_property_definitions
    ADD CONSTRAINT issue_property_definitions_config_shape_ck
    CHECK (
        (
            kind IN ('text', 'number', 'boolean', 'date', 'url', 'person', 'multi_person')
            AND config = '{}'::jsonb
        )
        OR (
            kind IN ('select', 'multi_select')
            AND jsonb_typeof(config -> 'options') = 'array'
            AND jsonb_array_length(config -> 'options') BETWEEN 1 AND 100
        )
    );

ALTER TABLE issues ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE issues
    ADD CONSTRAINT issues_metadata_object_ck
    CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 16384);

-- The value trigger from 005 raises 'unknown property kind' for any kind it
-- does not list, so it must learn the two people kinds. Shape only here: that
-- the person is a member or agent of the workspace is checked in
-- work/properties.ts, where the error can name the field.
CREATE OR REPLACE FUNCTION berry_validate_property_value()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    property_kind text;
    property_config jsonb;
    property_archived_at timestamptz;
    scalar_value text;
BEGIN
    SELECT definition.kind, definition.config, definition.archived_at
      INTO property_kind, property_config, property_archived_at
      FROM issue_property_definitions AS definition
     WHERE definition.workspace_id = NEW.workspace_id
       AND definition.id = NEW.property_id;

    IF property_kind IS NULL OR property_archived_at IS NOT NULL THEN
        RAISE EXCEPTION 'property definition is unavailable'
            USING ERRCODE = '23503';
    END IF;

    scalar_value := NEW.value #>> '{}';
    CASE property_kind
        WHEN 'text' THEN
            IF jsonb_typeof(NEW.value) <> 'string'
               OR char_length(scalar_value) > 10000 THEN
                RAISE EXCEPTION 'invalid text property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'number' THEN
            IF jsonb_typeof(NEW.value) <> 'number' THEN
                RAISE EXCEPTION 'invalid number property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'boolean' THEN
            IF jsonb_typeof(NEW.value) <> 'boolean' THEN
                RAISE EXCEPTION 'invalid boolean property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'date' THEN
            IF jsonb_typeof(NEW.value) <> 'string'
               OR scalar_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
                RAISE EXCEPTION 'invalid date property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'url' THEN
            IF jsonb_typeof(NEW.value) <> 'string'
               OR char_length(scalar_value) > 2048
               OR scalar_value !~* '^https?://[^[:space:]]+$' THEN
                RAISE EXCEPTION 'invalid URL property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'select' THEN
            IF jsonb_typeof(NEW.value) <> 'string'
               OR NOT EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements(property_config -> 'options') AS option
                    WHERE option ->> 'id' = scalar_value
               ) THEN
                RAISE EXCEPTION 'invalid select property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'multi_select' THEN
            IF jsonb_typeof(NEW.value) <> 'array'
               OR jsonb_array_length(NEW.value) > 50
               OR EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements(NEW.value) AS selected
                    WHERE jsonb_typeof(selected) <> 'string'
                       OR NOT EXISTS (
                           SELECT 1
                             FROM jsonb_array_elements(property_config -> 'options') AS option
                            WHERE option ->> 'id' = selected #>> '{}'
                       )
               )
               OR (
                   SELECT count(*) <> count(DISTINCT selected #>> '{}')
                     FROM jsonb_array_elements(NEW.value) AS selected
               ) THEN
                RAISE EXCEPTION 'invalid multi-select property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'person' THEN
            IF jsonb_typeof(NEW.value) <> 'object'
               OR (NEW.value ->> 'type') NOT IN ('user', 'agent')
               OR (NEW.value ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                RAISE EXCEPTION 'invalid person property value' USING ERRCODE = '23514';
            END IF;
        WHEN 'multi_person' THEN
            IF jsonb_typeof(NEW.value) <> 'array'
               OR jsonb_array_length(NEW.value) > 50
               OR EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements(NEW.value) AS person
                    WHERE jsonb_typeof(person) <> 'object'
                       OR (person ->> 'type') IS NULL
                       OR (person ->> 'type') NOT IN ('user', 'agent')
                       OR (person ->> 'id') IS NULL
                       OR (person ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               )
               OR (
                   SELECT count(*) <> count(DISTINCT (person ->> 'type') || ':' || lower(person ->> 'id'))
                     FROM jsonb_array_elements(NEW.value) AS person
               ) THEN
                RAISE EXCEPTION 'invalid multi-person property value' USING ERRCODE = '23514';
            END IF;
        ELSE
            RAISE EXCEPTION 'unknown property kind' USING ERRCODE = '23514';
    END CASE;
    RETURN NEW;
END
$$;
```

`061_issue_hierarchy_and_stages.up.sql`:

```sql
-- Berry 061: sub-issues. A child points at its parent; `stage` orders siblings
-- into barriers (stage N+1 waits for every stage <= N sibling to finish).
-- A stage without a parent is ignored rather than refused, because deleting a
-- parent sets parent_id to NULL and must not fail on the child's stage.

ALTER TABLE issues
    ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES issues(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS stage integer;

ALTER TABLE issues
    ADD CONSTRAINT issues_parent_not_self_ck CHECK (parent_id IS NULL OR parent_id <> id),
    ADD CONSTRAINT issues_stage_range_ck CHECK (stage IS NULL OR stage BETWEEN 0 AND 1000);

CREATE INDEX IF NOT EXISTS issues_parent_stage_idx
    ON issues (parent_id, stage, id)
    WHERE parent_id IS NOT NULL AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION berry_issue_parent_same_workspace()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.parent_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM issues AS parent
          JOIN boards AS parent_board ON parent_board.id = parent.board_id
          JOIN boards AS child_board ON child_board.id = NEW.board_id
         WHERE parent.id = NEW.parent_id
           AND parent_board.workspace_id = child_board.workspace_id
    ) THEN
        RAISE EXCEPTION 'parent issue belongs to another workspace'
            USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER issues_parent_same_workspace
    BEFORE INSERT OR UPDATE OF parent_id, board_id ON issues
    FOR EACH ROW EXECUTE FUNCTION berry_issue_parent_same_workspace();
```

`062_custom_issue_statuses.up.sql`:

```sql
-- Berry 062: an issue may name a custom status. `issues.status` stays the
-- category (the enum the board, the ledger and the review gate address), and
-- `status_id` refines it. A status change that does not name a status_id drops
-- a status_id of another category instead of failing.

ALTER TABLE issues
    ADD COLUMN IF NOT EXISTS status_id uuid
        REFERENCES issue_status_definitions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS issues_status_id_idx
    ON issues (status_id) WHERE status_id IS NOT NULL;

CREATE OR REPLACE FUNCTION berry_issue_status_definition_matches()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    definition_category text;
    definition_workspace uuid;
    issue_workspace uuid;
BEGIN
    IF NEW.status_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT category, workspace_id
      INTO definition_category, definition_workspace
      FROM issue_status_definitions WHERE id = NEW.status_id;
    SELECT workspace_id INTO issue_workspace FROM boards WHERE id = NEW.board_id;
    IF definition_workspace IS DISTINCT FROM issue_workspace THEN
        RAISE EXCEPTION 'status belongs to another workspace' USING ERRCODE = '23503';
    END IF;
    IF definition_category <> NEW.status::text THEN
        IF TG_OP = 'UPDATE' AND NEW.status_id IS NOT DISTINCT FROM OLD.status_id THEN
            NEW.status_id := NULL;
        ELSE
            RAISE EXCEPTION 'status definition category does not match the issue status'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER issues_status_definition_matches
    BEFORE INSERT OR UPDATE OF status, status_id, board_id ON issues
    FOR EACH ROW EXECUTE FUNCTION berry_issue_status_definition_matches();

ALTER TABLE issue_subscribers DROP CONSTRAINT IF EXISTS issue_subscribers_reason_ck;
ALTER TABLE issue_subscribers
    ADD CONSTRAINT issue_subscribers_reason_ck
    CHECK (reason IN ('creator', 'assignee', 'commenter', 'mentioned', 'manual'));
```

`063_issue_timeline_index.up.sql`:

```sql
-- Berry 063: the issue timeline reads outbox_events by the envelope's issueId,
-- which issue, comment and work-tracking events all carry at the top level.
CREATE INDEX IF NOT EXISTS outbox_events_issue_timeline_idx
    ON outbox_events (workspace_id, (payload ->> 'issueId'), occurred_at, id)
    WHERE payload ? 'issueId';
```

`064_workspace_join_links.up.sql`:

```sql
-- Berry 064: shareable workspace join links. Only a SHA-256 of the token is
-- stored; the token is shown once, at creation.
CREATE TABLE IF NOT EXISTS workspace_join_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    role workspace_role NOT NULL,
    token_hash bytea NOT NULL,
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz,
    max_uses integer,
    use_count integer NOT NULL DEFAULT 0,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT workspace_join_links_role_ck CHECK (role <> 'owner'),
    CONSTRAINT workspace_join_links_token_ck CHECK (octet_length(token_hash) = 32),
    CONSTRAINT workspace_join_links_max_uses_ck CHECK (max_uses IS NULL OR max_uses BETWEEN 1 AND 10000),
    CONSTRAINT workspace_join_links_use_count_ck
        CHECK (use_count >= 0 AND (max_uses IS NULL OR use_count <= max_uses)),
    CONSTRAINT workspace_join_links_expiry_ck CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_join_links_token_key
    ON workspace_join_links (token_hash);
CREATE INDEX IF NOT EXISTS workspace_join_links_workspace_order_idx
    ON workspace_join_links (workspace_id, created_at DESC, id DESC);
```

- [ ] **Step 5: Migrate, refresh the test DB, run the test**

Run the "Running the DB-backed tests" commands, then `cd server-ts && node --test --experimental-strip-types src/work/schema.test.ts`.
Expected: PASS, 8 tests. Also `pnpm test:server` without the env var: PASS, with the suite skipped.

- [ ] **Step 6: Commit**

```bash
git add server-ts/migrations/06[0-4]_*.up.sql server-ts/src/work/fixture.ts server-ts/src/work/schema.test.ts
git commit -m "feat(server-ts): add work-tracking schema for properties, hierarchy, statuses and join links"
```

---

### Task 2: The issue row carries hierarchy, custom status and child progress

**Files:**
- Modify: `server-ts/src/core/issues.ts` (`ISSUE_COLUMNS` lines 16–25, `Issue` lines 56–82, `IssuePatch` lines 123–136, `update()` SET list ~line 450, `toIssue` ~line 761)
- Modify: `server-ts/src/mounts/issues.ts` (`serializeIssue` line 409: export it, append fields)
- Test: `server-ts/src/work/issue-row.test.ts`

**Interfaces:**
- Produces: `Issue` gains `parentId: string | null`, `stage: number | null`, `statusId: string | null`, `childProgress: { total: number; done: number }`. `IssuePatch` gains `statusId?: string | null` (undefined leaves the column alone). `export function serializeIssue(issue: Issue, relations: IssueRelations | undefined): Record<string, unknown>` in `mounts/issues.ts`, whose wire output appends `parentId, stage, statusId, childProgress`.

- [ ] **Step 1: Write the failing test**

`server-ts/src/work/issue-row.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { IssueRepository, type IssuePatch } from '../core/issues.ts';
import { cleanupWorld, createIssue, seedWorld, type World } from './fixture.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

const NO_CHANGE: IssuePatch = {
   descriptionSet: false,
   dueDateSet: false,
   assigneeSet: false,
   projectSet: false,
};

describe('issue row', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let issues: IssueRepository;

   before(async () => {
      sql = openDatabase({ url: url as string });
      issues = new IssueRepository(sql);
      world = await seedWorld(sql, 'row');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await closeDatabase(sql);
   });

   test('a child names its parent and stage, and the parent counts it', async () => {
      const child = await createIssue(sql, world, { title: 'Child', parentId: world.issueId, stage: 1 });
      const read = await issues.get(child);
      assert.equal(read.parentId, world.issueId);
      assert.equal(read.stage, 1);
      assert.deepEqual((await issues.get(world.issueId)).childProgress, { total: 1, done: 0 });

      await sql`UPDATE issues SET status = 'done' WHERE id = ${child}`;
      assert.deepEqual((await issues.get(world.issueId)).childProgress, { total: 1, done: 1 });
   });

   test('a custom status is set with its category and dropped by a plain status change', async () => {
      const [definition] = await sql`
         INSERT INTO issue_status_definitions (workspace_id, key, name, category, color, sort_order)
         VALUES (${world.workspaceId}, 'crow', 'Row QA', 'in_review', '#8b5cf6', 4200)
         RETURNING id`;
      const statusId = definition?.id as string;
      const issueId = await createIssue(sql, world, { status: 'in_progress' });

      const set = await issues.update({
         issueId,
         patch: { ...NO_CHANGE, status: 'in_review', statusId },
         actorId: world.ownerId,
      });
      assert.equal(set.issue.statusId, statusId);
      assert.equal(set.issue.status, 'inReview');

      const back = await issues.update({
         issueId,
         patch: { ...NO_CHANGE, status: 'todo' },
         actorId: world.ownerId,
      });
      assert.equal(back.issue.statusId, null);
   });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd server-ts && node --test --experimental-strip-types src/work/issue-row.test.ts`
Expected: FAIL. `read.parentId` is `undefined`, and tsc-free execution reports `'undefined' !== '<uuid>'`.

- [ ] **Step 3: Implement**

In `core/issues.ts`, replace the last line of `ISSUE_COLUMNS` (`   i.created_at, i.updated_at\`;`) with:

```ts
   i.created_at, i.updated_at,
   i.parent_id, i.stage, i.status_id,
   (SELECT count(*) FROM issues AS child
     WHERE child.parent_id = i.id AND child.deleted_at IS NULL)::int AS child_total,
   (SELECT count(*) FROM issues AS child
     WHERE child.parent_id = i.id AND child.deleted_at IS NULL
       AND child.status IN ('done', 'cancelled'))::int AS child_done`;
```

In `interface Issue`, after `updatedAt: string;` add:

```ts
   /** The issue this one is a sub-issue of. */
   parentId: string | null;
   /** Ordered barrier among siblings; null means no stage. */
   stage: number | null;
   /** The custom status refining `status`, when one is set. */
   statusId: string | null;
   childProgress: { total: number; done: number };
```

In `interface IssuePatch`, after `status?: string;` add:

```ts
   /** A custom status of `status`'s category. Undefined leaves it alone. */
   statusId?: string | null;
```

In `update()`, after the `status = CASE ...` line of the `UPDATE issues SET` list, add:

```ts
               status_id = CASE WHEN ${patch.statusId !== undefined} THEN ${patch.statusId ?? null}::uuid ELSE status_id END,
```

In `toIssue`, after the `updatedAt:` property add:

```ts
      parentId: (row.parent_id as string | null) ?? null,
      stage: row.stage === null || row.stage === undefined ? null : Number(row.stage),
      statusId: (row.status_id as string | null) ?? null,
      childProgress: { total: Number(row.child_total ?? 0), done: Number(row.child_done ?? 0) },
```

In `mounts/issues.ts`, change `function serializeIssue(` to `export function serializeIssue(`, and after `blocks: relations?.blocks ?? [],` add:

```ts
      parentId: issue.parentId,
      stage: issue.stage,
      statusId: issue.statusId,
      childProgress: issue.childProgress,
```

Then find object literals typed as `Issue` elsewhere with `grep -rn ": Issue = {\|as Issue\b" server-ts/src`, and add `parentId: null, stage: null, statusId: null, childProgress: { total: 0, done: 0 }` to each one tsc flags.

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd server-ts && node --test --experimental-strip-types src/work/issue-row.test.ts && pnpm -w typecheck:server && pnpm -w test:server`
Expected: PASS. If a wire-baseline test pins the issue key list, update its expected keys to include the four appended fields (they are additive and come after `blocks`).

- [ ] **Step 5: Commit**

```bash
git add server-ts/src/core/issues.ts server-ts/src/mounts/issues.ts server-ts/src/work/issue-row.test.ts
git commit -m "feat(server-ts): serve an issue's parent, stage, custom status and child progress"
```

---

### Task 3: Work-tracking plumbing: body parsing, outbox events, mentions

**Files:**
- Create: `server-ts/src/work/http.ts`, `server-ts/src/work/outbox.ts`, `server-ts/src/work/mentions.ts`
- Test: `server-ts/src/work/mentions.test.ts` (offline), `server-ts/src/work/outbox.test.ts` (DB)

**Interfaces:**
- Produces (`http.ts`): `parseJsonBody<T>(request: Request, schema: z.ZodType<T>): Promise<T>` (413 when over 1 MiB, 400 for bad JSON, 422 `VALIDATION_FAILED` with JSON-pointer fields), `rethrowAs(resource: string): (error: unknown) => never` (NotFound → 404, Forbidden → 403), `failureCode(error: unknown): string`.
- Produces (`outbox.ts`): `interface EventActor { type: 'user' | 'agent'; id: string }`, `interface WorkEvent { id: string; type: string; workspaceId: string; boardId: string; issueId: string; payload: string; occurredAt: Date }`, `recordIssueEvent(q: Queryable, input: { issueId: string; type: string; actor: EventActor; payload: Record<string, unknown> }): Promise<WorkEvent>`, `publishEvents(broadcaster: Broadcaster | undefined, events: WorkEvent[]): Promise<void>`.
- Produces (`mentions.ts`): `interface Mentions { users: string[]; agents: string[] }`, `parseMentions(body: string): Mentions`, `formatMention(kind: 'user' | 'agent', id: string, name: string): string`.

- [ ] **Step 1: Write the failing tests**

`server-ts/src/work/mentions.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMention, parseMentions } from './mentions.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';

test('user and agent mentions are read from their tokens, once each', () => {
   const body = `hi ${formatMention('user', USER, 'Ada')} and ${formatMention('agent', AGENT, 'Bot')}, ${formatMention('user', USER, 'Ada')}`;
   assert.deepEqual(parseMentions(body), { users: [USER], agents: [AGENT] });
});

test('a plain @name is not a mention', () => {
   assert.deepEqual(parseMentions('ping @ada please'), { users: [], agents: [] });
});

test('a malformed id is ignored', () => {
   assert.deepEqual(parseMentions('[@x](mention://user/not-a-uuid)'), { users: [], agents: [] });
});
```

`server-ts/src/work/outbox.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { recordIssueEvent } from './outbox.ts';
import { cleanupWorld, seedWorld, type World } from './fixture.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('work outbox', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'outbox');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await closeDatabase(sql);
   });

   test('an issue event is stored with the envelope the stream and the timeline read', async () => {
      const event = await recordIssueEvent(sql, {
         issueId: world.issueId,
         type: 'issue.properties.changed',
         actor: { type: 'user', id: world.ownerId },
         payload: { propertyId: 'p' },
      });
      assert.equal(event.workspaceId, world.workspaceId);
      const [row] = await sql`SELECT topic, payload FROM outbox_events WHERE id = ${event.id}`;
      assert.equal(row?.topic, 'issue.properties.changed');
      const envelope = row?.payload as Record<string, unknown>;
      assert.equal(envelope.issueId, world.issueId);
      assert.deepEqual(envelope.payload, { propertyId: 'p', actor: { type: 'user', id: world.ownerId } });
   });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd server-ts && node --test --experimental-strip-types src/work/mentions.test.ts src/work/outbox.test.ts`
Expected: FAIL with `Cannot find module '.../work/mentions.ts'`.

- [ ] **Step 3: Implement**

`server-ts/src/work/http.ts`:

```ts
import type { z } from 'zod';
import { assertValid, fieldError } from '../http/body.ts';
import { ApiError } from '../http/errors.ts';
import { Conflict, Forbidden, NotFound } from '../identity/errors.ts';
import { InvalidTransition } from '../core/issues.ts';

/** Body parsing for the work-tracking routes: one JSON value, validated once. */
const MAX_BODY_BYTES = 1 << 20;

export async function parseJsonBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
   const raw = await request.text();
   if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
   }
   let parsed: unknown;
   try {
      parsed = raw.trim() === '' ? {} : JSON.parse(raw);
   } catch {
      throw new ApiError(400, 'INVALID_REQUEST', 'The request body is not valid JSON.');
   }
   const result = schema.safeParse(parsed);
   if (result.success) return result.data;
   assertValid(
      result.error.issues.map((issue) =>
         fieldError(`/${issue.path.map(String).join('/')}`, issue.code, issue.message)
      )
   );
   throw new ApiError(422, 'VALIDATION_FAILED', 'The request is invalid.');
}

export function rethrowAs(resource: string): (error: unknown) => never {
   return (error: unknown) => {
      if (error instanceof NotFound) throw ApiError.notFound(resource);
      if (error instanceof Forbidden) {
         throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
      }
      throw error;
   };
}

/** The code a batch reports for one item it could not apply. */
export function failureCode(error: unknown): string {
   if (error instanceof ApiError) return error.code;
   if (error instanceof NotFound) return 'NOT_FOUND';
   if (error instanceof Forbidden) return 'FORBIDDEN';
   if (error instanceof InvalidTransition) return 'INVALID_STATE_TRANSITION';
   if (error instanceof Conflict) return 'CONFLICT';
   throw error;
}
```

`server-ts/src/work/outbox.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import type { Broadcaster } from '../realtime/hub.ts';

/**
 * Work-tracking facts as outbox rows. Same envelope as issue mutations
 * (`aggregateType: 'issue'`, top-level `issueId`), so the SSE stream replays
 * them and the timeline finds them through `outbox_events_issue_timeline_idx`.
 */
export interface EventActor {
   type: 'user' | 'agent';
   id: string;
}

export interface WorkEvent {
   id: string;
   type: string;
   workspaceId: string;
   boardId: string;
   issueId: string;
   payload: string;
   occurredAt: Date;
}

export async function recordIssueEvent(
   q: Queryable,
   input: { issueId: string; type: string; actor: EventActor; payload: Record<string, unknown> }
): Promise<WorkEvent> {
   const [scope] = await q`
      SELECT board.workspace_id, board.id AS board_id
        FROM issues AS issue
        JOIN boards AS board ON board.id = issue.board_id
       WHERE issue.id = ${input.issueId}`;
   if (!scope) throw new NotFound();
   const workspaceId = scope.workspace_id as string;
   const boardId = scope.board_id as string;
   const id = randomUUID();
   const occurredAt = new Date();
   const payload = { ...input.payload, actor: input.actor };
   const envelope = {
      id,
      type: input.type,
      occurredAt: occurredAt.toISOString(),
      workspaceId,
      boardId,
      issueId: input.issueId,
      runId: null,
      sequence: null,
      aggregateType: 'issue',
      aggregateId: input.issueId,
      payload,
   };
   await q`
      INSERT INTO outbox_events (
         id, topic, aggregate_type, aggregate_id, workspace_id, board_id,
         payload, occurred_at, available_at
      ) VALUES (
         ${id}, ${input.type}, 'issue', ${input.issueId}, ${workspaceId}, ${boardId},
         ${q.json(envelope as never)}, ${occurredAt.toISOString()}, ${occurredAt.toISOString()}
      )`;
   return {
      id,
      type: input.type,
      workspaceId,
      boardId,
      issueId: input.issueId,
      payload: JSON.stringify(payload),
      occurredAt,
   };
}

/** Best effort: the row is already committed, so a relay outage costs latency only. */
export async function publishEvents(
   broadcaster: Broadcaster | undefined,
   events: WorkEvent[]
): Promise<void> {
   if (!broadcaster) return;
   for (const event of events) {
      await broadcaster
         .publish({
            id: event.id,
            workspaceId: event.workspaceId,
            boardId: event.boardId,
            type: event.type,
            payload: event.payload,
            occurredAt: event.occurredAt,
         })
         .catch(() => undefined);
   }
}
```

`server-ts/src/work/mentions.ts`:

```ts
/**
 * Mentions are markdown links with a `mention://` target:
 * `[@Ada](mention://user/<uuid>)`, `[@Reviewer](mention://agent/<uuid>)`.
 *
 * A link rather than a bare `@name` because a name is not an identity, and the
 * description and comment fields are stored byte for byte.
 */
const MENTION =
   /\[@[^\]\n]{1,100}\]\(mention:\/\/(user|agent)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;

export interface Mentions {
   users: string[];
   agents: string[];
}

export function parseMentions(body: string): Mentions {
   const users = new Set<string>();
   const agents = new Set<string>();
   for (const match of body.matchAll(MENTION)) {
      const kind = (match[1] ?? '').toLowerCase();
      const id = (match[2] ?? '').toLowerCase();
      if (kind === 'user') users.add(id);
      if (kind === 'agent') agents.add(id);
   }
   return { users: [...users], agents: [...agents] };
}

export function formatMention(kind: 'user' | 'agent', id: string, name: string): string {
   return `[@${name.replace(/[\]\n]/g, '')}](mention://${kind}/${id})`;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types src/work/mentions.test.ts src/work/outbox.test.ts && pnpm -w typecheck:server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server-ts/src/work/http.ts server-ts/src/work/outbox.ts server-ts/src/work/mentions.ts server-ts/src/work/mentions.test.ts server-ts/src/work/outbox.test.ts
git commit -m "feat(server-ts): add work-tracking body parsing, outbox events and mention parsing"
```

---
### Task 4: Custom properties and issue metadata

**Files:**
- Create: `server-ts/src/work/properties.ts`, `server-ts/src/work/metadata.ts`
- Test: `server-ts/src/work/properties.test.ts`

**Interfaces:**
- Consumes: `World`, `seedWorld`, `createIssue`, `cleanupWorld` (Task 1).
- Produces (`properties.ts`): `PROPERTY_KINDS`, `type PropertyKind`, `type PropertyOption = { id: string; name: string; color: string }`, `propertyCreateSchema`, `propertyPatchSchema`, `type PropertyCreate`, `type PropertyPatch`, `interface PropertyDefinition { id; workspaceId; name; description: string | null; kind: PropertyKind; options: PropertyOption[]; icon: string | null; sortOrder: number; createdAt: string; updatedAt: string; archivedAt: string | null }`, `serializeProperty(d: PropertyDefinition): Record<string, unknown>`, classes `PropertyNameTaken`, `PropertyKindMismatch`, `InvalidPropertyValue { issues: Array<{ path: string; message: string }> }`, and functions:
  - `listProperties(q: Queryable, workspaceId: string, includeArchived: boolean): Promise<PropertyDefinition[]>`
  - `getProperty(q, workspaceId, propertyId): Promise<PropertyDefinition>` (NotFound when missing or archived)
  - `createProperty(q, workspaceId, actorId, input: PropertyCreate): Promise<PropertyDefinition>`
  - `updateProperty(q, workspaceId, propertyId, patch: PropertyPatch): Promise<PropertyDefinition>`
  - `archiveProperty(q, workspaceId, propertyId): Promise<boolean>`
  - `listValues(q, workspaceId, issueId): Promise<Array<{ propertyId: string; value: unknown }>>`
  - `setValue(q, input: { workspaceId; issueId; propertyId; value: unknown; actorId }): Promise<{ propertyId: string; value: unknown }>`
  - `clearValue(q, workspaceId, issueId, propertyId): Promise<boolean>`
- Produces (`metadata.ts`): `metadataPatchSchema`, `type MetadataPatch = { set?: Record<string, string | number | boolean | null>; remove?: string[] }`, `MAX_METADATA_KEYS = 50`, class `MetadataTooLarge`, `readMetadata(q, issueId): Promise<Record<string, unknown>>`, `patchMetadata(q, issueId, patch: MetadataPatch): Promise<Record<string, unknown>>`.

- [ ] **Step 1: Write the failing test**

`server-ts/src/work/properties.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { cleanupWorld, seedWorld, type World } from './fixture.ts';
import {
   InvalidPropertyValue,
   PropertyNameTaken,
   archiveProperty,
   createProperty,
   listValues,
   propertyCreateSchema,
   setValue,
} from './properties.ts';
import { MetadataTooLarge, patchMetadata, readMetadata } from './metadata.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('custom properties', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let other: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'props');
      other = await seedWorld(sql, 'props-other');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await cleanupWorld(sql, other);
      await closeDatabase(sql);
   });

   test('a select without options is refused by the schema', () => {
      assert.equal(propertyCreateSchema.safeParse({ name: 'Size', kind: 'select' }).success, false);
      assert.equal(
         propertyCreateSchema.safeParse({ name: 'Notes', kind: 'text', options: [] }).success,
         false
      );
   });

   test('a property name is unique per workspace, ignoring case', async () => {
      await createProperty(sql, world.workspaceId, world.ownerId, propertyCreateSchema.parse({ name: 'Effort', kind: 'number' }));
      await assert.rejects(
         createProperty(sql, world.workspaceId, world.ownerId, propertyCreateSchema.parse({ name: 'effort', kind: 'text' })),
         PropertyNameTaken
      );
   });

   test('a select value must be one of its options', async () => {
      const size = await createProperty(
         sql,
         world.workspaceId,
         world.ownerId,
         propertyCreateSchema.parse({
            name: 'Size',
            kind: 'select',
            options: [
               { id: 's', name: 'Small', color: '#111111' },
               { id: 'l', name: 'Large', color: '#222222' },
            ],
         })
      );
      await setValue(sql, { workspaceId: world.workspaceId, issueId: world.issueId, propertyId: size.id, value: 's', actorId: world.ownerId });
      await assert.rejects(
         setValue(sql, { workspaceId: world.workspaceId, issueId: world.issueId, propertyId: size.id, value: 'xl', actorId: world.ownerId }),
         InvalidPropertyValue
      );
      const values = await listValues(sql, world.workspaceId, world.issueId);
      assert.deepEqual(values.find((entry) => entry.propertyId === size.id)?.value, 's');
   });

   test('a person must belong to the workspace', async () => {
      const owner = await createProperty(sql, world.workspaceId, world.ownerId, propertyCreateSchema.parse({ name: 'Owner', kind: 'person' }));
      await setValue(sql, { workspaceId: world.workspaceId, issueId: world.issueId, propertyId: owner.id, value: { type: 'user', id: world.memberId }, actorId: world.ownerId });
      await assert.rejects(
         setValue(sql, { workspaceId: world.workspaceId, issueId: world.issueId, propertyId: owner.id, value: { type: 'user', id: other.ownerId }, actorId: world.ownerId }),
         InvalidPropertyValue
      );
   });

   test('an archived property drops out of an issue\'s values', async () => {
      const flag = await createProperty(sql, world.workspaceId, world.ownerId, propertyCreateSchema.parse({ name: 'Flag', kind: 'boolean' }));
      await setValue(sql, { workspaceId: world.workspaceId, issueId: world.issueId, propertyId: flag.id, value: true, actorId: world.ownerId });
      assert.equal(await archiveProperty(sql, world.workspaceId, flag.id), true);
      const values = await listValues(sql, world.workspaceId, world.issueId);
      assert.equal(values.some((entry) => entry.propertyId === flag.id), false);
   });

   test('metadata merges, removes, and refuses more than fifty keys', async () => {
      await patchMetadata(sql, world.issueId, { set: { 'ci.run': 42, owner: 'ada' } });
      await patchMetadata(sql, world.issueId, { remove: ['owner'] });
      assert.deepEqual(await readMetadata(sql, world.issueId), { 'ci.run': 42 });
      const many = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`k${index}`, index]));
      await assert.rejects(
         sql.begin((tx) => patchMetadata(tx, world.issueId, { set: many })),
         MetadataTooLarge
      );
   });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd server-ts && node --test --experimental-strip-types src/work/properties.test.ts`
Expected: FAIL with `Cannot find module '.../work/properties.ts'`.

- [ ] **Step 3: Implement `properties.ts`**

```ts
import { z } from 'zod';
import { toRFC3339, type Queryable } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';

/**
 * Workspace-defined issue fields. The kind decides the value's shape; the value
 * is validated against the definition on every write, because the table only
 * checks that it is jsonb of bounded size.
 */
export const PROPERTY_KINDS = [
   'text',
   'number',
   'boolean',
   'date',
   'url',
   'select',
   'multi_select',
   'person',
   'multi_person',
] as const;
export type PropertyKind = (typeof PROPERTY_KINDS)[number];

const SELECT_KINDS: ReadonlySet<string> = new Set(['select', 'multi_select']);

const optionSchema = z
   .object({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
      name: z.string().trim().min(1).max(100),
      color: z.string().regex(/^#[0-9a-f]{6}$/),
   })
   .strict();
export type PropertyOption = z.infer<typeof optionSchema>;

const optionsSchema = z
   .array(optionSchema)
   .min(1)
   .max(100)
   .refine((options) => new Set(options.map((option) => option.id)).size === options.length, {
      message: 'Option ids must be unique.',
   });

export const propertyCreateSchema = z
   .object({
      name: z.string().trim().min(1).max(100),
      description: z.string().trim().max(1000).nullable().default(null),
      kind: z.enum(PROPERTY_KINDS),
      options: optionsSchema.optional(),
      icon: z.string().min(1).max(100).nullable().default(null),
      sortOrder: z.number().int().min(0).max(1_000_000_000).default(0),
   })
   .strict()
   .superRefine((value, context) => {
      if (SELECT_KINDS.has(value.kind) && !value.options) {
         context.addIssue({ code: 'custom', path: ['options'], message: 'A select needs at least one option.' });
      }
      if (!SELECT_KINDS.has(value.kind) && value.options) {
         context.addIssue({ code: 'custom', path: ['options'], message: 'Only a select has options.' });
      }
   });
export type PropertyCreate = z.infer<typeof propertyCreateSchema>;

/** The kind is not patchable: stored values were validated against it. */
export const propertyPatchSchema = z
   .object({
      name: z.string().trim().min(1).max(100).optional(),
      description: z.string().trim().max(1000).nullable().optional(),
      options: optionsSchema.optional(),
      icon: z.string().min(1).max(100).nullable().optional(),
      sortOrder: z.number().int().min(0).max(1_000_000_000).optional(),
   })
   .strict();
export type PropertyPatch = z.infer<typeof propertyPatchSchema>;

export interface PropertyDefinition {
   id: string;
   workspaceId: string;
   name: string;
   description: string | null;
   kind: PropertyKind;
   options: PropertyOption[];
   icon: string | null;
   sortOrder: number;
   createdAt: string;
   updatedAt: string;
   archivedAt: string | null;
}

export class PropertyNameTaken extends Error {
   constructor() {
      super('a property with that name exists');
      this.name = 'PropertyNameTaken';
   }
}

export class PropertyKindMismatch extends Error {
   constructor() {
      super('only a select property has options');
      this.name = 'PropertyKindMismatch';
   }
}

export class InvalidPropertyValue extends Error {
   readonly issues: Array<{ path: string; message: string }>;
   constructor(issues: Array<{ path: string; message: string }>) {
      super('invalid property value');
      this.name = 'InvalidPropertyValue';
      this.issues = issues;
   }
}

const COLUMNS =
   'id, workspace_id, name, description, kind, config, icon, sort_order, created_at, updated_at, archived_at';

function toDefinition(row: Record<string, unknown>): PropertyDefinition {
   const config = (row.config ?? {}) as { options?: unknown };
   return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      kind: row.kind as PropertyKind,
      options: Array.isArray(config.options) ? (config.options as PropertyOption[]) : [],
      icon: (row.icon as string | null) ?? null,
      sortOrder: Number(row.sort_order),
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
      archivedAt: toRFC3339((row.archived_at as string | null) ?? null),
   };
}

export function serializeProperty(definition: PropertyDefinition): Record<string, unknown> {
   return { ...definition };
}

function mapNameConflict(error: unknown): never {
   if ((error as { code?: string }).code === '23505') throw new PropertyNameTaken();
   throw error;
}

export async function listProperties(
   q: Queryable,
   workspaceId: string,
   includeArchived: boolean
): Promise<PropertyDefinition[]> {
   const rows = await q`
      SELECT ${q.unsafe(COLUMNS)} FROM issue_property_definitions
       WHERE workspace_id = ${workspaceId} AND (${includeArchived} OR archived_at IS NULL)
       ORDER BY sort_order, lower(name), id`;
   return rows.map(toDefinition);
}

export async function getProperty(
   q: Queryable,
   workspaceId: string,
   propertyId: string
): Promise<PropertyDefinition> {
   const [row] = await q`
      SELECT ${q.unsafe(COLUMNS)} FROM issue_property_definitions
       WHERE id = ${propertyId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
   if (!row) throw new NotFound();
   return toDefinition(row);
}

export async function createProperty(
   q: Queryable,
   workspaceId: string,
   actorId: string,
   input: PropertyCreate
): Promise<PropertyDefinition> {
   const config = input.options ? { options: input.options } : {};
   const rows = await q`
      INSERT INTO issue_property_definitions
         (workspace_id, name, description, kind, config, icon, sort_order, created_by)
      VALUES (${workspaceId}, ${input.name}, ${input.description}, ${input.kind},
              ${q.json(config as never)}, ${input.icon}, ${input.sortOrder}, ${actorId})
      RETURNING ${q.unsafe(COLUMNS)}`.catch(mapNameConflict);
   const [row] = rows;
   if (!row) throw new NotFound();
   return toDefinition(row);
}

export async function updateProperty(
   q: Queryable,
   workspaceId: string,
   propertyId: string,
   patch: PropertyPatch
): Promise<PropertyDefinition> {
   const current = await getProperty(q, workspaceId, propertyId);
   if (patch.options && !SELECT_KINDS.has(current.kind)) throw new PropertyKindMismatch();
   const config = patch.options ? q.json({ options: patch.options } as never) : null;
   const rows = await q`
      UPDATE issue_property_definitions SET
         name = COALESCE(${patch.name ?? null}, name),
         description = CASE WHEN ${patch.description !== undefined} THEN ${patch.description ?? null}::text ELSE description END,
         config = COALESCE(${config}::jsonb, config),
         icon = CASE WHEN ${patch.icon !== undefined} THEN ${patch.icon ?? null}::text ELSE icon END,
         sort_order = COALESCE(${patch.sortOrder ?? null}::integer, sort_order),
         updated_at = now()
       WHERE id = ${propertyId} AND workspace_id = ${workspaceId} AND archived_at IS NULL
      RETURNING ${q.unsafe(COLUMNS)}`.catch(mapNameConflict);
   const [row] = rows;
   if (!row) throw new NotFound();
   return toDefinition(row);
}

/** Archived rather than deleted: stored values stay, and reappear on restore. */
export async function archiveProperty(
   q: Queryable,
   workspaceId: string,
   propertyId: string
): Promise<boolean> {
   const rows = await q`
      UPDATE issue_property_definitions SET archived_at = now(), updated_at = now()
       WHERE id = ${propertyId} AND workspace_id = ${workspaceId} AND archived_at IS NULL
      RETURNING id`;
   return rows.length === 1;
}

const personSchema = z.object({ type: z.enum(['user', 'agent']), id: z.uuid() }).strict();
type Person = z.infer<typeof personSchema>;

function isHttpUrl(value: string): boolean {
   try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
   } catch {
      return false;
   }
}

function valueSchemaFor(definition: PropertyDefinition): z.ZodType<unknown> {
   const optionIds = definition.options.map((option) => option.id);
   switch (definition.kind) {
      case 'text':
         return z.string().max(5000);
      case 'number':
         return z.number().refine(Number.isFinite, { message: 'Must be a finite number.' });
      case 'boolean':
         return z.boolean();
      case 'date':
         return z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use YYYY-MM-DD.' });
      case 'url':
         return z.string().max(2000).refine(isHttpUrl, { message: 'Must be an http or https URL.' });
      case 'select':
         return z.string().refine((value) => optionIds.includes(value), { message: 'Not an option of this property.' });
      case 'multi_select':
         return z
            .array(z.string())
            .max(100)
            .refine((values) => values.every((value) => optionIds.includes(value)), { message: 'Not an option of this property.' })
            .refine((values) => new Set(values).size === values.length, { message: 'Options must not repeat.' });
      case 'person':
         return personSchema;
      case 'multi_person':
         return z.array(personSchema).max(50);
   }
}

async function assertPeopleInWorkspace(q: Queryable, workspaceId: string, people: Person[]): Promise<void> {
   for (const person of people) {
      const [row] =
         person.type === 'user'
            ? await q`SELECT 1 FROM workspace_memberships WHERE workspace_id = ${workspaceId} AND user_id = ${person.id}`
            : await q`SELECT 1 FROM agents WHERE workspace_id = ${workspaceId} AND id = ${person.id}`;
      if (!row) {
         throw new InvalidPropertyValue([{ path: '/value', message: 'That person is not in this workspace.' }]);
      }
   }
}

export async function listValues(
   q: Queryable,
   workspaceId: string,
   issueId: string
): Promise<Array<{ propertyId: string; value: unknown }>> {
   const rows = await q`
      SELECT value.property_id, value.value
        FROM issue_property_values AS value
        JOIN issue_property_definitions AS definition
          ON definition.workspace_id = value.workspace_id AND definition.id = value.property_id
       WHERE value.workspace_id = ${workspaceId} AND value.issue_id = ${issueId}
         AND definition.archived_at IS NULL
       ORDER BY definition.sort_order, definition.id`;
   return rows.map((row) => ({ propertyId: row.property_id as string, value: row.value }));
}

export async function setValue(
   q: Queryable,
   input: { workspaceId: string; issueId: string; propertyId: string; value: unknown; actorId: string }
): Promise<{ propertyId: string; value: unknown }> {
   const definition = await getProperty(q, input.workspaceId, input.propertyId);
   const parsed = valueSchemaFor(definition).safeParse(input.value);
   if (!parsed.success) {
      throw new InvalidPropertyValue(
         parsed.error.issues.map((issue) => ({
            path: `/value${issue.path.length ? `/${issue.path.map(String).join('/')}` : ''}`,
            message: issue.message,
         }))
      );
   }
   if (definition.kind === 'person') await assertPeopleInWorkspace(q, input.workspaceId, [parsed.data as Person]);
   if (definition.kind === 'multi_person') await assertPeopleInWorkspace(q, input.workspaceId, parsed.data as Person[]);

   await q`
      INSERT INTO issue_property_values (workspace_id, issue_id, property_id, value, updated_by)
      VALUES (${input.workspaceId}, ${input.issueId}, ${input.propertyId},
              ${q.json(parsed.data as never)}, ${input.actorId})
      ON CONFLICT (workspace_id, issue_id, property_id)
      DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
   return { propertyId: input.propertyId, value: parsed.data };
}

export async function clearValue(
   q: Queryable,
   workspaceId: string,
   issueId: string,
   propertyId: string
): Promise<boolean> {
   const rows = await q`
      DELETE FROM issue_property_values
       WHERE workspace_id = ${workspaceId} AND issue_id = ${issueId} AND property_id = ${propertyId}
      RETURNING property_id`;
   return rows.length === 1;
}
```

- [ ] **Step 4: Implement `metadata.ts`**

```ts
import { z } from 'zod';
import type { Queryable } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';

/**
 * Free key/value pairs on an issue, for agents and integrations. Scalars only,
 * so a filter or a UI can show any value without knowing its producer.
 */
const KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
export const MAX_METADATA_KEYS = 50;

export const metadataPatchSchema = z
   .object({
      set: z
         .record(z.string().regex(KEY), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]))
         .optional(),
      remove: z.array(z.string().regex(KEY)).max(MAX_METADATA_KEYS).optional(),
   })
   .strict()
   .refine((value) => value.set !== undefined || value.remove !== undefined, {
      message: 'Provide set or remove.',
   });
export type MetadataPatch = z.infer<typeof metadataPatchSchema>;

export class MetadataTooLarge extends Error {
   constructor() {
      super('issue metadata is too large');
      this.name = 'MetadataTooLarge';
   }
}

export async function readMetadata(q: Queryable, issueId: string): Promise<Record<string, unknown>> {
   const [row] = await q`SELECT metadata FROM issues WHERE id = ${issueId} AND deleted_at IS NULL`;
   if (!row) throw new NotFound();
   return row.metadata as Record<string, unknown>;
}

/** Run inside a transaction: a refused key count rolls the merge back. */
export async function patchMetadata(
   q: Queryable,
   issueId: string,
   patch: MetadataPatch
): Promise<Record<string, unknown>> {
   const rows = await q`
      UPDATE issues
         SET metadata = (metadata - ${patch.remove ?? []}::text[]) || ${q.json((patch.set ?? {}) as never)}::jsonb,
             updated_at = now()
       WHERE id = ${issueId} AND deleted_at IS NULL
      RETURNING metadata`.catch((error: unknown) => {
      if ((error as { code?: string }).code === '23514') throw new MetadataTooLarge();
      throw error;
   });
   const [row] = rows;
   if (!row) throw new NotFound();
   const metadata = row.metadata as Record<string, unknown>;
   if (Object.keys(metadata).length > MAX_METADATA_KEYS) throw new MetadataTooLarge();
   return metadata;
}
```

- [ ] **Step 5: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types src/work/properties.test.ts && pnpm -w typecheck:server`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add server-ts/src/work/properties.ts server-ts/src/work/metadata.ts server-ts/src/work/properties.test.ts
git commit -m "feat(server-ts): store custom property values and issue metadata"
```

---

### Task 5: Reactions and comment resolution

**Files:**
- Create: `server-ts/src/work/reactions.ts`, `server-ts/src/work/comment-resolution.ts`
- Test: `server-ts/src/work/reactions.test.ts`

**Interfaces:**
- Produces (`reactions.ts`): `emojiSchema`, `interface ReactionGroup { emoji: string; count: number; reactedByMe: boolean; actorIds: string[] }`, `type ReactionTarget = 'issue' | 'comment'`, `listReactions(q: Queryable, target: ReactionTarget, targetId: string, viewerId: string): Promise<ReactionGroup[]>`, `addReaction(q, target, targetId, actorId, emoji): Promise<boolean>`, `removeReaction(q, target, targetId, actorId, emoji): Promise<boolean>`.
- Produces (`comment-resolution.ts`): class `NotAThreadRoot`, `setCommentResolution(q: Queryable, input: { commentId: string; actorId: string; resolved: boolean }): Promise<{ issueId: string; changed: boolean }>`.

- [ ] **Step 1: Write the failing test**

`server-ts/src/work/reactions.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { CommentRepository } from '../core/comments.ts';
import { cleanupWorld, seedWorld, type World } from './fixture.ts';
import { addReaction, emojiSchema, listReactions, removeReaction } from './reactions.ts';
import { NotAThreadRoot, setCommentResolution } from './comment-resolution.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('reactions and resolution', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let comments: CommentRepository;
   before(async () => {
      sql = openDatabase({ url: url as string });
      comments = new CommentRepository(sql);
      world = await seedWorld(sql, 'react');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await closeDatabase(sql);
   });

   test('whitespace is not an emoji', () => {
      assert.equal(emojiSchema.safeParse('👍').success, true);
      assert.equal(emojiSchema.safeParse('a b').success, false);
   });

   test('reacting twice counts once, and reactions group by emoji', async () => {
      assert.equal(await addReaction(sql, 'issue', world.issueId, world.ownerId, '👍'), true);
      assert.equal(await addReaction(sql, 'issue', world.issueId, world.ownerId, '👍'), false);
      await addReaction(sql, 'issue', world.issueId, world.memberId, '👍');
      await addReaction(sql, 'issue', world.issueId, world.memberId, '🎉');
      const groups = await listReactions(sql, 'issue', world.issueId, world.ownerId);
      assert.deepEqual(
         groups.map((group) => [group.emoji, group.count, group.reactedByMe]),
         [
            ['👍', 2, true],
            ['🎉', 1, false],
         ]
      );
      assert.equal(await removeReaction(sql, 'issue', world.issueId, world.ownerId, '👍'), true);
   });

   test('a comment thread resolves and unresolves at its root only', async () => {
      const root = await comments.create({ issueId: world.issueId, authorId: world.ownerId, body: 'Root', createdAt: new Date().toISOString() });
      const reply = await comments.create({ issueId: world.issueId, authorId: world.ownerId, body: 'Reply', parentId: root.comment.id, createdAt: new Date().toISOString() });
      await addReaction(sql, 'comment', root.comment.id, world.memberId, '👀');
      assert.equal((await listReactions(sql, 'comment', root.comment.id, world.memberId))[0]?.reactedByMe, true);

      const resolved = await setCommentResolution(sql, { commentId: root.comment.id, actorId: world.ownerId, resolved: true });
      assert.deepEqual(resolved, { issueId: world.issueId, changed: true });
      assert.notEqual((await comments.get(root.comment.id)).resolvedAt, null);
      assert.equal((await setCommentResolution(sql, { commentId: root.comment.id, actorId: world.ownerId, resolved: true })).changed, false);
      await assert.rejects(
         setCommentResolution(sql, { commentId: reply.comment.id, actorId: world.ownerId, resolved: true }),
         NotAThreadRoot
      );
      await setCommentResolution(sql, { commentId: root.comment.id, actorId: world.ownerId, resolved: false });
      assert.equal((await comments.get(root.comment.id)).resolvedAt, null);
   });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd server-ts && node --test --experimental-strip-types src/work/reactions.test.ts`
Expected: FAIL with `Cannot find module '.../work/reactions.ts'`.

- [ ] **Step 3: Implement `reactions.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Queryable } from '../db/pool.ts';

/** Mirrors the table CHECKs, so a refusal is a 422 rather than a 500. */
export const emojiSchema = z
   .string()
   .min(1)
   .max(16)
   .refine((value) => !/[\p{Cc}\s]/u.test(value) && Buffer.byteLength(value, 'utf8') <= 64, {
      message: 'A reaction is a single emoji.',
   });

export interface ReactionGroup {
   emoji: string;
   count: number;
   reactedByMe: boolean;
   actorIds: string[];
}

export type ReactionTarget = 'issue' | 'comment';

function group(rows: ReadonlyArray<Record<string, unknown>>, viewerId: string): ReactionGroup[] {
   return rows.map((row) => {
      const actorIds = (row.actors as string[]).map((id) => id.toLowerCase());
      return {
         emoji: row.emoji as string,
         count: actorIds.length,
         reactedByMe: actorIds.includes(viewerId.toLowerCase()),
         actorIds,
      };
   });
}

export async function listReactions(
   q: Queryable,
   target: ReactionTarget,
   targetId: string,
   viewerId: string
): Promise<ReactionGroup[]> {
   const rows =
      target === 'issue'
         ? await q`
              SELECT emoji, array_agg(actor_id::text ORDER BY created_at, id) AS actors,
                     min(created_at) AS first_at
                FROM issue_reactions WHERE issue_id = ${targetId}
               GROUP BY emoji ORDER BY first_at, emoji`
         : await q`
              SELECT emoji, array_agg(actor_id::text ORDER BY created_at, id) AS actors,
                     min(created_at) AS first_at
                FROM comment_reactions WHERE comment_id = ${targetId}
               GROUP BY emoji ORDER BY first_at, emoji`;
   return group(rows, viewerId);
}

/** True when this reaction is new. Reacting again is a no-op, not an error. */
export async function addReaction(
   q: Queryable,
   target: ReactionTarget,
   targetId: string,
   actorId: string,
   emoji: string
): Promise<boolean> {
   const rows =
      target === 'issue'
         ? await q`
              INSERT INTO issue_reactions (id, issue_id, actor_id, emoji)
              VALUES (${randomUUID()}, ${targetId}, ${actorId}, ${emoji})
              ON CONFLICT (issue_id, actor_id, emoji) DO NOTHING RETURNING id`
         : await q`
              INSERT INTO comment_reactions (id, comment_id, actor_id, emoji)
              VALUES (${randomUUID()}, ${targetId}, ${actorId}, ${emoji})
              ON CONFLICT (comment_id, actor_id, emoji) DO NOTHING RETURNING id`;
   return rows.length === 1;
}

export async function removeReaction(
   q: Queryable,
   target: ReactionTarget,
   targetId: string,
   actorId: string,
   emoji: string
): Promise<boolean> {
   const rows =
      target === 'issue'
         ? await q`
              DELETE FROM issue_reactions
               WHERE issue_id = ${targetId} AND actor_id = ${actorId} AND emoji = ${emoji} RETURNING id`
         : await q`
              DELETE FROM comment_reactions
               WHERE comment_id = ${targetId} AND actor_id = ${actorId} AND emoji = ${emoji} RETURNING id`;
   return rows.length === 1;
}
```

- [ ] **Step 4: Implement `comment-resolution.ts`**

```ts
import type { Queryable } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';

/**
 * Resolving closes a thread, so only a root comment resolves; the unique index
 * `comments_one_resolution_per_thread_key` keeps one resolution per thread.
 * Not an edit: the revision is left alone, so an open editor is not invalidated.
 */
export class NotAThreadRoot extends Error {
   constructor() {
      super('only a thread root can be resolved');
      this.name = 'NotAThreadRoot';
   }
}

export async function setCommentResolution(
   q: Queryable,
   input: { commentId: string; actorId: string; resolved: boolean }
): Promise<{ issueId: string; changed: boolean }> {
   const [row] = await q`
      SELECT issue_id, parent_id, resolved_at FROM comments WHERE id = ${input.commentId} FOR UPDATE`;
   if (!row) throw new NotFound();
   if (row.parent_id !== null) throw new NotAThreadRoot();
   const issueId = row.issue_id as string;
   const isResolved = row.resolved_at !== null;
   if (isResolved === input.resolved) return { issueId, changed: false };

   if (input.resolved) {
      await q`
         UPDATE comments SET resolved_at = now(), resolved_by = ${input.actorId}
          WHERE id = ${input.commentId}`;
   } else {
      await q`UPDATE comments SET resolved_at = NULL, resolved_by = NULL WHERE id = ${input.commentId}`;
   }
   return { issueId, changed: true };
}
```

- [ ] **Step 5: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types src/work/reactions.test.ts && pnpm -w typecheck:server`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add server-ts/src/work/reactions.ts server-ts/src/work/comment-resolution.ts server-ts/src/work/reactions.test.ts
git commit -m "feat(server-ts): add issue and comment reactions and thread resolution"
```

---
### Task 6: Subscribers and inbox notification

**Files:**
- Create: `server-ts/src/work/subscribers.ts`
- Test: `server-ts/src/work/subscribers.test.ts`

**Interfaces:**
- Consumes: `World` fixture.
- Produces: `SUBSCRIPTION_REASONS`, `type SubscriptionReason = 'creator' | 'assignee' | 'commenter' | 'mentioned' | 'manual'`, `type InboxCategory = 'assignments' | 'statusChanges' | 'comments' | 'mentions' | 'updates' | 'agentActivity'`, `interface Subscriber { userId: string; name: string | null; avatarUrl: string | null; reason: SubscriptionReason; subscribedAt: string }`, and:
  - `listSubscribers(q: Queryable, issueId: string): Promise<Subscriber[]>`
  - `isSubscribed(q, issueId, userId): Promise<boolean>`
  - `subscribe(q, input: { workspaceId; issueIds: string[]; userIds: string[]; reason: SubscriptionReason }): Promise<number>` (members only, idempotent)
  - `unsubscribe(q, input: { issueIds: string[]; userId: string }): Promise<number>`
  - `subtreeIssueIds(q, rootId): Promise<string[]>` (the root plus every descendant, capped at 1000)
  - `notifySubscribers(q, input: { workspaceId; issueId; sourceEventId: string; eventType: string; category: InboxCategory; actor: { type: 'user' | 'agent'; id: string }; title: string; body: string | null; mentionedUserIds: string[] }): Promise<number>`

- [ ] **Step 1: Write the failing test**

`server-ts/src/work/subscribers.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { cleanupWorld, createIssue, seedWorld, type World } from './fixture.ts';
import { recordIssueEvent } from './outbox.ts';
import {
   isSubscribed,
   listSubscribers,
   notifySubscribers,
   subscribe,
   subtreeIssueIds,
   unsubscribe,
} from './subscribers.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('subscribers', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let other: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'subs');
      other = await seedWorld(sql, 'subs-other');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await cleanupWorld(sql, other);
      await closeDatabase(sql);
   });

   test('only members subscribe, and subscribing twice is one row', async () => {
      const count = await subscribe(sql, {
         workspaceId: world.workspaceId,
         issueIds: [world.issueId],
         userIds: [world.memberId, other.ownerId],
         reason: 'manual',
      });
      assert.equal(count, 1);
      assert.equal(
         await subscribe(sql, { workspaceId: world.workspaceId, issueIds: [world.issueId], userIds: [world.memberId], reason: 'manual' }),
         0
      );
      const subscribers = await listSubscribers(sql, world.issueId);
      assert.deepEqual(subscribers.map((entry) => entry.userId), [world.memberId]);
      assert.equal(await unsubscribe(sql, { issueIds: [world.issueId], userId: world.memberId }), 1);
      assert.equal(await isSubscribed(sql, world.issueId, world.memberId), false);
   });

   test('a subtree is the issue and every descendant', async () => {
      const child = await createIssue(sql, world, { parentId: world.issueId });
      const grandchild = await createIssue(sql, world, { parentId: child });
      const ids = await subtreeIssueIds(sql, world.issueId);
      assert.deepEqual(new Set(ids), new Set([world.issueId, child, grandchild]));
   });

   test('notification reaches subscribers but not the actor, and a mention is a mention', async () => {
      await subscribe(sql, { workspaceId: world.workspaceId, issueIds: [world.issueId], userIds: [world.ownerId, world.memberId], reason: 'manual' });
      const event = await recordIssueEvent(sql, { issueId: world.issueId, type: 'comment.created', actor: { type: 'user', id: world.ownerId }, payload: {} });
      const written = await notifySubscribers(sql, {
         workspaceId: world.workspaceId,
         issueId: world.issueId,
         sourceEventId: event.id,
         eventType: 'comment.created',
         category: 'comments',
         actor: { type: 'user', id: world.ownerId },
         title: 'WRK-1 Root task',
         body: 'hello',
         mentionedUserIds: [world.viewerId],
      });
      assert.equal(written, 2);
      const rows = await sql`
         SELECT recipient_id, category FROM inbox_items WHERE source_event_id = ${event.id} ORDER BY category`;
      assert.deepEqual(
         rows.map((row) => [row.recipient_id, row.category]),
         [
            [world.memberId, 'comments'],
            [world.viewerId, 'mentions'],
         ]
      );
   });

   test('a category switched off in preferences is not delivered', async () => {
      await sql`
         INSERT INTO notification_preferences (workspace_id, user_id, preferences)
         VALUES (${world.workspaceId}, ${world.memberId},
                 ${sql.json({ inApp: { comments: false } } as never)})
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET preferences = EXCLUDED.preferences`;
      const event = await recordIssueEvent(sql, { issueId: world.issueId, type: 'comment.created', actor: { type: 'user', id: world.ownerId }, payload: {} });
      await notifySubscribers(sql, {
         workspaceId: world.workspaceId,
         issueId: world.issueId,
         sourceEventId: event.id,
         eventType: 'comment.created',
         category: 'comments',
         actor: { type: 'user', id: world.ownerId },
         title: 'WRK-1 Root task',
         body: null,
         mentionedUserIds: [],
      });
      const rows = await sql`SELECT 1 FROM inbox_items WHERE source_event_id = ${event.id} AND recipient_id = ${world.memberId}`;
      assert.equal(rows.length, 0);
   });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd server-ts && node --test --experimental-strip-types src/work/subscribers.test.ts`
Expected: FAIL with `Cannot find module '.../work/subscribers.ts'`.

- [ ] **Step 3: Implement**

`server-ts/src/work/subscribers.ts`:

```ts
import { toRFC3339, type Queryable } from '../db/pool.ts';

/**
 * Who follows an issue, and the inbox rows a change produces for them.
 *
 * Inbox rows are written directly, keyed by the outbox event that caused them,
 * so `inbox_items_recipient_source_key` makes a retried write a no-op.
 */
export const SUBSCRIPTION_REASONS = ['creator', 'assignee', 'commenter', 'mentioned', 'manual'] as const;
export type SubscriptionReason = (typeof SUBSCRIPTION_REASONS)[number];

export type InboxCategory =
   | 'assignments'
   | 'statusChanges'
   | 'comments'
   | 'mentions'
   | 'updates'
   | 'agentActivity';

export interface Subscriber {
   userId: string;
   name: string | null;
   avatarUrl: string | null;
   reason: SubscriptionReason;
   subscribedAt: string;
}

export async function listSubscribers(q: Queryable, issueId: string): Promise<Subscriber[]> {
   const rows = await q`
      SELECT subscriber.user_id, person.name, person.avatar_url, subscriber.reason, subscriber.created_at
        FROM issue_subscribers AS subscriber
        JOIN users AS person ON person.id = subscriber.user_id
       WHERE subscriber.issue_id = ${issueId}
       ORDER BY subscriber.created_at, subscriber.user_id`;
   return rows.map((row) => ({
      userId: row.user_id as string,
      name: (row.name as string | null) ?? null,
      avatarUrl: (row.avatar_url as string | null) ?? null,
      reason: row.reason as SubscriptionReason,
      subscribedAt: toRFC3339(row.created_at as string) ?? '',
   }));
}

export async function isSubscribed(q: Queryable, issueId: string, userId: string): Promise<boolean> {
   const rows = await q`
      SELECT 1 FROM issue_subscribers WHERE issue_id = ${issueId} AND user_id = ${userId}`;
   return rows.length === 1;
}

/**
 * Non-members are skipped rather than refused: an automatic source (a mention
 * of someone who left) must not fail the write that triggered it.
 */
export async function subscribe(
   q: Queryable,
   input: { workspaceId: string; issueIds: string[]; userIds: string[]; reason: SubscriptionReason }
): Promise<number> {
   if (input.issueIds.length === 0 || input.userIds.length === 0) return 0;
   const result = await q`
      INSERT INTO issue_subscribers (workspace_id, issue_id, user_id, reason)
      SELECT ${input.workspaceId}, target_issue.id, member.user_id, ${input.reason}
        FROM unnest(${input.issueIds}::uuid[]) AS target_issue(id)
        CROSS JOIN unnest(${input.userIds}::uuid[]) AS target_user(id)
        JOIN workspace_memberships AS member
          ON member.workspace_id = ${input.workspaceId} AND member.user_id = target_user.id
      ON CONFLICT (issue_id, user_id) DO NOTHING`;
   return result.count;
}

export async function unsubscribe(
   q: Queryable,
   input: { issueIds: string[]; userId: string }
): Promise<number> {
   if (input.issueIds.length === 0) return 0;
   const result = await q`
      DELETE FROM issue_subscribers
       WHERE issue_id = ANY(${input.issueIds}::uuid[]) AND user_id = ${input.userId}`;
   return result.count;
}

export async function subtreeIssueIds(q: Queryable, rootId: string): Promise<string[]> {
   const rows = await q`
      WITH RECURSIVE tree AS (
         SELECT id, 0 AS depth FROM issues WHERE id = ${rootId} AND deleted_at IS NULL
         UNION ALL
         SELECT child.id, tree.depth + 1
           FROM issues AS child
           JOIN tree ON child.parent_id = tree.id
          WHERE child.deleted_at IS NULL AND tree.depth < 100
      )
      SELECT id FROM tree LIMIT 1000`;
   return rows.map((row) => row.id as string);
}

export async function notifySubscribers(
   q: Queryable,
   input: {
      workspaceId: string;
      issueId: string;
      sourceEventId: string;
      eventType: string;
      category: InboxCategory;
      actor: { type: 'user' | 'agent'; id: string };
      title: string;
      body: string | null;
      mentionedUserIds: string[];
   }
): Promise<number> {
   const title = [...input.title].slice(0, 500).join('') || 'Task updated';
   const body = input.body === null ? null : [...input.body].slice(0, 5000).join('');
   const result = await q`
      INSERT INTO inbox_items (
         workspace_id, recipient_id, source_event_id, event_type, category, issue_id,
         actor_type, actor_id, title, body
      )
      SELECT ${input.workspaceId}, recipient.user_id, ${input.sourceEventId}, ${input.eventType},
             recipient.category, ${input.issueId}, ${input.actor.type}, ${input.actor.id},
             ${title}, ${body}
        FROM (
           SELECT candidate.user_id,
                  CASE WHEN candidate.user_id = ANY(${input.mentionedUserIds}::uuid[])
                       THEN 'mentions' ELSE ${input.category} END AS category
             FROM (
                SELECT user_id FROM issue_subscribers WHERE issue_id = ${input.issueId}
                UNION
                SELECT member.user_id FROM workspace_memberships AS member
                 WHERE member.workspace_id = ${input.workspaceId}
                   AND member.user_id = ANY(${input.mentionedUserIds}::uuid[])
             ) AS candidate
        ) AS recipient
       WHERE NOT (${input.actor.type} = 'user' AND recipient.user_id = ${input.actor.id}::uuid)
         AND COALESCE((
            SELECT (preference.preferences -> 'inApp' ->> recipient.category)::boolean
              FROM notification_preferences AS preference
             WHERE preference.workspace_id = ${input.workspaceId}
               AND preference.user_id = recipient.user_id
         ), true)
      ON CONFLICT (recipient_id, source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING`;
   return result.count;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types src/work/subscribers.test.ts && pnpm -w typecheck:server`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add server-ts/src/work/subscribers.ts server-ts/src/work/subscribers.test.ts
git commit -m "feat(server-ts): subscribe people to issues and notify them in the inbox"
```

---

### Task 7: Sub-issues, stages, and the stage barrier in auto-dispatch

**Files:**
- Create: `server-ts/src/work/hierarchy.ts`
- Modify: `server-ts/src/runs/auto-dispatch.ts`
- Test: `server-ts/src/work/hierarchy.test.ts` (DB), `server-ts/src/runs/auto-dispatch.test.ts` (offline, add cases)

**Interfaces:**
- Produces (`hierarchy.ts`): classes `HierarchyCycle`, `ParentNotFound`; `setParent(q: Queryable, input: { workspaceId: string; issueId: string; parentId: string | null; stage: number | null }): Promise<void>`, `childIssueIds(q, parentId): Promise<string[]>` (stage order, max 200), `blockedByEarlierStage(q, issueId): Promise<boolean>`, `nextStageReady(q, issueId): Promise<string[]>`, `stageGate(q: Queryable): StageGate`.
- Produces (`auto-dispatch.ts`): `interface StageGate { blockedByEarlierStage(issueId: string): Promise<boolean> }`, `readyForAgent(issue: DispatchCandidate, stageOpen = true): boolean`, `autoDispatch(runs, issue, context, stages?: StageGate): Promise<Run | null>`.

- [ ] **Step 1: Write the failing tests**

Append to `server-ts/src/runs/auto-dispatch.test.ts`:

```ts
test('a task behind an unfinished earlier stage is not ready', () => {
   const base = {
      id: 'i',
      boardId: 'b',
      status: 'todo',
      assignee: { type: 'agent', id: 'a' },
      activeRunId: null,
   };
   assert.equal(readyForAgent(base, false), false);
   assert.equal(readyForAgent(base, true), true);
});

test('autoDispatch asks the stage gate and admits nothing while it is closed', async () => {
   let admitted = 0;
   const runs = {
      admit: async () => {
         admitted += 1;
         return {} as never;
      },
   };
   const issue = { id: 'i', boardId: 'b', status: 'todo', assignee: { type: 'agent', id: 'a' }, activeRunId: null };
   const closed = { blockedByEarlierStage: async () => true };
   assert.equal(await autoDispatch(runs, issue, { workspaceId: 'w', requestedBy: 'u' }, closed), null);
   assert.equal(admitted, 0);
   const open = { blockedByEarlierStage: async () => false };
   await autoDispatch(runs, issue, { workspaceId: 'w', requestedBy: 'u' }, open);
   assert.equal(admitted, 1);
});
```

`server-ts/src/work/hierarchy.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { cleanupWorld, createIssue, seedWorld, type World } from './fixture.ts';
import {
   HierarchyCycle,
   ParentNotFound,
   blockedByEarlierStage,
   childIssueIds,
   nextStageReady,
   setParent,
} from './hierarchy.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('hierarchy', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let other: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'tree');
      other = await seedWorld(sql, 'tree-other');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await cleanupWorld(sql, other);
      await closeDatabase(sql);
   });

   test('an issue cannot become a descendant of itself', async () => {
      const child = await createIssue(sql, world);
      await setParent(sql, { workspaceId: world.workspaceId, issueId: child, parentId: world.issueId, stage: null });
      await assert.rejects(
         setParent(sql, { workspaceId: world.workspaceId, issueId: world.issueId, parentId: child, stage: null }),
         HierarchyCycle
      );
   });

   test('a parent from another workspace is not found', async () => {
      const child = await createIssue(sql, world);
      await assert.rejects(
         setParent(sql, { workspaceId: world.workspaceId, issueId: child, parentId: other.issueId, stage: null }),
         ParentNotFound
      );
   });

   test('stage two waits for stage one, then is released as a group', async () => {
      const parent = await createIssue(sql, world, { title: 'Staged' });
      const a1 = await createIssue(sql, world, { parentId: parent, stage: 1, status: 'todo' });
      const a2 = await createIssue(sql, world, { parentId: parent, stage: 1, status: 'todo' });
      const b1 = await createIssue(sql, world, { parentId: parent, stage: 2, status: 'todo' });
      const c1 = await createIssue(sql, world, { parentId: parent, stage: 3, status: 'todo' });

      assert.equal((await childIssueIds(sql, parent)).length, 4);
      assert.equal(await blockedByEarlierStage(sql, b1), true);
      assert.equal(await blockedByEarlierStage(sql, a1), false);

      await sql`UPDATE issues SET status = 'done' WHERE id = ${a1}`;
      assert.deepEqual(await nextStageReady(sql, a1), []);
      await sql`UPDATE issues SET status = 'cancelled' WHERE id = ${a2}`;
      assert.deepEqual(await nextStageReady(sql, a2), [b1]);
      assert.equal(await blockedByEarlierStage(sql, b1), false);
      assert.equal(await blockedByEarlierStage(sql, c1), true);
   });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd server-ts && node --test --experimental-strip-types src/runs/auto-dispatch.test.ts src/work/hierarchy.test.ts`
Expected: FAIL. `readyForAgent(base, false)` returns true, and `hierarchy.ts` is missing.

- [ ] **Step 3: Implement the gate in `runs/auto-dispatch.ts`**

Replace `readyForAgent` and `autoDispatch` with:

```ts
/**
 * Whether a task's earlier-stage siblings are still open. A sub-issue in stage
 * N+1 must not start while any stage <= N sibling is unfinished.
 */
export interface StageGate {
   blockedByEarlierStage(issueId: string): Promise<boolean>;
}

export function readyForAgent(issue: DispatchCandidate, stageOpen = true): boolean {
   return (
      stageOpen &&
      issue.assignee?.type === 'agent' &&
      issue.status === 'todo' &&
      issue.activeRunId === null
   );
}

export async function autoDispatch(
   runs: Pick<RunRepository, 'admit'>,
   issue: DispatchCandidate,
   context: { workspaceId: string; requestedBy: string },
   stages?: StageGate
): Promise<Run | null> {
   if (!readyForAgent(issue)) return null;
   if (stages && (await stages.blockedByEarlierStage(issue.id))) return null;
   try {
      return await runs.admit({
         issueId: issue.id,
         boardId: issue.boardId,
         workspaceId: context.workspaceId,
         agentId: null,
         requestedBy: context.requestedBy,
         instructions: null,
      });
   } catch (error) {
      if (error instanceof ActiveRunExists || error instanceof NoAgentAssigned) return null;
      throw error;
   }
}
```

- [ ] **Step 4: Implement `work/hierarchy.ts`**

```ts
import type { Queryable } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import type { StageGate } from '../runs/auto-dispatch.ts';

/**
 * Parent/child links and stage barriers. A stage is an ordinal among siblings:
 * every sibling in stage <= N must be done or cancelled before stage N+1 is
 * released. Unstaged siblings never block and are never blocked.
 */
export class HierarchyCycle extends Error {
   constructor() {
      super('an issue cannot be nested under its own descendant');
      this.name = 'HierarchyCycle';
   }
}

export class ParentNotFound extends Error {
   constructor() {
      super('parent issue not found');
      this.name = 'ParentNotFound';
   }
}

export async function setParent(
   q: Queryable,
   input: { workspaceId: string; issueId: string; parentId: string | null; stage: number | null }
): Promise<void> {
   if (input.parentId !== null) {
      const [parent] = await q`
         SELECT issue.id FROM issues AS issue
           JOIN boards AS board ON board.id = issue.board_id
          WHERE issue.id = ${input.parentId} AND board.workspace_id = ${input.workspaceId}
            AND issue.deleted_at IS NULL`;
      if (!parent) throw new ParentNotFound();
      const [cycle] = await q`
         WITH RECURSIVE ancestors AS (
            SELECT id, parent_id, 1 AS depth FROM issues WHERE id = ${input.parentId}
            UNION ALL
            SELECT issue.id, issue.parent_id, ancestors.depth + 1
              FROM issues AS issue JOIN ancestors ON issue.id = ancestors.parent_id
             WHERE ancestors.depth < 100
         )
         SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = ${input.issueId}) AS cyclic`;
      if (cycle?.cyclic === true) throw new HierarchyCycle();
   }
   const result = await q`
      UPDATE issues
         SET parent_id = ${input.parentId},
             stage = ${input.parentId === null ? null : input.stage},
             updated_at = now()
       WHERE id = ${input.issueId} AND deleted_at IS NULL`;
   if (result.count !== 1) throw new NotFound();
}

export async function childIssueIds(q: Queryable, parentId: string): Promise<string[]> {
   const rows = await q`
      SELECT id FROM issues
       WHERE parent_id = ${parentId} AND deleted_at IS NULL
       ORDER BY stage ASC NULLS LAST, sort_order ASC, created_at ASC, id ASC
       LIMIT 200`;
   return rows.map((row) => row.id as string);
}

export async function blockedByEarlierStage(q: Queryable, issueId: string): Promise<boolean> {
   const [row] = await q`
      SELECT EXISTS (
         SELECT 1
           FROM issues AS me
           JOIN issues AS sibling
             ON sibling.parent_id = me.parent_id AND sibling.id <> me.id AND sibling.deleted_at IS NULL
          WHERE me.id = ${issueId} AND me.parent_id IS NOT NULL AND me.stage IS NOT NULL
            AND sibling.stage IS NOT NULL AND sibling.stage < me.stage
            AND sibling.status NOT IN ('done', 'cancelled')
      ) AS blocked`;
   return row?.blocked === true;
}

/**
 * The siblings released by `issueId` finishing: the whole next stage, when
 * every sibling at or below this issue's stage is done or cancelled.
 */
export async function nextStageReady(q: Queryable, issueId: string): Promise<string[]> {
   const rows = await q`
      WITH me AS (
         SELECT parent_id, stage FROM issues
          WHERE id = ${issueId} AND parent_id IS NOT NULL AND stage IS NOT NULL
      ),
      still_open AS (
         SELECT 1 FROM issues AS sibling, me
          WHERE sibling.parent_id = me.parent_id AND sibling.stage <= me.stage
            AND sibling.deleted_at IS NULL AND sibling.status NOT IN ('done', 'cancelled')
      ),
      next_stage AS (
         SELECT min(sibling.stage) AS stage FROM issues AS sibling, me
          WHERE sibling.parent_id = me.parent_id AND sibling.stage > me.stage
            AND sibling.deleted_at IS NULL
      )
      SELECT sibling.id
        FROM issues AS sibling, me, next_stage
       WHERE NOT EXISTS (SELECT 1 FROM still_open)
         AND sibling.parent_id = me.parent_id AND sibling.stage = next_stage.stage
         AND sibling.deleted_at IS NULL
       ORDER BY sibling.sort_order, sibling.id`;
   return rows.map((row) => row.id as string);
}

export function stageGate(q: Queryable): StageGate {
   return { blockedByEarlierStage: (issueId: string) => blockedByEarlierStage(q, issueId) };
}
```

- [ ] **Step 5: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types src/runs/auto-dispatch.test.ts src/work/hierarchy.test.ts && pnpm -w typecheck:server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server-ts/src/runs/auto-dispatch.ts server-ts/src/runs/auto-dispatch.test.ts server-ts/src/work/hierarchy.ts server-ts/src/work/hierarchy.test.ts
git commit -m "feat(server-ts): nest issues and hold later stages until earlier ones finish"
```

---
### Task 8: Custom statuses by category

**Files:**
- Create: `server-ts/src/work/statuses.ts`
- Test: `server-ts/src/work/statuses.test.ts`

**Interfaces:**
- Produces: `STATUS_CATEGORIES = ['backlog','todo','in_progress','in_review','done','blocked','cancelled']`, `statusCreateSchema` (`{ name, category, color, description? }`), `statusOrderSchema` (`{ ids: uuid[] }`), `interface StatusDefinition { id; key; name; description: string | null; category: string; color: string; sortOrder: number; isSystem: boolean }`, `serializeStatus(d): Record<string, unknown>` (the same wire shape as the existing `GET /catalogs/:ws/issue-statuses` nodes), classes `StatusNameTaken`, `SystemStatusProtected`, `StatusOrderMismatch`, and:
  - `listStatuses(q: Queryable, workspaceId): Promise<StatusDefinition[]>`
  - `createStatus(q, workspaceId, actorId, input): Promise<StatusDefinition>`
  - `archiveStatus(q, workspaceId, statusId): Promise<void>` (clears `issues.status_id` for that status)
  - `reorderStatuses(q, workspaceId, ids): Promise<StatusDefinition[]>`
  - `resolveStatus(q, workspaceId, statusId): Promise<StatusDefinition>` (active only; NotFound otherwise)
- Review gate: a custom status of category `in_review` sets `issues.status = 'in_review'`, which is what the existing review gate and ledger read. No gate code changes.

- [ ] **Step 1: Write the failing test**

`server-ts/src/work/statuses.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { cleanupWorld, createIssue, seedWorld, type World } from './fixture.ts';
import {
   StatusNameTaken,
   StatusOrderMismatch,
   SystemStatusProtected,
   archiveStatus,
   createStatus,
   listStatuses,
   reorderStatuses,
   resolveStatus,
   statusCreateSchema,
} from './statuses.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('custom statuses', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'status');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await closeDatabase(sql);
   });

   test('a custom status joins its category and its name is unique', async () => {
      const qa = await createStatus(sql, world.workspaceId, world.ownerId, statusCreateSchema.parse({ name: 'QA', category: 'in_review', color: '#8b5cf6' }));
      assert.equal(qa.category, 'in_review');
      assert.equal(qa.isSystem, false);
      assert.match(qa.key, /^c[0-9a-f]{12}$/);
      assert.equal((await resolveStatus(sql, world.workspaceId, qa.id)).id, qa.id);
      await assert.rejects(
         createStatus(sql, world.workspaceId, world.ownerId, statusCreateSchema.parse({ name: 'qa', category: 'todo', color: '#111111' })),
         StatusNameTaken
      );
   });

   test('a system status cannot be archived; a custom one can, and leaves its issues on the category', async () => {
      const statuses = await listStatuses(sql, world.workspaceId);
      const system = statuses.find((status) => status.isSystem);
      assert.ok(system);
      await assert.rejects(archiveStatus(sql, world.workspaceId, system.id), SystemStatusProtected);

      const parked = await createStatus(sql, world.workspaceId, world.ownerId, statusCreateSchema.parse({ name: 'Parked', category: 'backlog', color: '#6b7280' }));
      const issueId = await createIssue(sql, world);
      await sql`UPDATE issues SET status_id = ${parked.id} WHERE id = ${issueId}`;
      await archiveStatus(sql, world.workspaceId, parked.id);
      const [row] = await sql`SELECT status::text AS status, status_id FROM issues WHERE id = ${issueId}`;
      assert.deepEqual([row?.status, row?.status_id], ['backlog', null]);
      await assert.rejects(resolveStatus(sql, world.workspaceId, parked.id));
   });

   test('reordering needs the full active set', async () => {
      const statuses = await listStatuses(sql, world.workspaceId);
      const ids = statuses.map((status) => status.id);
      await assert.rejects(reorderStatuses(sql, world.workspaceId, ids.slice(1)), StatusOrderMismatch);
      const reversed = await reorderStatuses(sql, world.workspaceId, [...ids].reverse());
      assert.deepEqual(reversed.map((status) => status.id), [...ids].reverse());
   });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd server-ts && node --test --experimental-strip-types src/work/statuses.test.ts`
Expected: FAIL with `Cannot find module '.../work/statuses.ts'`.

- [ ] **Step 3: Implement**

`server-ts/src/work/statuses.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Queryable } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';

/**
 * Workspace statuses. Each belongs to one fixed category, and the category is
 * what `issues.status` stores, so the board, the run ledger and the review gate
 * keep working on categories while people see their own names.
 */
export const STATUS_CATEGORIES = [
   'backlog',
   'todo',
   'in_progress',
   'in_review',
   'done',
   'blocked',
   'cancelled',
] as const;

export const statusCreateSchema = z
   .object({
      name: z.string().trim().min(1).max(100),
      category: z.enum(STATUS_CATEGORIES),
      color: z.string().regex(/^#[0-9a-f]{6}$/),
      description: z.string().trim().max(1000).nullable().default(null),
   })
   .strict();
export type StatusCreate = z.infer<typeof statusCreateSchema>;

export const statusOrderSchema = z.object({ ids: z.array(z.uuid()).min(1).max(200) }).strict();

export interface StatusDefinition {
   id: string;
   key: string;
   name: string;
   description: string | null;
   category: string;
   color: string;
   sortOrder: number;
   isSystem: boolean;
}

export class StatusNameTaken extends Error {
   constructor() {
      super('a status with that name exists');
      this.name = 'StatusNameTaken';
   }
}

export class SystemStatusProtected extends Error {
   constructor() {
      super('a system status cannot be archived');
      this.name = 'SystemStatusProtected';
   }
}

export class StatusOrderMismatch extends Error {
   constructor() {
      super('the order must name every active status exactly once');
      this.name = 'StatusOrderMismatch';
   }
}

const COLUMNS = 'id, key, name, description, category, color, sort_order, is_system';

function toStatus(row: Record<string, unknown>): StatusDefinition {
   return {
      id: row.id as string,
      key: row.key as string,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      category: row.category as string,
      color: row.color as string,
      sortOrder: Number(row.sort_order),
      isSystem: Boolean(row.is_system),
   };
}

export function serializeStatus(status: StatusDefinition): Record<string, unknown> {
   return { ...status };
}

export async function listStatuses(q: Queryable, workspaceId: string): Promise<StatusDefinition[]> {
   const rows = await q`
      SELECT ${q.unsafe(COLUMNS)} FROM issue_status_definitions
       WHERE workspace_id = ${workspaceId} AND archived_at IS NULL
       ORDER BY sort_order ASC, key ASC`;
   return rows.map(toStatus);
}

export async function createStatus(
   q: Queryable,
   workspaceId: string,
   actorId: string,
   input: StatusCreate
): Promise<StatusDefinition> {
   // An opaque key: the category, not the key, is what anything addresses.
   const key = `c${randomBytes(6).toString('hex')}`;
   const rows = await q`
      INSERT INTO issue_status_definitions
         (workspace_id, key, name, description, category, color, sort_order, is_system, created_by)
      VALUES (${workspaceId}, ${key}, ${input.name}, ${input.description}, ${input.category},
              ${input.color},
              COALESCE((SELECT max(sort_order) FROM issue_status_definitions
                         WHERE workspace_id = ${workspaceId} AND category = ${input.category}
                           AND archived_at IS NULL), 0) + 10,
              false, ${actorId})
      RETURNING ${q.unsafe(COLUMNS)}`.catch((error: unknown) => {
      if ((error as { code?: string }).code === '23505') throw new StatusNameTaken();
      throw error;
   });
   const [row] = rows;
   if (!row) throw new NotFound();
   return toStatus(row);
}

export async function archiveStatus(q: Queryable, workspaceId: string, statusId: string): Promise<void> {
   const [row] = await q`
      SELECT is_system FROM issue_status_definitions
       WHERE id = ${statusId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
   if (!row) throw new NotFound();
   if (row.is_system === true) throw new SystemStatusProtected();
   await q`UPDATE issues SET status_id = NULL WHERE status_id = ${statusId}`;
   await q`
      UPDATE issue_status_definitions SET archived_at = now(), updated_at = now()
       WHERE id = ${statusId}`;
}

export async function reorderStatuses(
   q: Queryable,
   workspaceId: string,
   ids: string[]
): Promise<StatusDefinition[]> {
   const active = await listStatuses(q, workspaceId);
   const wanted = new Set(ids.map((id) => id.toLowerCase()));
   if (wanted.size !== ids.length || wanted.size !== active.length || active.some((status) => !wanted.has(status.id))) {
      throw new StatusOrderMismatch();
   }
   await q`
      UPDATE issue_status_definitions AS definition
         SET sort_order = ordered.position * 1000, updated_at = now()
        FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS ordered(id, position)
       WHERE definition.id = ordered.id AND definition.workspace_id = ${workspaceId}`;
   return listStatuses(q, workspaceId);
}

export async function resolveStatus(
   q: Queryable,
   workspaceId: string,
   statusId: string
): Promise<StatusDefinition> {
   const [row] = await q`
      SELECT ${q.unsafe(COLUMNS)} FROM issue_status_definitions
       WHERE id = ${statusId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
   if (!row) throw new NotFound();
   return toStatus(row);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types src/work/statuses.test.ts && pnpm -w typecheck:server`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add server-ts/src/work/statuses.ts server-ts/src/work/statuses.test.ts
git commit -m "feat(server-ts): create, archive and reorder custom statuses by category"
```

---

### Task 9: Saved views, preferences, and the grouped/faceted issue query

**Files:**
- Create: `server-ts/src/work/views.ts`, `server-ts/src/work/issue-query.ts`
- Test: `server-ts/src/work/views.test.ts`, `server-ts/src/work/issue-query.test.ts`

**Interfaces:**
- Produces (`views.ts`): `viewCreateSchema` (`{ workspaceId, name, visibility: 'private'|'workspace' = 'private', query: object, display: object = {} }`), `viewPatchSchema` (`{ name?, visibility?, query?, display?, revision }`), `preferencesSchema` (`{ workspaceId, activeViewId: uuid | null, preferences: object }`), `interface SavedView { id; workspaceId; ownerId; name; visibility; definitionVersion: number; query: unknown; display: unknown; revision: number; createdAt; updatedAt }`, class `ViewRevisionConflict { currentRevision: number }`, and:
  - `viewWorkspace(q, viewId): Promise<string | null>`
  - `createView(q, workspaceId, ownerId, input): Promise<SavedView>`
  - `updateView(q, input: { workspaceId; viewId; actorId; moderator: boolean; patch }): Promise<SavedView>`
  - `deleteView(q, input: { workspaceId; viewId; actorId; moderator: boolean }): Promise<void>`
  - `readPreferences(q, workspaceId, userId): Promise<{ activeViewId: string | null; preferences: Record<string, unknown> }>`
  - `writePreferences(q, workspaceId, userId, input: { activeViewId: string | null; preferences: Record<string, unknown> })`, same return type
  - Rules: a private view is invisible to non-owners (NotFound). Editing someone else's shared view needs `moderator` (owner/admin role), else Forbidden.
- Produces (`issue-query.ts`): `issueQuerySchema`, `type IssueQuery`, `interface IssueQueryResult { total: number; groups: Array<{ key: string; count: number; issueIds: string[] }>; facets: { status: Record<string, number>; priority: Record<string, number>; assignee: Record<string, number> } }`, `runIssueQuery(q: Queryable, workspaceId: string, input: IssueQuery): Promise<IssueQueryResult>`.
  - Status values on the wire are API spellings (`inProgress`); assignee keys are `user:<id>`, `agent:<id>` or `none`; group keys for `property` are the value's JSON text, or `none`.

- [ ] **Step 1: Write the failing tests**

`server-ts/src/work/views.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import { cleanupWorld, seedWorld, type World } from './fixture.ts';
import {
   ViewRevisionConflict,
   createView,
   deleteView,
   readPreferences,
   updateView,
   viewCreateSchema,
   writePreferences,
} from './views.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('saved views', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'views');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await closeDatabase(sql);
   });

   test('a view is edited at its revision, and a stale revision conflicts', async () => {
      const view = await createView(sql, world.workspaceId, world.memberId, viewCreateSchema.parse({ workspaceId: world.workspaceId, name: 'Mine', query: { statuses: ['todo'] } }));
      const renamed = await updateView(sql, { workspaceId: world.workspaceId, viewId: view.id, actorId: world.memberId, moderator: false, patch: { name: 'Mine now', revision: 1 } });
      assert.equal(renamed.revision, 2);
      await assert.rejects(
         updateView(sql, { workspaceId: world.workspaceId, viewId: view.id, actorId: world.memberId, moderator: false, patch: { name: 'Stale', revision: 1 } }),
         ViewRevisionConflict
      );
   });

   test('a private view is not found by anyone else; a shared one needs a moderator to change', async () => {
      const privateView = await createView(sql, world.workspaceId, world.memberId, viewCreateSchema.parse({ workspaceId: world.workspaceId, name: 'Secret', query: {} }));
      await assert.rejects(
         deleteView(sql, { workspaceId: world.workspaceId, viewId: privateView.id, actorId: world.ownerId, moderator: true }),
         NotFound
      );
      const shared = await createView(sql, world.workspaceId, world.memberId, viewCreateSchema.parse({ workspaceId: world.workspaceId, name: 'Team', visibility: 'workspace', query: {} }));
      await assert.rejects(
         deleteView(sql, { workspaceId: world.workspaceId, viewId: shared.id, actorId: world.viewerId, moderator: false }),
         Forbidden
      );
      await deleteView(sql, { workspaceId: world.workspaceId, viewId: shared.id, actorId: world.ownerId, moderator: true });
   });

   test('preferences remember the active view per person', async () => {
      const view = await createView(sql, world.workspaceId, world.ownerId, viewCreateSchema.parse({ workspaceId: world.workspaceId, name: 'Pref', query: {} }));
      await writePreferences(sql, world.workspaceId, world.ownerId, { activeViewId: view.id, preferences: { layout: 'table' } });
      assert.deepEqual(await readPreferences(sql, world.workspaceId, world.ownerId), { activeViewId: view.id, preferences: { layout: 'table' } });
      assert.deepEqual(await readPreferences(sql, world.workspaceId, world.memberId), { activeViewId: null, preferences: {} });
   });
});
```

`server-ts/src/work/issue-query.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { cleanupWorld, createIssue, seedWorld, type World } from './fixture.ts';
import { createProperty, propertyCreateSchema, setValue } from './properties.ts';
import { issueQuerySchema, runIssueQuery } from './issue-query.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('issue query', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let other: World;
   let sizeId = '';
   const ids: Record<string, string> = {};

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'query');
      other = await seedWorld(sql, 'query-other');
      ids.todoSmall = await createIssue(sql, world, { status: 'todo' });
      ids.todoLarge = await createIssue(sql, world, { status: 'todo' });
      ids.progress = await createIssue(sql, world, { status: 'in_progress' });
      await createIssue(sql, other, { status: 'todo' });
      const size = await createProperty(sql, world.workspaceId, world.ownerId, propertyCreateSchema.parse({
         name: 'Size',
         kind: 'select',
         options: [
            { id: 's', name: 'S', color: '#111111' },
            { id: 'l', name: 'L', color: '#222222' },
         ],
      }));
      sizeId = size.id;
      await setValue(sql, { workspaceId: world.workspaceId, issueId: ids.todoSmall, propertyId: sizeId, value: 's', actorId: world.ownerId });
      await setValue(sql, { workspaceId: world.workspaceId, issueId: ids.todoLarge, propertyId: sizeId, value: 'l', actorId: world.ownerId });
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await cleanupWorld(sql, other);
      await closeDatabase(sql);
   });

   test('grouping by status counts only this workspace, with facets', async () => {
      const result = await runIssueQuery(sql, world.workspaceId, issueQuerySchema.parse({ workspaceId: world.workspaceId, groupBy: 'status' }));
      const todo = result.groups.find((group) => group.key === 'todo');
      assert.equal(todo?.count, 2);
      assert.equal(result.facets.status.inProgress, 1);
      assert.equal(result.facets.status.backlog, 1);
      assert.equal(result.total, 4);
   });

   test('a property filter narrows the set, and perGroup caps ids but not counts', async () => {
      const small = await runIssueQuery(sql, world.workspaceId, issueQuerySchema.parse({
         workspaceId: world.workspaceId,
         filter: { properties: [{ propertyId: sizeId, op: 'eq', value: 's' }] },
      }));
      assert.deepEqual(small.groups[0]?.issueIds, [ids.todoSmall]);

      const capped = await runIssueQuery(sql, world.workspaceId, issueQuerySchema.parse({
         workspaceId: world.workspaceId,
         filter: { statuses: ['todo'] },
         perGroup: 1,
      }));
      assert.equal(capped.groups[0]?.count, 2);
      assert.equal(capped.groups[0]?.issueIds.length, 1);
   });

   test('grouping by a property puts unset issues under none', async () => {
      const result = await runIssueQuery(sql, world.workspaceId, issueQuerySchema.parse({ workspaceId: world.workspaceId, groupBy: { propertyId: sizeId } }));
      assert.deepEqual(
         Object.fromEntries(result.groups.map((group) => [group.key, group.count])),
         { l: 1, none: 2, s: 1 }
      );
   });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd server-ts && node --test --experimental-strip-types src/work/views.test.ts src/work/issue-query.test.ts`
Expected: FAIL with `Cannot find module '.../work/views.ts'`.

- [ ] **Step 3: Implement `views.ts`**

```ts
import { z } from 'zod';
import { toRFC3339, type Queryable } from '../db/pool.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';

/** Saved views (`saved_issue_views`) and each person's view preferences. */
const jsonObject = z.record(z.string(), z.unknown());

export const viewCreateSchema = z
   .object({
      workspaceId: z.uuid(),
      name: z.string().trim().min(1).max(80),
      visibility: z.enum(['private', 'workspace']).default('private'),
      query: jsonObject,
      display: jsonObject.default({}),
   })
   .strict();
export type ViewCreate = z.infer<typeof viewCreateSchema>;

export const viewPatchSchema = z
   .object({
      name: z.string().trim().min(1).max(80).optional(),
      visibility: z.enum(['private', 'workspace']).optional(),
      query: jsonObject.optional(),
      display: jsonObject.optional(),
      revision: z.number().int().min(1),
   })
   .strict();
export type ViewPatch = z.infer<typeof viewPatchSchema>;

export const preferencesSchema = z
   .object({
      workspaceId: z.uuid(),
      activeViewId: z.uuid().nullable(),
      preferences: jsonObject,
   })
   .strict();

export interface SavedView {
   id: string;
   workspaceId: string;
   ownerId: string;
   name: string;
   visibility: string;
   definitionVersion: number;
   query: unknown;
   display: unknown;
   revision: number;
   createdAt: string;
   updatedAt: string;
}

export class ViewRevisionConflict extends Error {
   readonly currentRevision: number;
   constructor(currentRevision: number) {
      super('the view changed since it was read');
      this.name = 'ViewRevisionConflict';
      this.currentRevision = currentRevision;
   }
}

const COLUMNS =
   'id, workspace_id, owner_id, name, visibility, definition_version, query, display, revision, created_at, updated_at';

function toView(row: Record<string, unknown>): SavedView {
   return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      ownerId: row.owner_id as string,
      name: row.name as string,
      visibility: row.visibility as string,
      definitionVersion: Number(row.definition_version),
      query: row.query,
      display: row.display,
      revision: Number(row.revision),
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}

export async function viewWorkspace(q: Queryable, viewId: string): Promise<string | null> {
   const [row] = await q`SELECT workspace_id FROM saved_issue_views WHERE id = ${viewId}`;
   return row ? (row.workspace_id as string) : null;
}

export async function createView(
   q: Queryable,
   workspaceId: string,
   ownerId: string,
   input: ViewCreate
): Promise<SavedView> {
   const [row] = await q`
      INSERT INTO saved_issue_views (workspace_id, owner_id, name, visibility, query, display)
      VALUES (${workspaceId}, ${ownerId}, ${input.name}, ${input.visibility},
              ${q.json(input.query as never)}, ${q.json(input.display as never)})
      RETURNING ${q.unsafe(COLUMNS)}`;
   if (!row) throw new NotFound();
   return toView(row);
}

/** Locks the row and applies the visibility and ownership rules. */
async function lockEditable(
   q: Queryable,
   input: { workspaceId: string; viewId: string; actorId: string; moderator: boolean }
): Promise<number> {
   const [row] = await q`
      SELECT owner_id, visibility, revision FROM saved_issue_views
       WHERE id = ${input.viewId} AND workspace_id = ${input.workspaceId} FOR UPDATE`;
   if (!row) throw new NotFound();
   const owns = row.owner_id === input.actorId;
   if (row.visibility === 'private' && !owns) throw new NotFound();
   if (!owns && !input.moderator) throw new Forbidden();
   return Number(row.revision);
}

export async function updateView(
   q: Queryable,
   input: { workspaceId: string; viewId: string; actorId: string; moderator: boolean; patch: ViewPatch }
): Promise<SavedView> {
   const current = await lockEditable(q, input);
   if (current !== input.patch.revision) throw new ViewRevisionConflict(current);
   const { patch } = input;
   const [row] = await q`
      UPDATE saved_issue_views SET
         name = COALESCE(${patch.name ?? null}, name),
         visibility = COALESCE(${patch.visibility ?? null}, visibility),
         query = COALESCE(${patch.query ? q.json(patch.query as never) : null}::jsonb, query),
         display = COALESCE(${patch.display ? q.json(patch.display as never) : null}::jsonb, display),
         revision = revision + 1
       WHERE id = ${input.viewId}
      RETURNING ${q.unsafe(COLUMNS)}`;
   if (!row) throw new NotFound();
   return toView(row);
}

export async function deleteView(
   q: Queryable,
   input: { workspaceId: string; viewId: string; actorId: string; moderator: boolean }
): Promise<void> {
   await lockEditable(q, input);
   await q`DELETE FROM saved_issue_views WHERE id = ${input.viewId}`;
}

export async function readPreferences(
   q: Queryable,
   workspaceId: string,
   userId: string
): Promise<{ activeViewId: string | null; preferences: Record<string, unknown> }> {
   const [row] = await q`
      SELECT active_view_id, preferences FROM issue_view_preferences
       WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`;
   return {
      activeViewId: (row?.active_view_id as string | null | undefined) ?? null,
      preferences: (row?.preferences as Record<string, unknown> | undefined) ?? {},
   };
}

export async function writePreferences(
   q: Queryable,
   workspaceId: string,
   userId: string,
   input: { activeViewId: string | null; preferences: Record<string, unknown> }
): Promise<{ activeViewId: string | null; preferences: Record<string, unknown> }> {
   if (input.activeViewId !== null) {
      const [visible] = await q`
         SELECT 1 FROM saved_issue_views
          WHERE id = ${input.activeViewId} AND workspace_id = ${workspaceId}
            AND (visibility <> 'private' OR owner_id = ${userId})`;
      if (!visible) throw new NotFound();
   }
   await q`
      INSERT INTO issue_view_preferences (workspace_id, user_id, active_view_id, preferences)
      VALUES (${workspaceId}, ${userId}, ${input.activeViewId}, ${q.json(input.preferences as never)})
      ON CONFLICT (workspace_id, user_id)
      DO UPDATE SET active_view_id = EXCLUDED.active_view_id, preferences = EXCLUDED.preferences`;
   return readPreferences(q, workspaceId, userId);
}
```

- [ ] **Step 4: Implement `issue-query.ts`**

```ts
import { z } from 'zod';
import type { Queryable } from '../db/pool.ts';
import { apiStatusToDb, dbStatusToApi } from '../core/issues.ts';

/**
 * The view query: filter the workspace's issues, group them, count every group
 * and three facets, and return the first `perGroup` ids of each group.
 *
 * One static statement with every filter behind a boolean guard (the house
 * style of `IssueRepository.list`), so the plan is one prepared shape
 * whatever the view asks for. Property filters travel as one jsonb array that
 * every element of must match.
 */
const API_STATUSES = ['backlog', 'todo', 'inProgress', 'inReview', 'done', 'blocked', 'cancelled'] as const;
const PRIORITIES = ['none', 'urgent', 'high', 'medium', 'low'] as const;

const personRef = z.object({ type: z.enum(['user', 'agent']), id: z.uuid() }).strict();

const propertyFilterSchema = z.discriminatedUnion('op', [
   z.object({ propertyId: z.uuid(), op: z.literal('isSet') }).strict(),
   z.object({ propertyId: z.uuid(), op: z.literal('notSet') }).strict(),
   z
      .object({
         propertyId: z.uuid(),
         op: z.literal('eq'),
         value: z.union([z.string().max(2000), z.number(), z.boolean()]),
      })
      .strict(),
   z
      .object({ propertyId: z.uuid(), op: z.literal('in'), values: z.array(z.string().max(200)).min(1).max(100) })
      .strict(),
   z
      .object({ propertyId: z.uuid(), op: z.literal('contains'), value: z.union([z.string().max(200), personRef]) })
      .strict(),
   z
      .object({ propertyId: z.uuid(), op: z.literal('gt'), value: z.union([z.number(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]) })
      .strict(),
   z
      .object({ propertyId: z.uuid(), op: z.literal('lt'), value: z.union([z.number(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]) })
      .strict(),
]);

export const issueQuerySchema = z
   .object({
      workspaceId: z.uuid(),
      filter: z
         .object({
            boardIds: z.array(z.uuid()).max(50).optional(),
            statuses: z.array(z.enum(API_STATUSES)).optional(),
            statusIds: z.array(z.uuid()).max(100).optional(),
            priorities: z.array(z.enum(PRIORITIES)).optional(),
            assignees: z.array(personRef).max(50).optional(),
            unassigned: z.boolean().optional(),
            labelIds: z.array(z.uuid()).max(50).optional(),
            parentId: z.uuid().nullable().optional(),
            query: z.string().trim().min(1).max(200).optional(),
            properties: z.array(propertyFilterSchema).max(20).optional(),
         })
         .strict()
         .default({}),
      groupBy: z
         .union([
            z.enum(['none', 'status', 'priority', 'assignee', 'parent']),
            z.object({ propertyId: z.uuid() }).strict(),
         ])
         .default('none'),
      perGroup: z.number().int().min(1).max(200).default(50),
   })
   .strict();
export type IssueQuery = z.infer<typeof issueQuerySchema>;

export interface IssueQueryResult {
   total: number;
   groups: Array<{ key: string; count: number; issueIds: string[] }>;
   facets: {
      status: Record<string, number>;
      priority: Record<string, number>;
      assignee: Record<string, number>;
   };
}

function nonEmpty<T>(values: T[] | undefined): T[] | null {
   return values && values.length > 0 ? values : null;
}

export async function runIssueQuery(
   q: Queryable,
   workspaceId: string,
   input: IssueQuery
): Promise<IssueQueryResult> {
   const filter = input.filter;
   const boardIds = nonEmpty(filter.boardIds);
   const statuses = nonEmpty(filter.statuses?.map(apiStatusToDb));
   const statusIds = nonEmpty(filter.statusIds);
   const priorities = nonEmpty(filter.priorities);
   const assigneeKeys = [
      ...(filter.assignees ?? []).map((person) => `${person.type}:${person.id}`),
      ...(filter.unassigned ? ['none'] : []),
   ];
   const labelIds = nonEmpty(filter.labelIds);
   const parentSet = filter.parentId !== undefined;
   const pattern =
      filter.query === undefined ? null : `%${filter.query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
   const groupKind = typeof input.groupBy === 'string' ? input.groupBy : 'property';
   const groupPropertyId = typeof input.groupBy === 'string' ? null : input.groupBy.propertyId;

   const rows = await q`
      WITH filtered AS (
         SELECT i.id, i.status::text AS status, i.priority::text AS priority,
                COALESCE(i.assignee_type::text || ':' || i.assignee_id::text, 'none') AS assignee,
                i.sort_order, i.updated_at,
                CASE ${groupKind}::text
                   WHEN 'status' THEN i.status::text
                   WHEN 'priority' THEN i.priority::text
                   WHEN 'assignee' THEN COALESCE(i.assignee_type::text || ':' || i.assignee_id::text, 'none')
                   WHEN 'parent' THEN COALESCE(i.parent_id::text, 'none')
                   WHEN 'property' THEN COALESCE((
                      SELECT grouped.value #>> '{}' FROM issue_property_values AS grouped
                       WHERE grouped.workspace_id = ${workspaceId} AND grouped.issue_id = i.id
                         AND grouped.property_id = ${groupPropertyId}::uuid), 'none')
                   ELSE 'all'
                END AS group_key
           FROM issues AS i
           JOIN boards AS b ON b.id = i.board_id
          WHERE b.workspace_id = ${workspaceId}
            AND i.deleted_at IS NULL
            AND (${boardIds === null}::boolean OR i.board_id = ANY(${boardIds}::uuid[]))
            AND (${statuses === null}::boolean OR i.status::text = ANY(${statuses}::text[]))
            AND (${statusIds === null}::boolean OR i.status_id = ANY(${statusIds}::uuid[]))
            AND (${priorities === null}::boolean OR i.priority::text = ANY(${priorities}::text[]))
            AND (${assigneeKeys.length === 0}::boolean OR
                 COALESCE(i.assignee_type::text || ':' || i.assignee_id::text, 'none')
                    = ANY(${assigneeKeys}::text[]))
            AND (${labelIds === null}::boolean OR EXISTS (
                 SELECT 1 FROM issue_label_memberships AS membership
                  WHERE membership.workspace_id = ${workspaceId} AND membership.issue_id = i.id
                    AND membership.label_id = ANY(${labelIds}::uuid[])))
            AND (NOT ${parentSet}::boolean OR i.parent_id IS NOT DISTINCT FROM ${filter.parentId ?? null}::uuid)
            AND (${pattern === null}::boolean OR i.title ILIKE ${pattern}::text)
            AND NOT EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(${q.json((filter.properties ?? []) as never)}::jsonb) AS f(spec)
                 LEFT JOIN issue_property_values AS pv
                   ON pv.workspace_id = ${workspaceId} AND pv.issue_id = i.id
                  AND pv.property_id = (f.spec ->> 'propertyId')::uuid
                WHERE NOT COALESCE(CASE f.spec ->> 'op'
                   WHEN 'isSet' THEN pv.value IS NOT NULL
                   WHEN 'notSet' THEN pv.value IS NULL
                   WHEN 'eq' THEN pv.value = f.spec -> 'value'
                   WHEN 'in' THEN (pv.value #>> '{}') IN (SELECT jsonb_array_elements_text(f.spec -> 'values'))
                   WHEN 'contains' THEN pv.value @> jsonb_build_array(f.spec -> 'value')
                   WHEN 'gt' THEN CASE
                      WHEN jsonb_typeof(f.spec -> 'value') = 'number' AND jsonb_typeof(pv.value) = 'number'
                         THEN (pv.value #>> '{}')::numeric > (f.spec ->> 'value')::numeric
                      WHEN jsonb_typeof(f.spec -> 'value') = 'string' AND jsonb_typeof(pv.value) = 'string'
                         THEN (pv.value #>> '{}') > (f.spec ->> 'value')
                      ELSE false END
                   WHEN 'lt' THEN CASE
                      WHEN jsonb_typeof(f.spec -> 'value') = 'number' AND jsonb_typeof(pv.value) = 'number'
                         THEN (pv.value #>> '{}')::numeric < (f.spec ->> 'value')::numeric
                      WHEN jsonb_typeof(f.spec -> 'value') = 'string' AND jsonb_typeof(pv.value) = 'string'
                         THEN (pv.value #>> '{}') < (f.spec ->> 'value')
                      ELSE false END
                END, false)
            )
      ),
      ranked AS (
         SELECT group_key, id,
                count(*) OVER (PARTITION BY group_key)::int AS group_count,
                row_number() OVER (PARTITION BY group_key
                                   ORDER BY sort_order ASC, updated_at DESC, id DESC) AS rank
           FROM filtered
      )
      SELECT 'group' AS kind, group_key AS key, id::text AS id, group_count AS count, rank
        FROM ranked WHERE rank <= ${input.perGroup}
      UNION ALL
      SELECT 'status', status, NULL, count(*)::int, NULL FROM filtered GROUP BY status
      UNION ALL
      SELECT 'priority', priority, NULL, count(*)::int, NULL FROM filtered GROUP BY priority
      UNION ALL
      SELECT 'assignee', assignee, NULL, count(*)::int, NULL FROM filtered GROUP BY assignee`;

   const groups = new Map<string, { key: string; count: number; issueIds: Array<[number, string]> }>();
   const facets: IssueQueryResult['facets'] = { status: {}, priority: {}, assignee: {} };
   let total = 0;
   for (const row of rows) {
      const kind = row.kind as string;
      const rawKey = row.key as string;
      const count = Number(row.count);
      if (kind === 'group') {
         const key = groupKind === 'status' ? dbStatusToApi(rawKey) : rawKey;
         const group = groups.get(key) ?? { key, count, issueIds: [] };
         group.issueIds.push([Number(row.rank), row.id as string]);
         groups.set(key, group);
      } else if (kind === 'status') {
         facets.status[dbStatusToApi(rawKey)] = count;
         total += count;
      } else if (kind === 'priority') {
         facets.priority[rawKey] = count;
      } else {
         facets.assignee[rawKey] = count;
      }
   }
   return {
      total,
      groups: [...groups.values()]
         .sort((left, right) => left.key.localeCompare(right.key))
         .map((group) => ({
            key: group.key,
            count: group.count,
            issueIds: group.issueIds.sort((left, right) => left[0] - right[0]).map(([, id]) => id),
         })),
      facets,
   };
}
```

- [ ] **Step 5: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types src/work/views.test.ts src/work/issue-query.test.ts && pnpm -w typecheck:server`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add server-ts/src/work/views.ts server-ts/src/work/issue-query.ts server-ts/src/work/views.test.ts server-ts/src/work/issue-query.test.ts
git commit -m "feat(server-ts): save views with preferences and answer grouped, faceted issue queries"
```

---
### Task 10: Timeline, pins and quick actions

**Files:**
- Create: `server-ts/src/work/activity.ts`, `server-ts/src/work/pins.ts`, `server-ts/src/work/quick-actions.ts`
- Test: `server-ts/src/work/activity.test.ts`, `server-ts/src/work/pins.test.ts`, `server-ts/src/work/quick-actions.test.ts`

**Interfaces:**
- Consumes: `recordIssueEvent` (Task 3); fixture.
- Produces (`activity.ts`): `interface ActivityActor { type: string; id: string; name: string | null; avatarUrl: string | null }`, `interface ActivityEntry { id: string; type: string; occurredAt: string; actor: ActivityActor | null; changedFields: string[]; previousStatus: string | null; status: string | null; commentId: string | null; details: Record<string, unknown> }`, `listIssueActivity(q: Queryable, input: { workspaceId; issueId; after: { createdAt: string; id: string } | null; limit: number }): Promise<ActivityEntry[]>` (oldest first).
- Produces (`pins.ts`): `PIN_TARGETS = ['issue','view','project']`, `pinCreateSchema` (`{ workspaceId, targetType, targetId }`), `pinOrderSchema` (`{ workspaceId, ids }`), `interface Pin { id; targetType; targetId; position: number; title: string; identifier: string | null }`, `listPins(q, workspaceId, userId): Promise<Pin[]>`, `pin(q, workspaceId, userId, targetType, targetId): Promise<Pin>` (NotFound when the target is not visible in the workspace; idempotent), `unpin(q, workspaceId, userId, pinId): Promise<boolean>`, `reorderPins(q, workspaceId, userId, ids): Promise<Pin[]>`.
- Produces (`quick-actions.ts`): `quickActionCreateSchema` (`{ name, description?, targetAgentId, prompt, visibility = 'workspace' }`), `quickActionPatchSchema`, `interface QuickAction { id; workspaceId; name; description: string | null; targetAgentId; prompt; visibility: 'private' | 'workspace'; createdBy; createdAt; updatedAt }`, class `QuickActionNameTaken`, type `QuickActionEnqueue` (mirrors A's `enqueueTask`), `listQuickActions(q, workspaceId, viewerId)`, `createQuickAction(q, workspaceId, actorId, input)`, `updateQuickAction(q, input: { workspaceId; actionId; actorId; moderator; patch })`, `archiveQuickAction(q, input: { workspaceId; actionId; actorId; moderator })`, `renderPrompt(template, issue: { identifier; title; description: string | null }): string`, `runQuickAction(sql: Sql, enqueue: QuickActionEnqueue, input: { workspaceId; actionId; viewerId; issue: { id; identifier; title; description: string | null } }): Promise<{ runId: string }>`.

- [ ] **Step 1: Write the failing tests**

`server-ts/src/work/activity.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { CommentRepository } from '../core/comments.ts';
import { cleanupWorld, seedWorld, type World } from './fixture.ts';
import { recordIssueEvent } from './outbox.ts';
import { listIssueActivity } from './activity.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('issue timeline', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'timeline');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await closeDatabase(sql);
   });

   test('work events and comments appear in order, with named actors, and page forward', async () => {
      await recordIssueEvent(sql, { issueId: world.issueId, type: 'issue.properties.changed', actor: { type: 'user', id: world.ownerId }, payload: { propertyId: 'x' } });
      const comment = await new CommentRepository(sql).create({ issueId: world.issueId, authorId: world.memberId, body: 'Hi', createdAt: new Date(Date.now() + 5).toISOString() });

      const all = await listIssueActivity(sql, { workspaceId: world.workspaceId, issueId: world.issueId, after: null, limit: 50 });
      assert.deepEqual(all.map((entry) => entry.type), ['issue.properties.changed', 'comment.created']);
      assert.equal(all[0]?.actor?.name, 'Owner');
      assert.equal(all[1]?.commentId, comment.comment.id);
      assert.equal(all[1]?.actor?.name, 'Member');

      const first = all[0];
      assert.ok(first);
      const rest = await listIssueActivity(sql, { workspaceId: world.workspaceId, issueId: world.issueId, after: { createdAt: first.occurredAt, id: first.id }, limit: 50 });
      assert.deepEqual(rest.map((entry) => entry.type), ['comment.created']);
   });
});
```

`server-ts/src/work/pins.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import { cleanupWorld, createIssue, seedWorld, type World } from './fixture.ts';
import { listPins, pin, reorderPins, unpin } from './pins.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('pins', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let other: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'pins');
      other = await seedWorld(sql, 'pins-other');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await cleanupWorld(sql, other);
      await closeDatabase(sql);
   });

   test('pins list in order with titles, reorder, and unpin', async () => {
      const second = await createIssue(sql, world, { title: 'Second' });
      const a = await pin(sql, world.workspaceId, world.memberId, 'issue', world.issueId);
      const b = await pin(sql, world.workspaceId, world.memberId, 'issue', second);
      assert.equal((await pin(sql, world.workspaceId, world.memberId, 'issue', second)).id, b.id);
      assert.deepEqual((await listPins(sql, world.workspaceId, world.memberId)).map((entry) => entry.title), ['Root task', 'Second']);
      const reordered = await reorderPins(sql, world.workspaceId, world.memberId, [b.id, a.id]);
      assert.deepEqual(reordered.map((entry) => entry.id), [b.id, a.id]);
      assert.equal(await unpin(sql, world.workspaceId, world.memberId, a.id), true);
      assert.equal((await listPins(sql, world.workspaceId, world.ownerId)).length, 0);
   });

   test('an issue from another workspace cannot be pinned', async () => {
      await assert.rejects(pin(sql, world.workspaceId, world.memberId, 'issue', other.issueId), NotFound);
   });
});
```

`server-ts/src/work/quick-actions.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import { cleanupWorld, seedWorld, type World } from './fixture.ts';
import {
   QuickActionNameTaken,
   createQuickAction,
   listQuickActions,
   quickActionCreateSchema,
   renderPrompt,
   runQuickAction,
   type QuickActionEnqueue,
} from './quick-actions.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('quick actions', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'qa');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await closeDatabase(sql);
   });

   test('a template names the issue', () => {
      assert.equal(
         renderPrompt('Review {{ issue.identifier }}: {{issue.title}}\n{{issue.description}}', { identifier: 'WRK-1', title: 'Fix', description: null }),
         'Review WRK-1: Fix\n'
      );
   });

   test('a private action is invisible to others, and a shared name is unique', async () => {
      await createQuickAction(sql, world.workspaceId, world.memberId, quickActionCreateSchema.parse({ name: 'Mine', targetAgentId: world.agentId, prompt: 'x', visibility: 'private' }));
      assert.equal((await listQuickActions(sql, world.workspaceId, world.ownerId)).some((action) => action.name === 'Mine'), false);
      await createQuickAction(sql, world.workspaceId, world.ownerId, quickActionCreateSchema.parse({ name: 'Triage', targetAgentId: world.agentId, prompt: 'x' }));
      await assert.rejects(
         createQuickAction(sql, world.workspaceId, world.memberId, quickActionCreateSchema.parse({ name: 'triage', targetAgentId: world.agentId, prompt: 'y' })),
         QuickActionNameTaken
      );
   });

   test('running an action enqueues an agent task for the issue with the rendered prompt', async () => {
      const action = await createQuickAction(sql, world.workspaceId, world.ownerId, quickActionCreateSchema.parse({ name: 'Summarise', targetAgentId: world.agentId, prompt: 'Summarise {{issue.identifier}}' }));
      const calls: Array<Parameters<QuickActionEnqueue>[1]> = [];
      const enqueue: QuickActionEnqueue = async (_sql, input) => {
         calls.push(input);
         return { runId: 'run-1' };
      };
      const issue = { id: world.issueId, identifier: 'WRK-1', title: 'Root task', description: null };
      assert.deepEqual(await runQuickAction(sql, enqueue, { workspaceId: world.workspaceId, actionId: action.id, viewerId: world.memberId, issue }), { runId: 'run-1' });
      assert.deepEqual(calls[0], {
         workspaceId: world.workspaceId,
         agentId: world.agentId,
         issueId: world.issueId,
         kind: 'agent',
         source: 'quick_action',
         prompt: 'Summarise WRK-1',
      });
      await assert.rejects(
         runQuickAction(sql, enqueue, { workspaceId: world.workspaceId, actionId: '00000000-0000-4000-8000-000000000000', viewerId: world.memberId, issue }),
         NotFound
      );
   });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd server-ts && node --test --experimental-strip-types src/work/activity.test.ts src/work/pins.test.ts src/work/quick-actions.test.ts`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `activity.ts`**

```ts
import { toRFC3339, type Queryable } from '../db/pool.ts';

/**
 * An issue's timeline, read from `outbox_events` by the envelope's issueId.
 * No projection table: every issue, comment and work-tracking change already
 * writes one outbox row in the transaction that made it.
 */
export interface ActivityActor {
   type: string;
   id: string;
   name: string | null;
   avatarUrl: string | null;
}

export interface ActivityEntry {
   id: string;
   type: string;
   occurredAt: string;
   actor: ActivityActor | null;
   changedFields: string[];
   previousStatus: string | null;
   status: string | null;
   commentId: string | null;
   details: Record<string, unknown>;
}

interface RawActor {
   type: string;
   id: string;
}

function readActor(inner: Record<string, unknown>): RawActor | null {
   const direct = inner.actor as RawActor | undefined;
   if (direct && typeof direct.id === 'string') return { type: direct.type, id: direct.id };
   const comment = inner.comment as { author?: RawActor } | undefined;
   if (comment?.author && typeof comment.author.id === 'string') {
      return { type: comment.author.type, id: comment.author.id };
   }
   return null;
}

export async function listIssueActivity(
   q: Queryable,
   input: {
      workspaceId: string;
      issueId: string;
      after: { createdAt: string; id: string } | null;
      limit: number;
   }
): Promise<ActivityEntry[]> {
   const rows = await q`
      SELECT id, topic, occurred_at, payload FROM outbox_events
       WHERE workspace_id = ${input.workspaceId}
         AND payload ? 'issueId' AND payload ->> 'issueId' = ${input.issueId}
         AND (${input.after === null} OR (occurred_at, id) >
              (${input.after?.createdAt ?? null}::timestamptz, ${input.after?.id ?? null}::uuid))
       ORDER BY occurred_at ASC, id ASC
       LIMIT ${input.limit}`;

   const raw = rows.map((row) => {
      const envelope = row.payload as Record<string, unknown>;
      const inner = (envelope.payload ?? {}) as Record<string, unknown>;
      return { row, inner, actor: readActor(inner) };
   });

   const userIds = [...new Set(raw.flatMap((entry) => (entry.actor?.type === 'user' ? [entry.actor.id] : [])))];
   const agentIds = [...new Set(raw.flatMap((entry) => (entry.actor?.type === 'agent' ? [entry.actor.id] : [])))];
   const names = new Map<string, { name: string | null; avatarUrl: string | null }>();
   if (userIds.length > 0 || agentIds.length > 0) {
      const people = await q`
         SELECT 'user' AS type, id::text AS id, name, avatar_url FROM users
          WHERE id = ANY(${userIds}::uuid[])
         UNION ALL
         SELECT 'agent', id::text, name, avatar_url FROM agents
          WHERE id = ANY(${agentIds}::uuid[]) AND workspace_id = ${input.workspaceId}`;
      for (const person of people) {
         names.set(`${person.type as string}:${person.id as string}`, {
            name: (person.name as string | null) ?? null,
            avatarUrl: (person.avatar_url as string | null) ?? null,
         });
      }
   }

   return raw.map(({ row, inner, actor }) => {
      const issue = inner.issue as { status?: string } | undefined;
      const comment = inner.comment as { id?: string } | undefined;
      const known = actor ? names.get(`${actor.type}:${actor.id}`) : undefined;
      const details = { ...inner };
      delete details.issue;
      delete details.comment;
      delete details.actor;
      return {
         id: row.id as string,
         type: row.topic as string,
         occurredAt: toRFC3339(row.occurred_at as string) ?? '',
         actor: actor
            ? { type: actor.type, id: actor.id, name: known?.name ?? null, avatarUrl: known?.avatarUrl ?? null }
            : null,
         changedFields: Array.isArray(inner.changedFields) ? (inner.changedFields as string[]) : [],
         previousStatus: typeof inner.previousStatus === 'string' ? inner.previousStatus : null,
         status: issue?.status ?? null,
         commentId: comment?.id ?? null,
         details,
      };
   });
}
```

- [ ] **Step 4: Implement `pins.ts`**

```ts
import { z } from 'zod';
import type { Queryable } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';

/** A person's sidebar pins in one workspace (`user_pins`). */
export const PIN_TARGETS = ['issue', 'view', 'project'] as const;
export type PinTarget = (typeof PIN_TARGETS)[number];

export const pinCreateSchema = z
   .object({ workspaceId: z.uuid(), targetType: z.enum(PIN_TARGETS), targetId: z.uuid() })
   .strict();
export const pinOrderSchema = z
   .object({ workspaceId: z.uuid(), ids: z.array(z.uuid()).min(1).max(200) })
   .strict();

export interface Pin {
   id: string;
   targetType: PinTarget;
   targetId: string;
   position: number;
   title: string;
   identifier: string | null;
}

/** Pins whose target is gone or no longer visible are left out, not shown blank. */
export async function listPins(q: Queryable, workspaceId: string, userId: string): Promise<Pin[]> {
   const rows = await q`
      SELECT pin.id, pin.target_type, pin.target_id, pin.position,
             COALESCE(issue.title, saved.name, project.name) AS title,
             CASE WHEN pin.target_type = 'issue'
                  THEN berry_issue_identifier(${workspaceId}, issue.number) END AS identifier
        FROM user_pins AS pin
        LEFT JOIN issues AS issue
          ON pin.target_type = 'issue' AND issue.id = pin.target_id AND issue.deleted_at IS NULL
        LEFT JOIN saved_issue_views AS saved
          ON pin.target_type = 'view' AND saved.id = pin.target_id
         AND (saved.visibility <> 'private' OR saved.owner_id = ${userId})
        LEFT JOIN projects AS project
          ON pin.target_type = 'project' AND project.id = pin.target_id AND project.deleted_at IS NULL
       WHERE pin.workspace_id = ${workspaceId} AND pin.user_id = ${userId}
       ORDER BY pin.position, pin.id`;
   return rows
      .filter((row) => row.title !== null)
      .map((row) => ({
         id: row.id as string,
         targetType: row.target_type as PinTarget,
         targetId: row.target_id as string,
         position: Number(row.position),
         title: row.title as string,
         identifier: (row.identifier as string | null) ?? null,
      }));
}

async function targetVisible(
   q: Queryable,
   workspaceId: string,
   userId: string,
   targetType: PinTarget,
   targetId: string
): Promise<boolean> {
   const rows =
      targetType === 'issue'
         ? await q`
              SELECT 1 FROM issues AS issue JOIN boards AS board ON board.id = issue.board_id
               WHERE issue.id = ${targetId} AND board.workspace_id = ${workspaceId}
                 AND issue.deleted_at IS NULL`
         : targetType === 'view'
           ? await q`
                SELECT 1 FROM saved_issue_views
                 WHERE id = ${targetId} AND workspace_id = ${workspaceId}
                   AND (visibility <> 'private' OR owner_id = ${userId})`
           : await q`
                SELECT 1 FROM projects
                 WHERE id = ${targetId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`;
   return rows.length === 1;
}

export async function pin(
   q: Queryable,
   workspaceId: string,
   userId: string,
   targetType: PinTarget,
   targetId: string
): Promise<Pin> {
   if (!(await targetVisible(q, workspaceId, userId, targetType, targetId))) throw new NotFound();
   await q`
      INSERT INTO user_pins (workspace_id, user_id, target_type, target_id, position)
      VALUES (${workspaceId}, ${userId}, ${targetType}, ${targetId},
              COALESCE((SELECT max(position) + 1 FROM user_pins
                         WHERE workspace_id = ${workspaceId} AND user_id = ${userId}), 0))
      ON CONFLICT (workspace_id, user_id, target_type, target_id) DO NOTHING`;
   const found = (await listPins(q, workspaceId, userId)).find(
      (entry) => entry.targetType === targetType && entry.targetId === targetId
   );
   if (!found) throw new NotFound();
   return found;
}

export async function unpin(q: Queryable, workspaceId: string, userId: string, pinId: string): Promise<boolean> {
   const rows = await q`
      DELETE FROM user_pins WHERE id = ${pinId} AND workspace_id = ${workspaceId} AND user_id = ${userId}
      RETURNING id`;
   return rows.length === 1;
}

/** Positions are unique but deferrable, so the swap commits as one statement. */
export async function reorderPins(
   q: Queryable,
   workspaceId: string,
   userId: string,
   ids: string[]
): Promise<Pin[]> {
   await q`
      UPDATE user_pins AS pin SET position = ordered.position - 1
        FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS ordered(id, position)
       WHERE pin.id = ordered.id AND pin.workspace_id = ${workspaceId} AND pin.user_id = ${userId}`;
   return listPins(q, workspaceId, userId);
}
```

- [ ] **Step 5: Implement `quick-actions.ts`**

```ts
import { z } from 'zod';
import { toRFC3339, type Queryable, type Sql } from '../db/pool.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';

/**
 * Workspace prompt templates run on an issue as an agent task.
 *
 * `QuickActionEnqueue` mirrors workstream A's `enqueueTask`
 * (`runs/queue.ts`). It is a parameter so this module compiles and is tested
 * before A merges; `index.ts` passes the real function.
 */
export type QuickActionEnqueue = (
   sql: Sql,
   input: {
      workspaceId: string;
      agentId: string;
      issueId?: string;
      kind: 'agent' | 'completion';
      source: 'assignment' | 'mention' | 'chat' | 'autopilot' | 'squad' | 'quick_action' | 'builder' | 'completion';
      prompt?: string;
      chatSessionId?: string;
      autopilotRunId?: string;
      priority?: number;
   }
) => Promise<{ runId: string }>;

export const quickActionCreateSchema = z
   .object({
      name: z.string().trim().min(1).max(100),
      description: z.string().trim().max(1000).nullable().default(null),
      targetAgentId: z.uuid(),
      prompt: z.string().min(1).max(20000),
      visibility: z.enum(['private', 'workspace']).default('workspace'),
   })
   .strict();
export type QuickActionCreate = z.infer<typeof quickActionCreateSchema>;

export const quickActionPatchSchema = z
   .object({
      name: z.string().trim().min(1).max(100).optional(),
      description: z.string().trim().max(1000).nullable().optional(),
      targetAgentId: z.uuid().optional(),
      prompt: z.string().min(1).max(20000).optional(),
      visibility: z.enum(['private', 'workspace']).optional(),
   })
   .strict();
export type QuickActionPatch = z.infer<typeof quickActionPatchSchema>;

export interface QuickAction {
   id: string;
   workspaceId: string;
   name: string;
   description: string | null;
   targetAgentId: string;
   prompt: string;
   visibility: 'private' | 'workspace';
   createdBy: string;
   createdAt: string;
   updatedAt: string;
}

export class QuickActionNameTaken extends Error {
   constructor() {
      super('a shared quick action with that name exists');
      this.name = 'QuickActionNameTaken';
   }
}

const COLUMNS =
   'id, workspace_id, name, description, target_agent_id, prompt, visibility, created_by, created_at, updated_at';

function toAction(row: Record<string, unknown>): QuickAction {
   return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      targetAgentId: row.target_agent_id as string,
      prompt: row.prompt as string,
      visibility: row.visibility as 'private' | 'workspace',
      createdBy: row.created_by as string,
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}

function mapWriteError(error: unknown): never {
   const code = (error as { code?: string }).code;
   if (code === '23505') throw new QuickActionNameTaken();
   if (code === '23503') throw new NotFound();
   throw error;
}

export async function listQuickActions(q: Queryable, workspaceId: string, viewerId: string): Promise<QuickAction[]> {
   const rows = await q`
      SELECT ${q.unsafe(COLUMNS)} FROM quick_action_definitions
       WHERE workspace_id = ${workspaceId} AND archived_at IS NULL
         AND (visibility = 'workspace' OR created_by = ${viewerId})
       ORDER BY lower(name), id`;
   return rows.map(toAction);
}

async function findVisible(q: Queryable, workspaceId: string, actionId: string, viewerId: string): Promise<QuickAction> {
   const [row] = await q`
      SELECT ${q.unsafe(COLUMNS)} FROM quick_action_definitions
       WHERE id = ${actionId} AND workspace_id = ${workspaceId} AND archived_at IS NULL
         AND (visibility = 'workspace' OR created_by = ${viewerId})`;
   if (!row) throw new NotFound();
   return toAction(row);
}

export async function createQuickAction(
   q: Queryable,
   workspaceId: string,
   actorId: string,
   input: QuickActionCreate
): Promise<QuickAction> {
   const rows = await q`
      INSERT INTO quick_action_definitions
         (workspace_id, name, description, target_agent_id, prompt, visibility, created_by)
      VALUES (${workspaceId}, ${input.name}, ${input.description}, ${input.targetAgentId},
              ${input.prompt}, ${input.visibility}, ${actorId})
      RETURNING ${q.unsafe(COLUMNS)}`.catch(mapWriteError);
   const [row] = rows;
   if (!row) throw new NotFound();
   return toAction(row);
}

export async function updateQuickAction(
   q: Queryable,
   input: { workspaceId: string; actionId: string; actorId: string; moderator: boolean; patch: QuickActionPatch }
): Promise<QuickAction> {
   const current = await findVisible(q, input.workspaceId, input.actionId, input.actorId);
   if (current.createdBy !== input.actorId && !input.moderator) throw new Forbidden();
   const { patch } = input;
   const rows = await q`
      UPDATE quick_action_definitions SET
         name = COALESCE(${patch.name ?? null}, name),
         description = CASE WHEN ${patch.description !== undefined} THEN ${patch.description ?? null}::text ELSE description END,
         target_agent_id = COALESCE(${patch.targetAgentId ?? null}::uuid, target_agent_id),
         prompt = COALESCE(${patch.prompt ?? null}, prompt),
         visibility = COALESCE(${patch.visibility ?? null}, visibility),
         updated_at = now()
       WHERE id = ${input.actionId}
      RETURNING ${q.unsafe(COLUMNS)}`.catch(mapWriteError);
   const [row] = rows;
   if (!row) throw new NotFound();
   return toAction(row);
}

export async function archiveQuickAction(
   q: Queryable,
   input: { workspaceId: string; actionId: string; actorId: string; moderator: boolean }
): Promise<void> {
   const current = await findVisible(q, input.workspaceId, input.actionId, input.actorId);
   if (current.createdBy !== input.actorId && !input.moderator) throw new Forbidden();
   await q`
      UPDATE quick_action_definitions SET archived_at = now(), updated_at = now()
       WHERE id = ${input.actionId}`;
}

export function renderPrompt(
   template: string,
   issue: { identifier: string; title: string; description: string | null }
): string {
   return template.replace(/\{\{\s*issue\.(identifier|title|description)\s*\}\}/g, (_match, field: string) => {
      if (field === 'identifier') return issue.identifier;
      if (field === 'title') return issue.title;
      return issue.description ?? '';
   });
}

export async function runQuickAction(
   sql: Sql,
   enqueue: QuickActionEnqueue,
   input: {
      workspaceId: string;
      actionId: string;
      viewerId: string;
      issue: { id: string; identifier: string; title: string; description: string | null };
   }
): Promise<{ runId: string }> {
   const action = await findVisible(sql, input.workspaceId, input.actionId, input.viewerId);
   return enqueue(sql, {
      workspaceId: input.workspaceId,
      agentId: action.targetAgentId,
      issueId: input.issue.id,
      kind: 'agent',
      source: 'quick_action',
      prompt: renderPrompt(action.prompt, input.issue),
   });
}
```

- [ ] **Step 6: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types src/work/activity.test.ts src/work/pins.test.ts src/work/quick-actions.test.ts && pnpm -w typecheck:server`
Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add server-ts/src/work/activity.ts server-ts/src/work/pins.ts server-ts/src/work/quick-actions.ts server-ts/src/work/activity.test.ts server-ts/src/work/pins.test.ts server-ts/src/work/quick-actions.test.ts
git commit -m "feat(server-ts): read issue timelines, keep sidebar pins, run quick actions"
```

---

### Task 11: Batch, move, quick-create helpers, and join links

**Files:**
- Create: `server-ts/src/work/batch.ts`, `server-ts/src/work/join-links.ts`
- Test: `server-ts/src/work/batch.test.ts` (offline + DB), `server-ts/src/work/join-links.test.ts`

**Interfaces:**
- Produces (`batch.ts`): `batchUpdateSchema` (`{ issueIds: uuid[1..100], patch: { status?, statusId?, priority?, assignee?: {type,id} | null } }`), `batchDeleteSchema` (`{ issueIds }`), `moveSchema` (`{ beforeId?: uuid | null, afterId?: uuid | null }`), `quickCreateSchema` (`{ workspaceId, title, boardId?, parentId?, stage? }`), `childCreateSchema` (`{ title?, fromCommentId?, stage? }`, one of title or fromCommentId), `parentSchema` (`{ parentId: uuid | null, stage?: int | null }`), `statusChangeSchema` (`{ statusId }`), `subscriptionSchema` (`{ subtree?: boolean }`), `sortOrderBetween(before?: number, after?: number): number`, `sortOrderOf(q, issueId): Promise<number>`, `defaultBoardId(q, workspaceId): Promise<string>`, `assigneeFrequency(q, workspaceId, userId): Promise<Array<{ type: string; id: string; count: number }>>`.
- Produces (`join-links.ts`): `JOIN_TOKEN_PREFIX = 'berry_join_'`, `joinLinkCreateSchema` (`{ role: 'admin'|'member'|'viewer' = 'member', expiresInDays?: 1..365, maxUses?: 1..10000 }`), `interface JoinLink { id; workspaceId; role; expiresAt: string | null; maxUses: number | null; useCount: number; revokedAt: string | null; createdAt; createdBy }`, `createJoinLink(q, workspaceId, actorId, input): Promise<{ link: JoinLink; token: string }>`, `listJoinLinks(q, workspaceId): Promise<JoinLink[]>`, `revokeJoinLink(q, workspaceId, linkId): Promise<boolean>`, `lookupJoinLink(q, token): Promise<{ workspaceId; workspaceName; role; expiresAt: string | null } | null>`, `acceptJoinLink(sql: Sql, token, userId): Promise<{ workspaceId; role; joined: boolean }>` (class `JoinLinkInvalid` when unusable).

- [ ] **Step 1: Write the failing tests**

`server-ts/src/work/batch.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { cleanupWorld, seedWorld, type World } from './fixture.ts';
import { assigneeFrequency, batchUpdateSchema, childCreateSchema, defaultBoardId, sortOrderBetween } from './batch.ts';

test('a sort order lands between its neighbours, or after the last', () => {
   assert.equal(sortOrderBetween(1000, 3000), 2000);
   assert.equal(sortOrderBetween(1000, 1001), 2000);
   assert.equal(sortOrderBetween(undefined, 500), 0);
   assert.equal(sortOrderBetween(4000, undefined), 5000);
   assert.equal(sortOrderBetween(), 1000);
});

test('a batch patch needs a field, and not status and statusId together', () => {
   const id = '11111111-1111-4111-8111-111111111111';
   assert.equal(batchUpdateSchema.safeParse({ issueIds: [id], patch: {} }).success, false);
   assert.equal(batchUpdateSchema.safeParse({ issueIds: [id], patch: { status: 'todo', statusId: id } }).success, false);
   assert.equal(batchUpdateSchema.safeParse({ issueIds: [id], patch: { priority: 'high' } }).success, true);
   assert.equal(childCreateSchema.safeParse({}).success, false);
});

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('batch helpers', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'batch');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await closeDatabase(sql);
   });

   test('the default board is the workspace\'s oldest', async () => {
      assert.equal(await defaultBoardId(sql, world.workspaceId), world.boardId);
   });

   test('assignee frequency counts what this person assigned, most first', async () => {
      await sql`
         INSERT INTO assignments (issue_id, assignee_type, assignee_id, assigned_by)
         VALUES (${world.issueId}, 'agent', ${world.agentId}, ${world.ownerId}),
                (${world.issueId}, 'agent', ${world.agentId}, ${world.ownerId}),
                (${world.issueId}, 'user', ${world.memberId}, ${world.ownerId})`;
      assert.deepEqual(await assigneeFrequency(sql, world.workspaceId, world.ownerId), [
         { type: 'agent', id: world.agentId, count: 2 },
         { type: 'user', id: world.memberId, count: 1 },
      ]);
      assert.deepEqual(await assigneeFrequency(sql, world.workspaceId, world.memberId), []);
   });
});
```

`server-ts/src/work/join-links.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { cleanupWorld, seedWorld, type World } from './fixture.ts';
import {
   JoinLinkInvalid,
   acceptJoinLink,
   createJoinLink,
   joinLinkCreateSchema,
   listJoinLinks,
   lookupJoinLink,
   revokeJoinLink,
} from './join-links.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('join links', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let joinerId = '';
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'join');
      const [joiner] = await sql`
         INSERT INTO users (id, email, name) VALUES (${randomUUID()}, ${`joiner-${randomUUID().slice(0, 8)}@berry.test`}, 'Joiner')
         RETURNING id`;
      joinerId = joiner?.id as string;
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await sql`DELETE FROM users WHERE id = ${joinerId}`;
      await closeDatabase(sql);
   });

   test('a link joins once per person, counts its use, and stops at its limit', async () => {
      const { link, token } = await createJoinLink(sql, world.workspaceId, world.ownerId, joinLinkCreateSchema.parse({ role: 'viewer', maxUses: 1 }));
      assert.match(token, /^berry_join_[A-Za-z0-9_-]{43}$/);
      assert.deepEqual((await lookupJoinLink(sql, token))?.role, 'viewer');
      assert.deepEqual(await acceptJoinLink(sql, token, joinerId), { workspaceId: world.workspaceId, role: 'viewer', joined: true });
      assert.deepEqual(await acceptJoinLink(sql, token, joinerId), { workspaceId: world.workspaceId, role: 'viewer', joined: false });
      const listed = await listJoinLinks(sql, world.workspaceId);
      assert.equal(listed.find((entry) => entry.id === link.id)?.useCount, 1);
      assert.equal(await lookupJoinLink(sql, token), null);
      await assert.rejects(acceptJoinLink(sql, token, world.memberId), JoinLinkInvalid);
   });

   test('a revoked link and an unknown token are both invalid', async () => {
      const { link, token } = await createJoinLink(sql, world.workspaceId, world.ownerId, joinLinkCreateSchema.parse({}));
      assert.equal(await revokeJoinLink(sql, world.workspaceId, link.id), true);
      assert.equal(await lookupJoinLink(sql, token), null);
      await assert.rejects(acceptJoinLink(sql, `berry_join_${'a'.repeat(43)}`, joinerId), JoinLinkInvalid);
   });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd server-ts && node --test --experimental-strip-types src/work/batch.test.ts src/work/join-links.test.ts`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `batch.ts`**

```ts
import { z } from 'zod';
import type { Queryable } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';

/** Request shapes and small queries for the batch, move and create routes. */
const API_STATUSES = ['backlog', 'todo', 'inProgress', 'inReview', 'done', 'blocked', 'cancelled'] as const;
const PRIORITIES = ['none', 'urgent', 'high', 'medium', 'low'] as const;
const assignee = z.object({ type: z.enum(['user', 'agent']), id: z.uuid() }).strict();
const issueIds = z.array(z.uuid()).min(1).max(100);

export const batchUpdateSchema = z
   .object({
      issueIds,
      patch: z
         .object({
            status: z.enum(API_STATUSES).optional(),
            statusId: z.uuid().optional(),
            priority: z.enum(PRIORITIES).optional(),
            assignee: assignee.nullable().optional(),
         })
         .strict()
         .refine((patch) => Object.keys(patch).length > 0, { message: 'At least one field must be provided.' })
         .refine((patch) => !(patch.status && patch.statusId), { message: 'Send status or statusId, not both.' }),
   })
   .strict();
export type BatchUpdate = z.infer<typeof batchUpdateSchema>;

export const batchDeleteSchema = z.object({ issueIds }).strict();

export const moveSchema = z
   .object({ beforeId: z.uuid().nullable().optional(), afterId: z.uuid().nullable().optional() })
   .strict();

export const quickCreateSchema = z
   .object({
      workspaceId: z.uuid(),
      title: z.string().trim().min(1).max(500),
      boardId: z.uuid().optional(),
      parentId: z.uuid().optional(),
      stage: z.number().int().min(0).max(1000).optional(),
   })
   .strict();

export const childCreateSchema = z
   .object({
      title: z.string().trim().min(1).max(500).optional(),
      fromCommentId: z.uuid().optional(),
      stage: z.number().int().min(0).max(1000).nullable().optional(),
   })
   .strict()
   .refine((value) => value.title !== undefined || value.fromCommentId !== undefined, {
      message: 'Provide a title or a comment to create from.',
   });

export const parentSchema = z
   .object({ parentId: z.uuid().nullable(), stage: z.number().int().min(0).max(1000).nullable().optional() })
   .strict();

export const statusChangeSchema = z.object({ statusId: z.uuid() }).strict();

export const subscriptionSchema = z.object({ subtree: z.boolean().default(false) }).strict();

const GAP = 1000;

/** Same arithmetic as the board's drag and drop (`frontend/lib/issues.ts`). */
export function sortOrderBetween(before?: number, after?: number): number {
   if (before === undefined && after === undefined) return GAP;
   if (before === undefined) return Math.max(0, (after ?? 0) - GAP);
   if (after === undefined) return before + GAP;
   const middle = Math.floor((before + after) / 2);
   if (middle <= before || middle >= after) return before + GAP;
   return middle;
}

export async function sortOrderOf(q: Queryable, issueId: string): Promise<number> {
   const [row] = await q`SELECT sort_order FROM issues WHERE id = ${issueId} AND deleted_at IS NULL`;
   if (!row) throw new NotFound();
   return Number(row.sort_order);
}

export async function defaultBoardId(q: Queryable, workspaceId: string): Promise<string> {
   const [row] = await q`
      SELECT id FROM boards WHERE workspace_id = ${workspaceId}
       ORDER BY created_at ASC, id ASC LIMIT 1`;
   if (!row) throw new NotFound();
   return row.id as string;
}

/** Who this person assigns work to most, over the last 90 days. */
export async function assigneeFrequency(
   q: Queryable,
   workspaceId: string,
   userId: string
): Promise<Array<{ type: string; id: string; count: number }>> {
   const rows = await q`
      SELECT assignment.assignee_type::text AS type, assignment.assignee_id AS id, count(*)::int AS count
        FROM assignments AS assignment
        JOIN issues AS issue ON issue.id = assignment.issue_id
        JOIN boards AS board ON board.id = issue.board_id
       WHERE board.workspace_id = ${workspaceId} AND assignment.assigned_by = ${userId}
         AND assignment.created_at > now() - interval '90 days'
       GROUP BY 1, 2
       ORDER BY count DESC, type ASC, id ASC
       LIMIT 10`;
   return rows.map((row) => ({ type: row.type as string, id: row.id as string, count: Number(row.count) }));
}
```

- [ ] **Step 4: Implement `join-links.ts`**

```ts
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { toRFC3339, type Queryable, type Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';

/**
 * Shareable links that add whoever opens them to a workspace, at a fixed role.
 * The token is shown once; only its SHA-256 is stored, as for invitations.
 */
export const JOIN_TOKEN_PREFIX = 'berry_join_';

export const joinLinkCreateSchema = z
   .object({
      role: z.enum(['admin', 'member', 'viewer']).default('member'),
      expiresInDays: z.number().int().min(1).max(365).optional(),
      maxUses: z.number().int().min(1).max(10000).optional(),
   })
   .strict();
export type JoinLinkCreate = z.infer<typeof joinLinkCreateSchema>;

export interface JoinLink {
   id: string;
   workspaceId: string;
   role: string;
   expiresAt: string | null;
   maxUses: number | null;
   useCount: number;
   revokedAt: string | null;
   createdAt: string;
   createdBy: string;
}

export class JoinLinkInvalid extends Error {
   constructor() {
      super('join link is invalid, expired, revoked or used up');
      this.name = 'JoinLinkInvalid';
   }
}

const COLUMNS =
   'id, workspace_id, role::text AS role, expires_at, max_uses, use_count, revoked_at, created_at, created_by';

function toLink(row: Record<string, unknown>): JoinLink {
   return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      role: row.role as string,
      expiresAt: toRFC3339((row.expires_at as string | null) ?? null),
      maxUses: row.max_uses === null ? null : Number(row.max_uses),
      useCount: Number(row.use_count),
      revokedAt: toRFC3339((row.revoked_at as string | null) ?? null),
      createdAt: toRFC3339(row.created_at as string) ?? '',
      createdBy: row.created_by as string,
   };
}

function hashToken(token: string): Buffer {
   return createHash('sha256').update(token).digest();
}

export async function createJoinLink(
   q: Queryable,
   workspaceId: string,
   actorId: string,
   input: JoinLinkCreate
): Promise<{ link: JoinLink; token: string }> {
   const token = `${JOIN_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
   const [row] = await q`
      INSERT INTO workspace_join_links (workspace_id, role, token_hash, created_by, expires_at, max_uses)
      VALUES (${workspaceId}, ${input.role}::workspace_role, ${hashToken(token)}, ${actorId},
              CASE WHEN ${input.expiresInDays ?? null}::integer IS NULL THEN NULL
                   ELSE now() + make_interval(days => ${input.expiresInDays ?? 0}) END,
              ${input.maxUses ?? null})
      RETURNING ${q.unsafe(COLUMNS)}`;
   if (!row) throw new NotFound();
   return { link: toLink(row), token };
}

export async function listJoinLinks(q: Queryable, workspaceId: string): Promise<JoinLink[]> {
   const rows = await q`
      SELECT ${q.unsafe(COLUMNS)} FROM workspace_join_links
       WHERE workspace_id = ${workspaceId}
       ORDER BY created_at DESC, id DESC LIMIT 200`;
   return rows.map(toLink);
}

export async function revokeJoinLink(q: Queryable, workspaceId: string, linkId: string): Promise<boolean> {
   const rows = await q`
      UPDATE workspace_join_links SET revoked_at = now()
       WHERE id = ${linkId} AND workspace_id = ${workspaceId} AND revoked_at IS NULL
      RETURNING id`;
   return rows.length === 1;
}

const USABLE = `link.revoked_at IS NULL
   AND (link.expires_at IS NULL OR link.expires_at > now())
   AND (link.max_uses IS NULL OR link.use_count < link.max_uses)`;

/** What the public join page shows. Null for any unusable token, alike. */
export async function lookupJoinLink(
   q: Queryable,
   token: string
): Promise<{ workspaceId: string; workspaceName: string; role: string; expiresAt: string | null } | null> {
   if (!token.startsWith(JOIN_TOKEN_PREFIX) || token.length > 128) return null;
   const [row] = await q`
      SELECT link.workspace_id, workspace.name, link.role::text AS role, link.expires_at
        FROM workspace_join_links AS link
        JOIN workspaces AS workspace ON workspace.id = link.workspace_id AND workspace.deleted_at IS NULL
       WHERE link.token_hash = ${hashToken(token)} AND ${q.unsafe(USABLE)}`;
   if (!row) return null;
   return {
      workspaceId: row.workspace_id as string,
      workspaceName: row.name as string,
      role: row.role as string,
      expiresAt: toRFC3339((row.expires_at as string | null) ?? null),
   };
}

/**
 * Joins the caller. An existing member is answered with `joined: false` and the
 * link's use is not counted, so opening a link twice is harmless.
 */
export async function acceptJoinLink(
   sql: Sql,
   token: string,
   userId: string
): Promise<{ workspaceId: string; role: string; joined: boolean }> {
   if (!token.startsWith(JOIN_TOKEN_PREFIX) || token.length > 128) throw new JoinLinkInvalid();
   return sql.begin(async (tx) => {
      const [link] = await tx`
         SELECT link.id, link.workspace_id, link.role::text AS role,
                (${tx.unsafe(USABLE)}) AS usable
           FROM workspace_join_links AS link
           JOIN workspaces AS workspace ON workspace.id = link.workspace_id AND workspace.deleted_at IS NULL
          WHERE link.token_hash = ${hashToken(token)}
          FOR UPDATE OF link`;
      if (!link) throw new JoinLinkInvalid();
      const workspaceId = link.workspace_id as string;
      const [member] = await tx`
         SELECT role::text AS role FROM workspace_memberships
          WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`;
      if (member) return { workspaceId, role: member.role as string, joined: false };
      if (link.usable !== true) throw new JoinLinkInvalid();
      await tx`
         INSERT INTO workspace_memberships (workspace_id, user_id, role)
         VALUES (${workspaceId}, ${userId}, ${link.role as string}::workspace_role)`;
      await tx`UPDATE workspace_join_links SET use_count = use_count + 1 WHERE id = ${link.id as string}`;
      return { workspaceId, role: link.role as string, joined: true };
   });
}
```

- [ ] **Step 5: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types src/work/batch.test.ts src/work/join-links.test.ts && pnpm -w typecheck:server`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add server-ts/src/work/batch.ts server-ts/src/work/join-links.ts server-ts/src/work/batch.test.ts server-ts/src/work/join-links.test.ts
git commit -m "feat(server-ts): add batch and move helpers, assignee frequency, and join links"
```

---
### Task 12: After-write hooks and the issue-tracking routes

**Files:**
- Create: `server-ts/src/work/hooks.ts`, `server-ts/src/mounts/work-errors.ts`, `server-ts/src/mounts/issue-tracking.ts`
- Modify: `server-ts/src/mounts/issues.ts` (options `tracking`, `stages`, `hooks`; call them in POST `/` and PATCH `/:issueRef`)
- Test: `server-ts/src/mounts/issue-tracking.test.ts`

**Interfaces:**
- Consumes: every `work/*.ts` export from Tasks 3–11; `serializeIssue` (Task 2); `autoDispatch`, `StageGate` (Task 7).
- Produces (`hooks.ts`): `interface IssueWrite { kind: 'created' | 'updated'; issue: Issue; previousStatus: string | null; previousAssigneeId: string | null; actorId: string; workspaceId: string; eventIds: string[] }`, `interface CommentWrite { comment: Comment; workspaceId: string; eventId: string; actorId: string }`, `interface WorkTrackingHooks { afterIssueWrite(write: IssueWrite): Promise<void>; afterCommentCreate(write: CommentWrite): Promise<void> }`, `workTrackingHooks(options: { sql: Sql; issues: IssueRepository; dispatch?: Pick<RunRepository, 'admit'> }): WorkTrackingHooks`.
- Produces (`work-errors.ts`): `rethrowWork(resource: string): (error: unknown) => never`.
- Produces (`issue-tracking.ts`): `interface IssueTrackingOptions { sql: Sql; issues: IssueRepository; boards: BoardRepository; comments: CommentRepository; broadcaster?: Broadcaster; dispatch?: Pick<RunRepository, 'admit'>; enqueue?: QuickActionEnqueue; hooks?: WorkTrackingHooks }`, `issueTrackingRoutes(options): Hono<{ Variables: AuthVariables }>`.
- Produces (`IssueOptions` in `mounts/issues.ts`): `tracking?: Hono<{ Variables: AuthVariables }>`, `stages?: StageGate`, `hooks?: WorkTrackingHooks`.
- Wire contract (all under `/api/v1/issues`, session auth; response bodies camelCase):

| Method + path | Permission | Body | Response |
|---|---|---|---|
| `GET /assignee-frequency?workspaceId=` | member | none | `{ nodes: [{ type, id, count }] }` |
| `POST /quick` | `product.write` | `{ workspaceId, title, boardId?, parentId?, stage? }` | 201 issue |
| `POST /batch` | `product.write` per issue | `{ issueIds, patch: { status?, statusId?, priority?, assignee? } }` | `{ updated: string[], failed: [{ id, code }] }` |
| `POST /batch-delete` | `product.write` per issue | `{ issueIds }` | `{ deleted: string[], failed: [{ id, code }] }` |
| `GET /:ref/properties` | `product.read` | none | `{ nodes: [{ propertyId, value }] }` |
| `PUT /:ref/properties/:propertyId` | `product.write` | `{ value }` | `{ propertyId, value }` |
| `DELETE /:ref/properties/:propertyId` | `product.write` | none | 204 |
| `GET /:ref/metadata` | `product.read` | none | `{ metadata }` |
| `PATCH /:ref/metadata` | `product.write` | `{ set?, remove? }` | `{ metadata }` |
| `GET /:ref/reactions` | `product.read` | none | `{ nodes: ReactionGroup[] }` |
| `POST /:ref/reactions` | `comments.write` | `{ emoji }` | `{ nodes }` |
| `DELETE /:ref/reactions/:emoji` | `comments.write` | none | `{ nodes }` |
| `GET /:ref/subscribers` | `product.read` | none | `{ nodes: Subscriber[], subscribed }` |
| `PUT /:ref/subscription` | `product.read` | `{ subtree? }` | `{ subscribed: true, count }` |
| `DELETE /:ref/subscription?subtree=true` | `product.read` | none | `{ subscribed: false, count }` |
| `GET /:ref/children` | `product.read` | none | `{ nodes: Issue[], progress: { total, done } }` |
| `POST /:ref/children` | `product.write` | `{ title?, fromCommentId?, stage? }` | 201 issue |
| `PUT /:ref/parent` | `product.write` | `{ parentId, stage? }` | issue |
| `PUT /:ref/status` | `product.write` | `{ statusId }` | issue |
| `POST /:ref/move` | `product.write` | `{ beforeId?, afterId? }` | issue |
| `GET /:ref/activity?first=&after=` | `product.read` | none | `{ nodes: ActivityEntry[], pageInfo }` |
| `POST /:ref/quick-actions/:actionId/run` | `runs.dispatch` | none | 202 `{ runId }`, or 503 `QUICK_ACTIONS_UNAVAILABLE` |

- [ ] **Step 1: Write the failing mount test**

`server-ts/src/mounts/issue-tracking.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { SessionService } from '../auth/sessions.ts';
import { BoardRepository } from '../core/boards.ts';
import { CommentRepository } from '../core/comments.ts';
import { IssueRepository } from '../core/issues.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { IdempotencyStore } from '../http/idempotency.ts';
import { Registry } from '../http/registry.ts';
import { cleanupWorld, createIssue, seedWorld, type World } from '../work/fixture.ts';
import { createProperty, propertyCreateSchema } from '../work/properties.ts';
import { createQuickAction, quickActionCreateSchema, type QuickActionEnqueue } from '../work/quick-actions.ts';
import { workTrackingHooks } from '../work/hooks.ts';
import { stageGate } from '../work/hierarchy.ts';
import { issueMounts } from './issues.ts';
import { issueTrackingRoutes } from './issue-tracking.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('issue-tracking routes', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let world: World;
   let other: World;
   const tokens: Record<string, string> = {};
   const admitted: string[] = [];
   const enqueued: string[] = [];

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'track');
      other = await seedWorld(sql, 'track-other');
      const sessions = new SessionService({ sql, sessionTtlMs: 3_600_000 });
      const issues = new IssueRepository(sql);
      const boards = new BoardRepository(sql);
      const comments = new CommentRepository(sql);
      const dispatch = {
         admit: async (input: { issueId: string }) => {
            admitted.push(input.issueId);
            return {} as never;
         },
      };
      const enqueue: QuickActionEnqueue = async (_sql, input) => {
         enqueued.push(input.prompt ?? '');
         return { runId: 'run-quick' };
      };
      const hooks = workTrackingHooks({ sql, issues, dispatch });
      const registry = new Registry();
      registry.registerAll(
         issueMounts({
            sessions,
            issues,
            boards,
            idempotency: new IdempotencyStore(sql),
            stages: stageGate(sql),
            hooks,
            tracking: issueTrackingRoutes({ sql, issues, boards, comments, dispatch, enqueue, hooks }),
         })
      );
      app = createApp(registry);
      tokens.owner = (await sessions.issueForUser(world.ownerId)).token;
      tokens.viewer = (await sessions.issueForUser(world.viewerId)).token;
      tokens.outsider = (await sessions.issueForUser(other.ownerId)).token;
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await cleanupWorld(sql, other);
      await closeDatabase(sql);
   });

   async function call(method: string, path: string, who: string, body?: unknown) {
      const response = await app.request(path, {
         method,
         headers: { authorization: `Bearer ${tokens[who] ?? ''}`, 'content-type': 'application/json' },
         ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
   }

   test('a property value is set, read back, and refused when it does not fit', async () => {
      const effort = await createProperty(sql, world.workspaceId, world.ownerId, propertyCreateSchema.parse({ name: 'Effort', kind: 'number' }));
      const set = await call('PUT', `/api/v1/issues/${world.issueId}/properties/${effort.id}`, 'owner', { value: 3 });
      assert.equal(set.status, 200);
      const listed = await call('GET', `/api/v1/issues/${world.issueId}/properties`, 'owner');
      assert.deepEqual(listed.body?.nodes, [{ propertyId: effort.id, value: 3 }]);
      const bad = await call('PUT', `/api/v1/issues/${world.issueId}/properties/${effort.id}`, 'owner', { value: 'three' });
      assert.equal(bad.status, 422);
   });

   test('an outsider gets 404 and a viewer gets 403 on a write', async () => {
      assert.equal((await call('GET', `/api/v1/issues/${world.issueId}/properties`, 'outsider')).status, 404);
      assert.equal((await call('PATCH', `/api/v1/issues/${world.issueId}/metadata`, 'viewer', { set: { a: 1 } })).status, 403);
   });

   test('reactions and subscription round-trip', async () => {
      const reacted = await call('POST', `/api/v1/issues/${world.issueId}/reactions`, 'owner', { emoji: '🎉' });
      assert.deepEqual((reacted.body?.nodes as Array<{ emoji: string }>).map((node) => node.emoji), ['🎉']);
      const removed = await call('DELETE', `/api/v1/issues/${world.issueId}/reactions/${encodeURIComponent('🎉')}`, 'owner');
      assert.deepEqual(removed.body?.nodes, []);
      const subscribed = await call('PUT', `/api/v1/issues/${world.issueId}/subscription`, 'viewer', { subtree: false });
      assert.equal(subscribed.body?.subscribed, true);
      const listed = await call('GET', `/api/v1/issues/${world.issueId}/subscribers`, 'viewer');
      assert.equal(listed.body?.subscribed, true);
   });

   test('a sub-issue is created from a comment and counted on its parent', async () => {
      const [comment] = await sql`
         INSERT INTO comments (issue_id, author_type, author_id, body)
         VALUES (${world.issueId}, 'user', ${world.ownerId}, ${'Split out the parser\nDetails here'})
         RETURNING id`;
      const child = await call('POST', `/api/v1/issues/${world.issueId}/children`, 'owner', { fromCommentId: comment?.id });
      assert.equal(child.status, 201);
      assert.equal(child.body?.title, 'Split out the parser');
      assert.equal(child.body?.parentId, world.issueId);
      const children = await call('GET', `/api/v1/issues/${world.issueId}/children`, 'owner');
      assert.equal((children.body?.progress as { total: number }).total >= 1, true);
   });

   test('finishing stage one releases stage two to its agent', async () => {
      const parent = await createIssue(sql, world, { title: 'Staged parent' });
      const first = await createIssue(sql, world, { parentId: parent, stage: 1, status: 'in_review' });
      const second = await createIssue(sql, world, { parentId: parent, stage: 2, status: 'todo', agentAssignee: true });
      const done = await call('PATCH', `/api/v1/issues/${first}`, 'owner', { status: 'done' });
      assert.equal(done.status, 200);
      assert.ok(admitted.includes(second));
   });

   test('a batch reports what it could not change', async () => {
      const a = await createIssue(sql, world);
      const result = await call('POST', '/api/v1/issues/batch', 'owner', { issueIds: [a, other.issueId], patch: { priority: 'high' } });
      assert.deepEqual(result.body, { updated: [a], failed: [{ id: other.issueId, code: 'NOT_FOUND' }] });
   });

   test('a quick action queues an agent task with its rendered prompt', async () => {
      const action = await createQuickAction(sql, world.workspaceId, world.ownerId, quickActionCreateSchema.parse({ name: 'Explain', targetAgentId: world.agentId, prompt: 'Explain {{issue.title}}' }));
      const run = await call('POST', `/api/v1/issues/${world.issueId}/quick-actions/${action.id}/run`, 'owner');
      assert.equal(run.status, 202);
      assert.deepEqual(run.body, { runId: 'run-quick' });
      assert.ok(enqueued.includes('Explain Root task'));
   });

   test('the timeline lists the property change', async () => {
      const activity = await call('GET', `/api/v1/issues/${world.issueId}/activity`, 'owner');
      const types = (activity.body?.nodes as Array<{ type: string }>).map((node) => node.type);
      assert.ok(types.includes('issue.properties.changed'));
   });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd server-ts && node --test --experimental-strip-types src/mounts/issue-tracking.test.ts`
Expected: FAIL with `Cannot find module '.../mounts/issue-tracking.ts'`.

- [ ] **Step 3: Implement `work/hooks.ts`**

```ts
import type { Comment } from '../core/comments.ts';
import type { Issue, IssueRepository } from '../core/issues.ts';
import type { Sql } from '../db/pool.ts';
import { autoDispatch } from '../runs/auto-dispatch.ts';
import type { RunRepository } from '../runs/repository.ts';
import { nextStageReady, stageGate } from './hierarchy.ts';
import { parseMentions } from './mentions.ts';
import { notifySubscribers, subscribe, type InboxCategory } from './subscribers.ts';

/**
 * What follows a committed issue or comment write: automatic subscriptions
 * (creator, assignee, commenter, mentioned), inbox rows for subscribers, and
 * releasing the next stage of sub-issues. Called after commit, best effort,
 * like the realtime publish: the write already happened.
 */
export interface IssueWrite {
   kind: 'created' | 'updated';
   issue: Issue;
   previousStatus: string | null;
   previousAssigneeId: string | null;
   actorId: string;
   workspaceId: string;
   eventIds: string[];
}

export interface CommentWrite {
   comment: Comment;
   workspaceId: string;
   eventId: string;
   actorId: string;
}

export interface WorkTrackingHooks {
   afterIssueWrite(write: IssueWrite): Promise<void>;
   afterCommentCreate(write: CommentWrite): Promise<void>;
}

const FINISHED = new Set(['done', 'cancelled']);

function preview(text: string): string {
   const flat = text.replace(/\s+/g, ' ').trim();
   return flat.length > 280 ? `${flat.slice(0, 277)}...` : flat;
}

export function workTrackingHooks(options: {
   sql: Sql;
   issues: IssueRepository;
   dispatch?: Pick<RunRepository, 'admit'> | undefined;
}): WorkTrackingHooks {
   const { sql, issues } = options;
   const gate = stageGate(sql);

   return {
      async afterIssueWrite(write) {
         const { issue, workspaceId } = write;
         if (write.kind === 'created') {
            await subscribe(sql, { workspaceId, issueIds: [issue.id], userIds: [write.actorId], reason: 'creator' });
         }
         if (issue.assignee?.type === 'user') {
            await subscribe(sql, { workspaceId, issueIds: [issue.id], userIds: [issue.assignee.id], reason: 'assignee' });
         }
         const mentioned = write.kind === 'created' ? parseMentions(issue.description ?? '').users : [];
         if (mentioned.length > 0) {
            await subscribe(sql, { workspaceId, issueIds: [issue.id], userIds: mentioned, reason: 'mentioned' });
         }

         const eventId = write.eventIds[0];
         if (eventId && (write.kind === 'updated' || mentioned.length > 0)) {
            const statusChanged = write.previousStatus !== null && write.previousStatus !== issue.status;
            const assigned =
               issue.assignee?.type === 'user' && issue.assignee.id !== write.previousAssigneeId;
            const category: InboxCategory = assigned ? 'assignments' : statusChanged ? 'statusChanges' : 'updates';
            const body = assigned
               ? `Assigned to ${issue.assignee?.name ?? 'someone'}`
               : statusChanged
                 ? `Status changed from ${write.previousStatus ?? ''} to ${issue.status}`
                 : write.kind === 'created'
                   ? 'You were mentioned in a new task'
                   : 'Details changed';
            await notifySubscribers(sql, {
               workspaceId,
               issueId: issue.id,
               sourceEventId: eventId,
               eventType: write.kind === 'created' ? 'issue.created' : 'issue.updated',
               category,
               actor: { type: 'user', id: write.actorId },
               title: `${issue.identifier} ${issue.title}`,
               body,
               mentionedUserIds: mentioned,
            });
         }

         const finishing =
            write.previousStatus !== null && !FINISHED.has(write.previousStatus) && FINISHED.has(issue.status);
         if (options.dispatch && finishing) {
            for (const siblingId of await nextStageReady(sql, issue.id)) {
               const sibling = await issues.get(siblingId);
               await autoDispatch(options.dispatch, sibling, { workspaceId, requestedBy: write.actorId }, gate);
            }
         }
      },

      async afterCommentCreate(write) {
         const { comment, workspaceId } = write;
         const mentions = parseMentions(comment.body);
         if (comment.author.type === 'user') {
            await subscribe(sql, { workspaceId, issueIds: [comment.issueId], userIds: [comment.author.id], reason: 'commenter' });
         }
         if (mentions.users.length > 0) {
            await subscribe(sql, { workspaceId, issueIds: [comment.issueId], userIds: mentions.users, reason: 'mentioned' });
         }
         const issue = await issues.get(comment.issueId);
         await notifySubscribers(sql, {
            workspaceId,
            issueId: comment.issueId,
            sourceEventId: write.eventId,
            eventType: 'comment.created',
            category: 'comments',
            actor: { type: comment.author.type === 'agent' ? 'agent' : 'user', id: comment.author.id },
            title: `${issue.identifier} ${issue.title}`,
            body: preview(comment.body),
            mentionedUserIds: mentions.users,
         });
      },
   };
}
```

- [ ] **Step 4: Implement `mounts/work-errors.ts`**

```ts
import { ApiError } from '../http/errors.ts';
import { Conflict, Forbidden, NotFound } from '../identity/errors.ts';
import { InvalidTransition } from '../core/issues.ts';
import { InvalidPropertyValue, PropertyKindMismatch, PropertyNameTaken } from '../work/properties.ts';
import { MetadataTooLarge } from '../work/metadata.ts';
import { HierarchyCycle, ParentNotFound } from '../work/hierarchy.ts';
import { NotAThreadRoot } from '../work/comment-resolution.ts';
import { StatusNameTaken, StatusOrderMismatch, SystemStatusProtected } from '../work/statuses.ts';
import { ViewRevisionConflict } from '../work/views.ts';
import { QuickActionNameTaken } from '../work/quick-actions.ts';
import { JoinLinkInvalid } from '../work/join-links.ts';

/** Work-tracking domain failures in the API's words, mapped once. */
export function rethrowWork(resource: string): (error: unknown) => never {
   return (error: unknown) => {
      if (error instanceof ApiError) throw error;
      if (error instanceof InvalidPropertyValue) {
         throw new ApiError(422, 'VALIDATION_FAILED', 'The request is invalid.', {
            fields: error.issues.map((issue) => ({ path: issue.path, code: 'invalid_value', message: issue.message })),
         });
      }
      if (error instanceof PropertyKindMismatch) {
         throw new ApiError(422, 'VALIDATION_FAILED', 'The request is invalid.', {
            fields: [{ path: '/options', code: 'invalid_value', message: 'Only a select has options.' }],
         });
      }
      if (error instanceof MetadataTooLarge) {
         throw new ApiError(422, 'METADATA_TOO_LARGE', 'Metadata holds at most 50 keys and 16 KB.');
      }
      if (
         error instanceof PropertyNameTaken ||
         error instanceof StatusNameTaken ||
         error instanceof QuickActionNameTaken
      ) {
         throw new ApiError(409, 'CONFLICT', 'That name is already taken.');
      }
      if (error instanceof HierarchyCycle) {
         throw new ApiError(409, 'HIERARCHY_CYCLE', 'An issue cannot be nested under its own sub-issue.');
      }
      if (error instanceof ParentNotFound) {
         throw new ApiError(422, 'PARENT_NOT_FOUND', 'That parent issue does not exist in this workspace.');
      }
      if (error instanceof NotAThreadRoot) {
         throw new ApiError(422, 'NOT_A_THREAD_ROOT', 'Only the first comment of a thread can be resolved.');
      }
      if (error instanceof SystemStatusProtected) {
         throw new ApiError(409, 'STATUS_PROTECTED', 'A built-in status cannot be archived.');
      }
      if (error instanceof StatusOrderMismatch) {
         throw new ApiError(422, 'STATUS_ORDER_MISMATCH', 'The order must list every active status once.');
      }
      if (error instanceof ViewRevisionConflict) {
         throw new ApiError(409, 'REVISION_CONFLICT', 'The view changed since it was last read.', {
            currentRevision: error.currentRevision,
         });
      }
      if (error instanceof JoinLinkInvalid) {
         throw new ApiError(404, 'NOT_FOUND', 'This join link is not valid.');
      }
      if (error instanceof InvalidTransition) {
         throw new ApiError(409, 'INVALID_STATE_TRANSITION', `Cannot transition an issue from "${error.from}" to "${error.to}".`, {
            from: error.from,
            to: error.to,
         });
      }
      if (error instanceof Conflict) throw new ApiError(409, 'CONFLICT', 'The change conflicts with the current state.');
      if (error instanceof NotFound) throw ApiError.notFound(resource);
      if (error instanceof Forbidden) {
         throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
      }
      throw error;
   };
}
```

- [ ] **Step 5: Implement `mounts/issue-tracking.ts`**

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthVariables } from '../auth/middleware.ts';
import type { BoardRepository } from '../core/boards.ts';
import type { CommentRepository } from '../core/comments.ts';
import { apiStatusToDb, type Issue, type IssuePatch, type IssueRepository } from '../core/issues.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { decodeTimeCursor, encodeCursor, parsePageQuery } from '../http/cursor.ts';
import { ApiError } from '../http/errors.ts';
import type { Permission } from '../identity/roles.ts';
import type { Broadcaster } from '../realtime/hub.ts';
import { autoDispatch } from '../runs/auto-dispatch.ts';
import type { RunRepository } from '../runs/repository.ts';
import { listIssueActivity } from '../work/activity.ts';
import {
   assigneeFrequency,
   batchDeleteSchema,
   batchUpdateSchema,
   childCreateSchema,
   defaultBoardId,
   moveSchema,
   parentSchema,
   quickCreateSchema,
   sortOrderBetween,
   sortOrderOf,
   statusChangeSchema,
   subscriptionSchema,
} from '../work/batch.ts';
import { childIssueIds, setParent, stageGate } from '../work/hierarchy.ts';
import type { WorkTrackingHooks } from '../work/hooks.ts';
import { failureCode, parseJsonBody } from '../work/http.ts';
import { metadataPatchSchema, patchMetadata, readMetadata } from '../work/metadata.ts';
import { publishEvents, recordIssueEvent, type WorkEvent } from '../work/outbox.ts';
import { clearValue, listValues, setValue } from '../work/properties.ts';
import { runQuickAction, type QuickActionEnqueue } from '../work/quick-actions.ts';
import { addReaction, emojiSchema, listReactions, removeReaction } from '../work/reactions.ts';
import { resolveStatus } from '../work/statuses.ts';
import { isSubscribed, listSubscribers, subscribe, subtreeIssueIds, unsubscribe } from '../work/subscribers.ts';
import { serializeIssue } from './issues.ts';
import { pathId, resolveScoped } from './shared.ts';
import { rethrowWork } from './work-errors.ts';

/**
 * Work-tracking routes that hang under `/api/v1/issues`. Mounted by the issues
 * mount (the registry refuses a second mount on that prefix), before its own
 * `/:issueRef` routes, so `/assignee-frequency` is not read as an issue ref.
 */
export interface IssueTrackingOptions {
   sql: Sql;
   issues: IssueRepository;
   boards: BoardRepository;
   comments: CommentRepository;
   broadcaster?: Broadcaster | undefined;
   dispatch?: Pick<RunRepository, 'admit'> | undefined;
   enqueue?: QuickActionEnqueue | undefined;
   hooks?: WorkTrackingHooks | undefined;
}

const valueBody = z.object({ value: z.unknown() }).strict();
const emojiBody = z.object({ emoji: emojiSchema }).strict();
const NO_CHANGE: IssuePatch = { descriptionSet: false, dueDateSet: false, assigneeSet: false, projectSet: false };

export function issueTrackingRoutes(options: IssueTrackingOptions): Hono<{ Variables: AuthVariables }> {
   const { sql, issues } = options;
   const gate = stageGate(sql);
   const route = new Hono<{ Variables: AuthVariables }>();
   const asIssue = rethrowWork('Issue');

   const resolve = async (issueRef: string | undefined, userId: string, permission: Permission) => {
      const issue = await issues.get(issueRef ?? '').catch(asIssue);
      const scope = await issues.authorize(userId, issue.id, permission).catch(asIssue);
      return { issue, workspaceId: scope.workspaceId };
   };
   const serve = async (issue: Issue, status = 200) => {
      const relations = await issues.loadRelations([issue.id]);
      return json(serializeIssue(issue, relations.get(issue.id)), status);
   };
   const dispatchIfReady = async (issue: Issue, workspaceId: string, userId: string): Promise<Issue> => {
      if (!options.dispatch) return issue;
      const run = await autoDispatch(options.dispatch, issue, { workspaceId, requestedBy: userId }, gate);
      return run ? issues.get(issue.id) : issue;
   };
   const afterWrite = async (write: Parameters<WorkTrackingHooks['afterIssueWrite']>[0]) => {
      await options.hooks?.afterIssueWrite(write).catch(() => undefined);
   };
   const record = async (issueId: string, userId: string, type: string, payload: Record<string, unknown>) => {
      const event: WorkEvent = await recordIssueEvent(sql, { issueId, type, actor: { type: 'user', id: userId }, payload });
      await publishEvents(options.broadcaster, [event]);
   };
   /** Applies a patch the way PATCH /issues/:ref does, plus hooks and dispatch. */
   const applyPatch = async (issue: Issue, workspaceId: string, userId: string, patch: IssuePatch): Promise<Issue> => {
      const result = await issues.update({ issueId: issue.id, patch, actorId: userId });
      await publishEvents(options.broadcaster, result.events);
      await afterWrite({
         kind: 'updated',
         issue: result.issue,
         previousStatus: issue.status,
         previousAssigneeId: issue.assignee?.id ?? null,
         actorId: userId,
         workspaceId,
         eventIds: result.events.map((event) => event.id),
      });
      return dispatchIfReady(result.issue, workspaceId, userId);
   };
   /** Creates an issue on a board, optionally under a parent, then dispatches it. */
   const createOn = async (input: {
      boardId: string;
      workspaceId: string;
      userId: string;
      title: string;
      description: string | null;
      parentId: string | null;
      stage: number | null;
   }): Promise<Issue> => {
      const created = await issues
         .create({
            boardId: input.boardId,
            title: input.title,
            description: input.description,
            status: 'backlog',
            priority: 'none',
            sortOrder: 0,
            dueDate: null,
            assignee: null,
            project: null,
            createdBy: input.userId,
         })
         .catch(rethrowWork('Board'));
      await publishEvents(options.broadcaster, created.events);
      if (input.parentId) {
         await setParent(sql, { workspaceId: input.workspaceId, issueId: created.issue.id, parentId: input.parentId, stage: input.stage }).catch(asIssue);
      }
      const issue = await issues.get(created.issue.id);
      await afterWrite({
         kind: 'created',
         issue,
         previousStatus: null,
         previousAssigneeId: null,
         actorId: input.userId,
         workspaceId: input.workspaceId,
         eventIds: created.events.map((event) => event.id),
      });
      return issue;
   };

   // ------------------------------------------------------------ collection
   route.get('/assignee-frequency', async (context) => {
      const userId = context.get('user').id;
      const db = await resolveScoped(sql, userId, new URL(context.req.url).searchParams.get('workspaceId') ?? '');
      return json({ nodes: await assigneeFrequency(sql, db.ctx.workspaceId, userId) });
   });

   route.post('/quick', async (context) => {
      const userId = context.get('user').id;
      const input = await parseJsonBody(context.req.raw, quickCreateSchema);
      const db = await resolveScoped(sql, userId, input.workspaceId, 'product.write');
      const boardId = input.boardId ?? (await defaultBoardId(sql, db.ctx.workspaceId).catch(rethrowWork('Board')));
      const scope = await options.boards.authorize(userId, boardId, 'product.write').catch(rethrowWork('Board'));
      if (scope.workspaceId !== db.ctx.workspaceId) throw ApiError.notFound('Board');
      const issue = await createOn({
         boardId,
         workspaceId: db.ctx.workspaceId,
         userId,
         title: input.title,
         description: null,
         parentId: input.parentId ?? null,
         stage: input.stage ?? null,
      });
      return serve(issue, 201);
   });

   route.post('/batch', async (context) => {
      const userId = context.get('user').id;
      const input = await parseJsonBody(context.req.raw, batchUpdateSchema);
      const updated: string[] = [];
      const failed: Array<{ id: string; code: string }> = [];
      for (const issueId of input.issueIds) {
         try {
            const { issue, workspaceId } = await resolve(issueId, userId, 'product.write');
            const patch: IssuePatch = { ...NO_CHANGE };
            if (input.patch.priority) patch.priority = input.patch.priority;
            if (input.patch.status) patch.status = apiStatusToDb(input.patch.status);
            if (input.patch.statusId) {
               const status = await resolveStatus(sql, workspaceId, input.patch.statusId);
               patch.status = status.category;
               patch.statusId = status.id;
            }
            if (input.patch.assignee !== undefined) {
               patch.assigneeSet = true;
               patch.assignee = input.patch.assignee;
               if (
                  input.patch.assignee &&
                  !(await issues.assigneeExistsInWorkspace(workspaceId, input.patch.assignee.type, input.patch.assignee.id))
               ) {
                  throw ApiError.notFound('Assignee');
               }
            }
            await applyPatch(issue, workspaceId, userId, patch);
            updated.push(issue.id);
         } catch (error) {
            failed.push({ id: issueId, code: failureCode(error) });
         }
      }
      return json({ updated, failed });
   });

   route.post('/batch-delete', async (context) => {
      const userId = context.get('user').id;
      const input = await parseJsonBody(context.req.raw, batchDeleteSchema);
      const deleted: string[] = [];
      const failed: Array<{ id: string; code: string }> = [];
      for (const issueId of input.issueIds) {
         try {
            const { issue } = await resolve(issueId, userId, 'product.write');
            const removed = await issues.remove({ issueId: issue.id, deletedBy: userId });
            await publishEvents(options.broadcaster, removed.events);
            deleted.push(issue.id);
         } catch (error) {
            failed.push({ id: issueId, code: failureCode(error) });
         }
      }
      return json({ deleted, failed });
   });

   // ------------------------------------------------------------ properties
   route.get('/:issueRef/properties', async (context) => {
      const { issue, workspaceId } = await resolve(context.req.param('issueRef'), context.get('user').id, 'product.read');
      return json({ nodes: await listValues(sql, workspaceId, issue.id) });
   });

   route.put('/:issueRef/properties/:propertyId', async (context) => {
      const userId = context.get('user').id;
      const { issue, workspaceId } = await resolve(context.req.param('issueRef'), userId, 'product.write');
      const propertyId = pathId(context.req.param('propertyId'), 'Property');
      const body = await parseJsonBody(context.req.raw, valueBody);
      const written = await setValue(sql, { workspaceId, issueId: issue.id, propertyId, value: body.value, actorId: userId }).catch(rethrowWork('Property'));
      await record(issue.id, userId, 'issue.properties.changed', { propertyId, value: written.value });
      return json(written);
   });

   route.delete('/:issueRef/properties/:propertyId', async (context) => {
      const userId = context.get('user').id;
      const { issue, workspaceId } = await resolve(context.req.param('issueRef'), userId, 'product.write');
      const propertyId = pathId(context.req.param('propertyId'), 'Property');
      if (await clearValue(sql, workspaceId, issue.id, propertyId)) {
         await record(issue.id, userId, 'issue.properties.changed', { propertyId, value: null });
      }
      return new Response(null, { status: 204 });
   });

   // -------------------------------------------------------------- metadata
   route.get('/:issueRef/metadata', async (context) => {
      const { issue } = await resolve(context.req.param('issueRef'), context.get('user').id, 'product.read');
      return json({ metadata: await readMetadata(sql, issue.id) });
   });

   route.patch('/:issueRef/metadata', async (context) => {
      const userId = context.get('user').id;
      const { issue } = await resolve(context.req.param('issueRef'), userId, 'product.write');
      const patch = await parseJsonBody(context.req.raw, metadataPatchSchema);
      const metadata = await sql.begin((tx) => patchMetadata(tx, issue.id, patch)).catch(asIssue);
      await record(issue.id, userId, 'issue.metadata.changed', { keys: [...Object.keys(patch.set ?? {}), ...(patch.remove ?? [])] });
      return json({ metadata });
   });

   // ------------------------------------------------------------- reactions
   route.get('/:issueRef/reactions', async (context) => {
      const userId = context.get('user').id;
      const { issue } = await resolve(context.req.param('issueRef'), userId, 'product.read');
      return json({ nodes: await listReactions(sql, 'issue', issue.id, userId) });
   });

   route.post('/:issueRef/reactions', async (context) => {
      const userId = context.get('user').id;
      const { issue } = await resolve(context.req.param('issueRef'), userId, 'comments.write');
      const { emoji } = await parseJsonBody(context.req.raw, emojiBody);
      if (await addReaction(sql, 'issue', issue.id, userId, emoji)) {
         await record(issue.id, userId, 'issue.reactions.changed', { emoji, added: true });
      }
      return json({ nodes: await listReactions(sql, 'issue', issue.id, userId) });
   });

   route.delete('/:issueRef/reactions/:emoji', async (context) => {
      const userId = context.get('user').id;
      const { issue } = await resolve(context.req.param('issueRef'), userId, 'comments.write');
      const emoji = emojiSchema.safeParse(context.req.param('emoji') ?? '');
      if (!emoji.success) throw ApiError.notFound('Reaction');
      if (await removeReaction(sql, 'issue', issue.id, userId, emoji.data)) {
         await record(issue.id, userId, 'issue.reactions.changed', { emoji: emoji.data, added: false });
      }
      return json({ nodes: await listReactions(sql, 'issue', issue.id, userId) });
   });

   // ----------------------------------------------------------- subscribers
   route.get('/:issueRef/subscribers', async (context) => {
      const userId = context.get('user').id;
      const { issue } = await resolve(context.req.param('issueRef'), userId, 'product.read');
      return json({ nodes: await listSubscribers(sql, issue.id), subscribed: await isSubscribed(sql, issue.id, userId) });
   });

   route.put('/:issueRef/subscription', async (context) => {
      const userId = context.get('user').id;
      const { issue, workspaceId } = await resolve(context.req.param('issueRef'), userId, 'product.read');
      const { subtree } = await parseJsonBody(context.req.raw, subscriptionSchema);
      const issueIds = subtree ? await subtreeIssueIds(sql, issue.id) : [issue.id];
      const count = await subscribe(sql, { workspaceId, issueIds, userIds: [userId], reason: 'manual' });
      await record(issue.id, userId, 'issue.subscribers.changed', { userId, subscribed: true, subtree });
      return json({ subscribed: true, count });
   });

   route.delete('/:issueRef/subscription', async (context) => {
      const userId = context.get('user').id;
      const { issue } = await resolve(context.req.param('issueRef'), userId, 'product.read');
      const subtree = new URL(context.req.url).searchParams.get('subtree') === 'true';
      const issueIds = subtree ? await subtreeIssueIds(sql, issue.id) : [issue.id];
      const count = await unsubscribe(sql, { issueIds, userId });
      await record(issue.id, userId, 'issue.subscribers.changed', { userId, subscribed: false, subtree });
      return json({ subscribed: false, count });
   });

   // ------------------------------------------------------------- hierarchy
   route.get('/:issueRef/children', async (context) => {
      const { issue } = await resolve(context.req.param('issueRef'), context.get('user').id, 'product.read');
      const ids = await childIssueIds(sql, issue.id);
      const children = await Promise.all(ids.map((id) => issues.get(id)));
      const relations = await issues.loadRelations(ids);
      return json({
         nodes: children.map((child) => serializeIssue(child, relations.get(child.id))),
         progress: issue.childProgress,
      });
   });

   route.post('/:issueRef/children', async (context) => {
      const userId = context.get('user').id;
      const { issue: parent, workspaceId } = await resolve(context.req.param('issueRef'), userId, 'product.write');
      const input = await parseJsonBody(context.req.raw, childCreateSchema);
      let title = input.title ?? '';
      let description: string | null = null;
      if (input.fromCommentId) {
         const comment = await options.comments.get(input.fromCommentId).catch(rethrowWork('Comment'));
         // A comment on another issue is not found, rather than quietly used.
         if (comment.issueId !== parent.id) throw ApiError.notFound('Comment');
         const firstLine = comment.body.split('\n').find((line) => line.trim() !== '') ?? 'Sub-task';
         title = input.title ?? [...firstLine.trim()].slice(0, 500).join('');
         description = comment.body;
      }
      const child = await createOn({
         boardId: parent.boardId,
         workspaceId,
         userId,
         title,
         description,
         parentId: parent.id,
         stage: input.stage ?? null,
      });
      await record(parent.id, userId, 'issue.hierarchy.changed', { childId: child.id, fromCommentId: input.fromCommentId ?? null });
      return serve(await dispatchIfReady(child, workspaceId, userId), 201);
   });

   route.put('/:issueRef/parent', async (context) => {
      const userId = context.get('user').id;
      const { issue, workspaceId } = await resolve(context.req.param('issueRef'), userId, 'product.write');
      const input = await parseJsonBody(context.req.raw, parentSchema);
      await setParent(sql, { workspaceId, issueId: issue.id, parentId: input.parentId, stage: input.stage ?? null }).catch(asIssue);
      await record(issue.id, userId, 'issue.hierarchy.changed', { parentId: input.parentId, stage: input.stage ?? null });
      return serve(await dispatchIfReady(await issues.get(issue.id), workspaceId, userId));
   });

   route.put('/:issueRef/status', async (context) => {
      const userId = context.get('user').id;
      const { issue, workspaceId } = await resolve(context.req.param('issueRef'), userId, 'product.write');
      const { statusId } = await parseJsonBody(context.req.raw, statusChangeSchema);
      const status = await resolveStatus(sql, workspaceId, statusId).catch(rethrowWork('Status'));
      const updated = await applyPatch(issue, workspaceId, userId, { ...NO_CHANGE, status: status.category, statusId: status.id }).catch(asIssue);
      return serve(updated);
   });

   route.post('/:issueRef/move', async (context) => {
      const userId = context.get('user').id;
      const { issue, workspaceId } = await resolve(context.req.param('issueRef'), userId, 'product.write');
      const input = await parseJsonBody(context.req.raw, moveSchema);
      const before = input.beforeId ? await sortOrderOf(sql, input.beforeId).catch(asIssue) : undefined;
      const after = input.afterId ? await sortOrderOf(sql, input.afterId).catch(asIssue) : undefined;
      const updated = await applyPatch(issue, workspaceId, userId, { ...NO_CHANGE, sortOrder: sortOrderBetween(before, after) }).catch(asIssue);
      return serve(updated);
   });

   // -------------------------------------------------------------- timeline
   route.get('/:issueRef/activity', async (context) => {
      const { issue, workspaceId } = await resolve(context.req.param('issueRef'), context.get('user').id, 'product.read');
      const page = parsePageQuery(new URL(context.req.url));
      const scope = `activity.${issue.id}`;
      const after = page.after === '' ? null : decodeTimeCursor(page.after, scope);
      const rows = await listIssueActivity(sql, { workspaceId, issueId: issue.id, after, limit: page.first + 1 });
      const hasNextPage = rows.length > page.first;
      const nodes = hasNextPage ? rows.slice(0, page.first) : rows;
      const last = nodes.at(-1);
      return json({
         nodes,
         pageInfo: {
            hasNextPage,
            endCursor: last ? encodeCursor(scope, { createdAt: last.occurredAt, id: last.id }) : null,
         },
      });
   });

   // ---------------------------------------------------------- quick actions
   route.post('/:issueRef/quick-actions/:actionId/run', async (context) => {
      const userId = context.get('user').id;
      const { issue, workspaceId } = await resolve(context.req.param('issueRef'), userId, 'runs.dispatch');
      const actionId = pathId(context.req.param('actionId'), 'Quick action');
      if (!options.enqueue) {
         throw new ApiError(503, 'QUICK_ACTIONS_UNAVAILABLE', 'Quick actions need the agent runtime, which this server does not have.');
      }
      const { runId } = await runQuickAction(sql, options.enqueue, {
         workspaceId,
         actionId,
         viewerId: userId,
         issue: { id: issue.id, identifier: issue.identifier, title: issue.title, description: issue.description },
      }).catch(rethrowWork('Quick action'));
      return json({ runId }, 202);
   });

   return route;
}
```

- [ ] **Step 6: Wire the options into `mounts/issues.ts`**

Add imports:

```ts
import type { StageGate } from '../runs/auto-dispatch.ts';
import type { WorkTrackingHooks } from '../work/hooks.ts';
```

Add to `interface IssueOptions`:

```ts
   /** Work-tracking sub-routes (properties, reactions, children, batch...). */
   tracking?: Hono<{ Variables: AuthVariables }> | undefined;
   /** Holds a staged sub-issue until its earlier stages finish. */
   stages?: StageGate | undefined;
   /** Subscriptions, inbox rows and stage release after a write. */
   hooks?: WorkTrackingHooks | undefined;
```

In `issueMounts`, before `if (options.nested) route.route('/', options.nested);` add:

```ts
   // First, so its collection routes (`/assignee-frequency`, `/batch`) are
   // matched before `/:issueRef` reads them as an issue reference.
   if (options.tracking) route.route('/', options.tracking);
```

In `route.post('/')`, change the `autoDispatch(...)` call to pass `options.stages` as the fourth argument, and after `await publish(options, created.events);` add:

```ts
      await options.hooks
         ?.afterIssueWrite({
            kind: 'created',
            issue: created.issue,
            previousStatus: null,
            previousAssigneeId: null,
            actorId: user.id,
            workspaceId: scope.workspaceId,
            eventIds: created.events.map((event) => event.id),
         })
         .catch(() => undefined);
```

In `route.patch('/:issueRef')`, inside `if (touchesIssueRow(patch))`, after `await publish(options, result.events);` add:

```ts
         await options.hooks
            ?.afterIssueWrite({
               kind: 'updated',
               issue: result.issue,
               previousStatus: found.status,
               previousAssigneeId: found.assignee?.id ?? null,
               actorId: user.id,
               workspaceId: scope.workspaceId,
               eventIds: result.events.map((event) => event.id),
            })
            .catch(() => undefined);
```

Pass `options.stages` as the fourth argument to that handler's `autoDispatch(...)` call too.

- [ ] **Step 7: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types src/mounts/issue-tracking.test.ts && pnpm -w typecheck:server && pnpm -w test:server`
Expected: PASS, 8 tests; the whole suite stays green.

- [ ] **Step 8: Commit**

```bash
git add server-ts/src/work/hooks.ts server-ts/src/mounts/work-errors.ts server-ts/src/mounts/issue-tracking.ts server-ts/src/mounts/issue-tracking.test.ts server-ts/src/mounts/issues.ts
git commit -m "feat(server-ts): serve issue properties, reactions, subscriptions, sub-issues, batch and timeline"
```

---
### Task 13: Catalog, view, comment, pin and join-link routes

**Files:**
- Create: `server-ts/src/mounts/work-catalogs.ts`, `server-ts/src/mounts/view-routes.ts`, `server-ts/src/mounts/comment-tracking.ts`, `server-ts/src/mounts/pins.ts`, `server-ts/src/mounts/join-links.ts`
- Modify: `server-ts/src/mounts/workspace-reads.ts` (options `catalogExtensions`, `viewExtensions`), `server-ts/src/mounts/comments.ts` (options `extensions`, `hooks`)
- Test: `server-ts/src/mounts/work-mounts.test.ts`

**Interfaces:**
- Consumes: Tasks 3–12 (`rethrowWork`, `parseJsonBody`, repositories, `WorkTrackingHooks`).
- Produces: `workCatalogRoutes(): Hono<{ Variables: ScopedVariables }>`, `savedViewRoutes(options: { sql: Sql }): Hono<{ Variables: AuthVariables }>`, `commentTrackingRoutes(options: { sql: Sql; comments: CommentRepository; broadcaster?: Broadcaster }): Hono<{ Variables: AuthVariables }>`, `pinMounts(options: { sessions: SessionService; sql: Sql }): Mount[]`, `joinLinkMounts(options: { sessions: SessionService; sql: Sql }): Mount[]`. `WorkspaceReadOptions` gains `catalogExtensions?` and `viewExtensions?`; `CommentOptions` gains `extensions?` and `hooks?: Pick<WorkTrackingHooks, 'afterCommentCreate'>`.
- Wire contract:

| Method + path | Permission | Body | Response |
|---|---|---|---|
| `GET /api/v1/catalogs/:ws/issue-properties?includeArchived=true` | member | none | `{ nodes: PropertyDefinition[] }` |
| `POST /api/v1/catalogs/:ws/issue-properties` | `settings.write` | `{ name, kind, options?, description?, icon?, sortOrder? }` | 201 definition |
| `PATCH /api/v1/catalogs/:ws/issue-properties/:id` | `settings.write` | `{ name?, description?, options?, icon?, sortOrder? }` | definition |
| `DELETE /api/v1/catalogs/:ws/issue-properties/:id` | `settings.write` | none | 204 |
| `POST /api/v1/catalogs/:ws/issue-statuses` | `settings.write` | `{ name, category, color, description? }` | 201 status |
| `DELETE /api/v1/catalogs/:ws/issue-statuses/:id` | `settings.write` | none | 204 (409 `STATUS_PROTECTED` for system) |
| `PUT /api/v1/catalogs/:ws/issue-statuses/order` | `settings.write` | `{ ids }` | `{ nodes }` |
| `GET /api/v1/catalogs/:ws/quick-actions` | member | none | `{ nodes: QuickAction[] }` |
| `POST /api/v1/catalogs/:ws/quick-actions` | `product.write` | `{ name, targetAgentId, prompt, visibility?, description? }` | 201 action |
| `PATCH` / `DELETE /api/v1/catalogs/:ws/quick-actions/:id` | creator or owner/admin | patch | action / 204 |
| `GET /api/v1/catalogs/:ws/join-links` | `invitations.read` | none | `{ nodes: JoinLink[] }` |
| `POST /api/v1/catalogs/:ws/join-links` | `invitations.write` | `{ role?, expiresInDays?, maxUses? }` | 201 `{ ...JoinLink, token }` |
| `DELETE /api/v1/catalogs/:ws/join-links/:id` | `invitations.write` | none | 204 |
| `POST /api/v1/views` | member | `{ workspaceId, name, visibility?, query, display? }` | 201 view |
| `PATCH /api/v1/views/:viewId` | owner of view, or owner/admin for shared | `{ name?, visibility?, query?, display?, revision }` | view (409 `REVISION_CONFLICT`) |
| `DELETE /api/v1/views/:viewId` | same | none | 204 |
| `GET /api/v1/views/preferences?workspaceId=` | member | none | `{ activeViewId, preferences }` |
| `PUT /api/v1/views/preferences` | member | `{ workspaceId, activeViewId, preferences }` | same |
| `POST /api/v1/views/query` | member | `IssueQuery` | `IssueQueryResult` |
| `GET` / `POST /api/v1/comments/:id/reactions`, `DELETE /api/v1/comments/:id/reactions/:emoji` | read / `comments.write` | `{ emoji }` | `{ nodes }` |
| `POST` / `DELETE /api/v1/comments/:id/resolution` | `comments.write` | none | comment |
| `GET /api/v1/pins?workspaceId=` | member | none | `{ nodes: Pin[] }` |
| `POST /api/v1/pins` | member | `{ workspaceId, targetType, targetId }` | 201 pin |
| `PUT /api/v1/pins/order` | member | `{ workspaceId, ids }` | `{ nodes }` |
| `DELETE /api/v1/pins/:pinId?workspaceId=` | member | none | 204 |
| `GET /api/v1/join-links/:token` | **public** | none | `{ workspace: { id, name }, role, expiresAt }` or 404 |
| `POST /api/v1/join-links/:token/accept` | session | none | `{ workspaceId, role, joined }` |

- [ ] **Step 1: Write the failing mount test**

`server-ts/src/mounts/work-mounts.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { SessionService } from '../auth/sessions.ts';
import { BoardRepository } from '../core/boards.ts';
import { CommentRepository } from '../core/comments.ts';
import { IssueRepository } from '../core/issues.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { IdempotencyStore } from '../http/idempotency.ts';
import { Registry } from '../http/registry.ts';
import { cleanupWorld, seedWorld, type World } from '../work/fixture.ts';
import { formatMention } from '../work/mentions.ts';
import { workTrackingHooks } from '../work/hooks.ts';
import { commentMounts, issueCommentRoutes } from './comments.ts';
import { commentTrackingRoutes } from './comment-tracking.ts';
import { issueMounts } from './issues.ts';
import { joinLinkMounts } from './join-links.ts';
import { pinMounts } from './pins.ts';
import { savedViewRoutes } from './view-routes.ts';
import { workCatalogRoutes } from './work-catalogs.ts';
import { workspaceReadMounts } from './workspace-reads.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('work-tracking mounts', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let world: World;
   let other: World;
   let joinerId = '';
   const tokens: Record<string, string> = {};

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'mounts');
      other = await seedWorld(sql, 'mounts-other');
      const [joiner] = await sql`
         INSERT INTO users (id, email, name) VALUES (${randomUUID()}, ${`joiner-${randomUUID().slice(0, 8)}@berry.test`}, 'Joiner')
         RETURNING id`;
      joinerId = joiner?.id as string;

      const sessions = new SessionService({ sql, sessionTtlMs: 3_600_000 });
      const issues = new IssueRepository(sql);
      const boards = new BoardRepository(sql);
      const comments = new CommentRepository(sql);
      const idempotency = new IdempotencyStore(sql);
      const hooks = workTrackingHooks({ sql, issues });
      const commentOptions = {
         sessions,
         comments,
         issues,
         idempotency,
         hooks,
         extensions: commentTrackingRoutes({ sql, comments }),
      };
      const registry = new Registry();
      registry.registerAll(
         workspaceReadMounts({
            sessions,
            sql,
            boards,
            catalogExtensions: workCatalogRoutes(),
            viewExtensions: savedViewRoutes({ sql }),
         })
      );
      registry.registerAll(issueMounts({ sessions, issues, boards, idempotency, nested: issueCommentRoutes(commentOptions) }));
      registry.registerAll(commentMounts(commentOptions));
      registry.registerAll(pinMounts({ sessions, sql }));
      registry.registerAll(joinLinkMounts({ sessions, sql }));
      app = createApp(registry);
      tokens.owner = (await sessions.issueForUser(world.ownerId)).token;
      tokens.member = (await sessions.issueForUser(world.memberId)).token;
      tokens.viewer = (await sessions.issueForUser(world.viewerId)).token;
      tokens.outsider = (await sessions.issueForUser(other.ownerId)).token;
      tokens.joiner = (await sessions.issueForUser(joinerId)).token;
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await cleanupWorld(sql, other);
      await sql`DELETE FROM users WHERE id = ${joinerId}`;
      await closeDatabase(sql);
   });

   async function call(method: string, path: string, who: string | null, body?: unknown) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (who) headers.authorization = `Bearer ${tokens[who] ?? ''}`;
      if (method === 'POST' && path.endsWith('/comments')) headers['idempotency-key'] = `key-${randomUUID()}`;
      const response = await app.request(path, {
         method,
         headers,
         ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
   }
   const catalog = (path: string) => `/api/v1/catalogs/${world.workspaceId}${path}`;

   test('properties: an owner creates, a viewer is refused, an outsider sees nothing', async () => {
      const created = await call('POST', catalog('/issue-properties'), 'owner', { name: 'Area', kind: 'select', options: [{ id: 'ui', name: 'UI', color: '#123456' }] });
      assert.equal(created.status, 201);
      assert.equal((await call('POST', catalog('/issue-properties'), 'viewer', { name: 'X', kind: 'text' })).status, 403);
      assert.equal((await call('GET', catalog('/issue-properties'), 'outsider')).status, 404);
      const listed = await call('GET', catalog('/issue-properties'), 'viewer');
      assert.equal((listed.body?.nodes as unknown[]).length, 1);
   });

   test('statuses: create, reorder, and a system status refuses archive', async () => {
      const created = await call('POST', catalog('/issue-statuses'), 'owner', { name: 'Waiting on design', category: 'blocked', color: '#d97706' });
      assert.equal(created.status, 201);
      const statuses = await call('GET', catalog('/issue-statuses'), 'owner');
      const nodes = statuses.body?.nodes as Array<{ id: string; isSystem: boolean }>;
      const system = nodes.find((node) => node.isSystem);
      assert.equal((await call('DELETE', catalog(`/issue-statuses/${system?.id}`), 'owner')).status, 409);
      const order = await call('PUT', catalog('/issue-statuses/order'), 'owner', { ids: nodes.map((node) => node.id).reverse() });
      assert.equal(order.status, 200);
   });

   test('join links: created with a token, looked up without a session, accepted once', async () => {
      const created = await call('POST', catalog('/join-links'), 'owner', { role: 'member', maxUses: 5 });
      assert.equal(created.status, 201);
      const token = created.body?.token as string;
      const lookup = await call('GET', `/api/v1/join-links/${token}`, null);
      assert.deepEqual(lookup.body?.workspace, { id: world.workspaceId, name: (lookup.body?.workspace as { name: string }).name });
      assert.equal((await call('GET', `/api/v1/join-links/berry_join_nope`, null)).status, 404);
      const accepted = await call('POST', `/api/v1/join-links/${token}/accept`, 'joiner');
      assert.deepEqual(accepted.body, { workspaceId: world.workspaceId, role: 'member', joined: true });
      assert.equal((await call('GET', catalog('/join-links'), 'member')).status, 403);
   });

   test('views: create, edit at a revision, query, and remember preferences', async () => {
      const created = await call('POST', '/api/v1/views', 'member', { workspaceId: world.workspaceId, name: 'Board', query: {} });
      assert.equal(created.status, 201);
      const id = created.body?.id as string;
      assert.equal((await call('PATCH', `/api/v1/views/${id}`, 'member', { name: 'Board 2', revision: 1 })).status, 200);
      assert.equal((await call('PATCH', `/api/v1/views/${id}`, 'member', { name: 'Stale', revision: 1 })).status, 409);
      const query = await call('POST', '/api/v1/views/query', 'member', { workspaceId: world.workspaceId, groupBy: 'status' });
      assert.equal(query.status, 200);
      assert.ok(Array.isArray(query.body?.groups));
      await call('PUT', '/api/v1/views/preferences', 'member', { workspaceId: world.workspaceId, activeViewId: id, preferences: { layout: 'table' } });
      const prefs = await call('GET', `/api/v1/views/preferences?workspaceId=${world.workspaceId}`, 'member');
      assert.equal(prefs.body?.activeViewId, id);
      assert.equal((await call('DELETE', `/api/v1/views/${id}`, 'outsider')).status, 404);
   });

   test('pins: pin, list, unpin', async () => {
      const pinned = await call('POST', '/api/v1/pins', 'member', { workspaceId: world.workspaceId, targetType: 'issue', targetId: world.issueId });
      assert.equal(pinned.status, 201);
      const listed = await call('GET', `/api/v1/pins?workspaceId=${world.workspaceId}`, 'member');
      assert.equal((listed.body?.nodes as unknown[]).length, 1);
      assert.equal((await call('DELETE', `/api/v1/pins/${pinned.body?.id}?workspaceId=${world.workspaceId}`, 'member')).status, 204);
      assert.equal((await call('POST', '/api/v1/pins', 'outsider', { workspaceId: world.workspaceId, targetType: 'issue', targetId: world.issueId })).status, 404);
   });

   test('comments: a mention subscribes and notifies; reactions and resolution work', async () => {
      const body = `Please look ${formatMention('user', world.viewerId, 'Viewer')}`;
      const created = await call('POST', `/api/v1/issues/${world.issueId}/comments`, 'owner', { body });
      assert.equal(created.status, 201);
      const commentId = created.body?.id as string;
      const [inbox] = await sql`
         SELECT category FROM inbox_items WHERE recipient_id = ${world.viewerId} AND issue_id = ${world.issueId}`;
      assert.equal(inbox?.category, 'mentions');

      const reacted = await call('POST', `/api/v1/comments/${commentId}/reactions`, 'member', { emoji: '👍' });
      assert.equal((reacted.body?.nodes as unknown[]).length, 1);
      const resolved = await call('POST', `/api/v1/comments/${commentId}/resolution`, 'member');
      assert.notEqual(resolved.body?.resolvedAt, null);
      const reopened = await call('DELETE', `/api/v1/comments/${commentId}/resolution`, 'member');
      assert.equal(reopened.body?.resolvedAt, null);
      assert.equal((await call('POST', `/api/v1/comments/${commentId}/resolution`, 'viewer')).status, 403);
   });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd server-ts && node --test --experimental-strip-types src/mounts/work-mounts.test.ts`
Expected: FAIL with `Cannot find module '.../mounts/comment-tracking.ts'`.

- [ ] **Step 3: Implement `mounts/work-catalogs.ts`**

```ts
import { Hono } from 'hono';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import { allows } from '../identity/roles.ts';
import { Forbidden } from '../identity/errors.ts';
import { parseJsonBody } from '../work/http.ts';
import {
   archiveProperty,
   createProperty,
   listProperties,
   propertyCreateSchema,
   propertyPatchSchema,
   serializeProperty,
   updateProperty,
} from '../work/properties.ts';
import {
   archiveStatus,
   createStatus,
   reorderStatuses,
   serializeStatus,
   statusCreateSchema,
   statusOrderSchema,
} from '../work/statuses.ts';
import {
   archiveQuickAction,
   createQuickAction,
   listQuickActions,
   quickActionCreateSchema,
   quickActionPatchSchema,
   updateQuickAction,
} from '../work/quick-actions.ts';
import { createJoinLink, joinLinkCreateSchema, listJoinLinks, revokeJoinLink } from '../work/join-links.ts';
import { pathId, type ScopedVariables } from './shared.ts';
import { rethrowWork } from './work-errors.ts';

/**
 * Workspace vocabularies owned by work tracking, mounted inside the
 * `/api/v1/catalogs` route after `mountWorkspaceScope`, so every handler
 * already holds a membership-confirmed `scoped`.
 */
const MODERATOR_ROLES = new Set(['owner', 'admin']);

export function workCatalogRoutes(): Hono<{ Variables: ScopedVariables }> {
   const route = new Hono<{ Variables: ScopedVariables }>();

   // ------------------------------------------------------------- properties
   route.get('/:workspaceId/issue-properties', async (context) => {
      const db = context.get('scoped');
      const includeArchived = new URL(context.req.url).searchParams.get('includeArchived') === 'true';
      const nodes = await db.list((q) => listProperties(q.sql, q.workspaceId, includeArchived));
      return json({ nodes: nodes.map(serializeProperty) });
   });

   route.post('/:workspaceId/issue-properties', async (context) => {
      const db = context.get('scoped');
      const input = await parseJsonBody(context.req.raw, propertyCreateSchema);
      const created = await db
         .mutate('settings.write', (tx, ctx) => createProperty(tx, ctx.workspaceId, ctx.userId, input))
         .catch(rethrowWork('Property'));
      return json(serializeProperty(created), 201);
   });

   route.patch('/:workspaceId/issue-properties/:propertyId', async (context) => {
      const db = context.get('scoped');
      const propertyId = pathId(context.req.param('propertyId'), 'Property');
      const patch = await parseJsonBody(context.req.raw, propertyPatchSchema);
      const updated = await db
         .mutate('settings.write', (tx, ctx) => updateProperty(tx, ctx.workspaceId, propertyId, patch))
         .catch(rethrowWork('Property'));
      return json(serializeProperty(updated));
   });

   route.delete('/:workspaceId/issue-properties/:propertyId', async (context) => {
      const db = context.get('scoped');
      const propertyId = pathId(context.req.param('propertyId'), 'Property');
      const archived = await db.mutate('settings.write', (tx, ctx) => archiveProperty(tx, ctx.workspaceId, propertyId));
      if (!archived) throw ApiError.notFound('Property');
      return new Response(null, { status: 204 });
   });

   // --------------------------------------------------------------- statuses
   route.post('/:workspaceId/issue-statuses', async (context) => {
      const db = context.get('scoped');
      const input = await parseJsonBody(context.req.raw, statusCreateSchema);
      const created = await db
         .mutate('settings.write', (tx, ctx) => createStatus(tx, ctx.workspaceId, ctx.userId, input))
         .catch(rethrowWork('Status'));
      return json(serializeStatus(created), 201);
   });

   route.put('/:workspaceId/issue-statuses/order', async (context) => {
      const db = context.get('scoped');
      const { ids } = await parseJsonBody(context.req.raw, statusOrderSchema);
      const nodes = await db
         .mutate('settings.write', (tx, ctx) => reorderStatuses(tx, ctx.workspaceId, ids))
         .catch(rethrowWork('Status'));
      return json({ nodes: nodes.map(serializeStatus) });
   });

   route.delete('/:workspaceId/issue-statuses/:statusId', async (context) => {
      const db = context.get('scoped');
      const statusId = pathId(context.req.param('statusId'), 'Status');
      await db
         .mutate('settings.write', (tx, ctx) => archiveStatus(tx, ctx.workspaceId, statusId))
         .catch(rethrowWork('Status'));
      return new Response(null, { status: 204 });
   });

   // ---------------------------------------------------------- quick actions
   route.get('/:workspaceId/quick-actions', async (context) => {
      const db = context.get('scoped');
      const nodes = await db.list((q) => listQuickActions(q.sql, q.workspaceId, db.ctx.userId));
      return json({ nodes });
   });

   route.post('/:workspaceId/quick-actions', async (context) => {
      const db = context.get('scoped');
      const input = await parseJsonBody(context.req.raw, quickActionCreateSchema);
      const created = await db
         .mutate('product.write', (tx, ctx) => createQuickAction(tx, ctx.workspaceId, ctx.userId, input))
         .catch(rethrowWork('Agent'));
      return json(created, 201);
   });

   route.patch('/:workspaceId/quick-actions/:actionId', async (context) => {
      const db = context.get('scoped');
      const actionId = pathId(context.req.param('actionId'), 'Quick action');
      const patch = await parseJsonBody(context.req.raw, quickActionPatchSchema);
      const updated = await db
         .mutate('product.write', (tx, ctx) =>
            updateQuickAction(tx, { workspaceId: ctx.workspaceId, actionId, actorId: ctx.userId, moderator: MODERATOR_ROLES.has(ctx.role), patch })
         )
         .catch(rethrowWork('Quick action'));
      return json(updated);
   });

   route.delete('/:workspaceId/quick-actions/:actionId', async (context) => {
      const db = context.get('scoped');
      const actionId = pathId(context.req.param('actionId'), 'Quick action');
      await db
         .mutate('product.write', (tx, ctx) =>
            archiveQuickAction(tx, { workspaceId: ctx.workspaceId, actionId, actorId: ctx.userId, moderator: MODERATOR_ROLES.has(ctx.role) })
         )
         .catch(rethrowWork('Quick action'));
      return new Response(null, { status: 204 });
   });

   // ------------------------------------------------------------- join links
   route.get('/:workspaceId/join-links', async (context) => {
      const db = context.get('scoped');
      if (!allows(db.ctx.role, 'invitations.read')) throw rethrowWork('Join link')(new Forbidden());
      const nodes = await db.list((q) => listJoinLinks(q.sql, q.workspaceId));
      return json({ nodes });
   });

   route.post('/:workspaceId/join-links', async (context) => {
      const db = context.get('scoped');
      const input = await parseJsonBody(context.req.raw, joinLinkCreateSchema);
      const created = await db.mutate('invitations.write', (tx, ctx) => createJoinLink(tx, ctx.workspaceId, ctx.userId, input));
      const response = json({ ...created.link, token: created.token }, 201);
      response.headers.set('Cache-Control', 'no-store');
      return response;
   });

   route.delete('/:workspaceId/join-links/:linkId', async (context) => {
      const db = context.get('scoped');
      const linkId = pathId(context.req.param('linkId'), 'Join link');
      const revoked = await db.mutate('invitations.write', (tx, ctx) => revokeJoinLink(tx, ctx.workspaceId, linkId));
      if (!revoked) throw ApiError.notFound('Join link');
      return new Response(null, { status: 204 });
   });

   return route;
}
```

`Forbidden` (`identity/errors.ts`) takes no constructor arguments, so `new Forbidden()` is correct as written.

- [ ] **Step 4: Implement `mounts/view-routes.ts`**

```ts
import { Hono } from 'hono';
import type { AuthVariables } from '../auth/middleware.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import { parseJsonBody } from '../work/http.ts';
import { issueQuerySchema, runIssueQuery } from '../work/issue-query.ts';
import {
   createView,
   deleteView,
   preferencesSchema,
   readPreferences,
   updateView,
   viewCreateSchema,
   viewPatchSchema,
   viewWorkspace,
   writePreferences,
} from '../work/views.ts';
import { pathId, resolveScoped } from './shared.ts';
import { rethrowWork } from './work-errors.ts';

/** Saved-view writes, preferences and the grouped query, under `/api/v1/views`. */
const MODERATOR_ROLES = new Set(['owner', 'admin']);

export function savedViewRoutes(options: { sql: Sql }): Hono<{ Variables: AuthVariables }> {
   const { sql } = options;
   const route = new Hono<{ Variables: AuthVariables }>();
   const asView = rethrowWork('View');

   /** A view's workspace is read from the row, then membership is confirmed. */
   const scopeOfView = async (viewId: string, userId: string) => {
      const workspaceId = await viewWorkspace(sql, viewId);
      if (!workspaceId) throw ApiError.notFound('View');
      return resolveScoped(sql, userId, workspaceId).catch(() => {
         throw ApiError.notFound('View');
      });
   };

   route.get('/preferences', async (context) => {
      const userId = context.get('user').id;
      const db = await resolveScoped(sql, userId, new URL(context.req.url).searchParams.get('workspaceId') ?? '');
      return json(await readPreferences(sql, db.ctx.workspaceId, userId));
   });

   route.put('/preferences', async (context) => {
      const userId = context.get('user').id;
      const input = await parseJsonBody(context.req.raw, preferencesSchema);
      const db = await resolveScoped(sql, userId, input.workspaceId);
      const written = await writePreferences(sql, db.ctx.workspaceId, userId, input).catch(asView);
      return json(written);
   });

   route.post('/query', async (context) => {
      const userId = context.get('user').id;
      const input = await parseJsonBody(context.req.raw, issueQuerySchema);
      const db = await resolveScoped(sql, userId, input.workspaceId);
      return json(await runIssueQuery(sql, db.ctx.workspaceId, input));
   });

   route.post('/', async (context) => {
      const userId = context.get('user').id;
      const input = await parseJsonBody(context.req.raw, viewCreateSchema);
      const db = await resolveScoped(sql, userId, input.workspaceId);
      const view = await createView(sql, db.ctx.workspaceId, userId, input).catch((error: unknown) => {
         if ((error as { code?: string }).code === '23514') {
            throw new ApiError(422, 'VIEW_TOO_LARGE', 'The view definition is too large.');
         }
         throw error;
      });
      return json(view, 201);
   });

   route.patch('/:viewId', async (context) => {
      const userId = context.get('user').id;
      const viewId = pathId(context.req.param('viewId'), 'View');
      const db = await scopeOfView(viewId, userId);
      const patch = await parseJsonBody(context.req.raw, viewPatchSchema);
      const view = await sql
         .begin((tx) =>
            updateView(tx, { workspaceId: db.ctx.workspaceId, viewId, actorId: userId, moderator: MODERATOR_ROLES.has(db.ctx.role), patch })
         )
         .catch(asView);
      return json(view);
   });

   route.delete('/:viewId', async (context) => {
      const userId = context.get('user').id;
      const viewId = pathId(context.req.param('viewId'), 'View');
      const db = await scopeOfView(viewId, userId);
      await sql
         .begin((tx) => deleteView(tx, { workspaceId: db.ctx.workspaceId, viewId, actorId: userId, moderator: MODERATOR_ROLES.has(db.ctx.role) }))
         .catch(asView);
      return new Response(null, { status: 204 });
   });

   return route;
}
```

- [ ] **Step 5: Implement `mounts/comment-tracking.ts`**

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthVariables } from '../auth/middleware.ts';
import { serializeComment, type CommentRepository } from '../core/comments.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Broadcaster } from '../realtime/hub.ts';
import { setCommentResolution } from '../work/comment-resolution.ts';
import { parseJsonBody } from '../work/http.ts';
import { publishEvents, recordIssueEvent } from '../work/outbox.ts';
import { addReaction, emojiSchema, listReactions, removeReaction } from '../work/reactions.ts';
import { pathId } from './shared.ts';
import { rethrowWork } from './work-errors.ts';

/** Reactions and thread resolution on a comment, under `/api/v1/comments`. */
const emojiBody = z.object({ emoji: emojiSchema }).strict();

export function commentTrackingRoutes(options: {
   sql: Sql;
   comments: CommentRepository;
   broadcaster?: Broadcaster | undefined;
}): Hono<{ Variables: AuthVariables }> {
   const { sql, comments } = options;
   const route = new Hono<{ Variables: AuthVariables }>();
   const asComment = rethrowWork('Comment');

   const load = async (raw: string | undefined, userId: string, permission: 'product.read' | 'comments.write') => {
      const commentId = pathId(raw, 'Comment');
      await comments.authorize(userId, commentId, permission).catch(asComment);
      return comments.get(commentId).catch(asComment);
   };
   const record = async (issueId: string, userId: string, type: string, payload: Record<string, unknown>) => {
      const event = await recordIssueEvent(sql, { issueId, type, actor: { type: 'user', id: userId }, payload });
      await publishEvents(options.broadcaster, [event]);
   };

   route.get('/:commentId/reactions', async (context) => {
      const userId = context.get('user').id;
      const comment = await load(context.req.param('commentId'), userId, 'product.read');
      return json({ nodes: await listReactions(sql, 'comment', comment.id, userId) });
   });

   route.post('/:commentId/reactions', async (context) => {
      const userId = context.get('user').id;
      const comment = await load(context.req.param('commentId'), userId, 'comments.write');
      const { emoji } = await parseJsonBody(context.req.raw, emojiBody);
      if (await addReaction(sql, 'comment', comment.id, userId, emoji)) {
         await record(comment.issueId, userId, 'comment.reactions.changed', { commentId: comment.id, emoji, added: true });
      }
      return json({ nodes: await listReactions(sql, 'comment', comment.id, userId) });
   });

   route.delete('/:commentId/reactions/:emoji', async (context) => {
      const userId = context.get('user').id;
      const comment = await load(context.req.param('commentId'), userId, 'comments.write');
      const emoji = emojiSchema.safeParse(context.req.param('emoji') ?? '');
      if (!emoji.success) throw ApiError.notFound('Reaction');
      if (await removeReaction(sql, 'comment', comment.id, userId, emoji.data)) {
         await record(comment.issueId, userId, 'comment.reactions.changed', { commentId: comment.id, emoji: emoji.data, added: false });
      }
      return json({ nodes: await listReactions(sql, 'comment', comment.id, userId) });
   });

   for (const [method, resolved] of [
      ['post', true],
      ['delete', false],
   ] as const) {
      route[method]('/:commentId/resolution', async (context) => {
         const userId = context.get('user').id;
         const comment = await load(context.req.param('commentId'), userId, 'comments.write');
         const result = await sql
            .begin((tx) => setCommentResolution(tx, { commentId: comment.id, actorId: userId, resolved }))
            .catch(asComment);
         if (result.changed) {
            await record(result.issueId, userId, resolved ? 'comment.resolved' : 'comment.unresolved', { commentId: comment.id });
         }
         return json(serializeComment(await comments.get(comment.id)));
      });
   }

   return route;
}
```

- [ ] **Step 6: Implement `mounts/pins.ts` and `mounts/join-links.ts`**

`server-ts/src/mounts/pins.ts`:

```ts
import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { parseJsonBody } from '../work/http.ts';
import { listPins, pin, pinCreateSchema, pinOrderSchema, reorderPins, unpin } from '../work/pins.ts';
import { pathId, resolveScoped } from './shared.ts';
import { rethrowWork } from './work-errors.ts';

/** A person's sidebar pins: `/api/v1/pins`, workspace named by parameter. */
export function pinMounts(options: { sessions: SessionService; sql: Sql }): Mount[] {
   const { sql } = options;
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));
   const workspaceParam = (raw: string) => new URL(raw).searchParams.get('workspaceId') ?? '';

   route.get('/', async (context) => {
      const userId = context.get('user').id;
      const db = await resolveScoped(sql, userId, workspaceParam(context.req.url));
      return json({ nodes: await listPins(sql, db.ctx.workspaceId, userId) });
   });

   route.post('/', async (context) => {
      const userId = context.get('user').id;
      const input = await parseJsonBody(context.req.raw, pinCreateSchema);
      const db = await resolveScoped(sql, userId, input.workspaceId);
      const created = await sql
         .begin((tx) => pin(tx, db.ctx.workspaceId, userId, input.targetType, input.targetId))
         .catch(rethrowWork('Pin target'));
      return json(created, 201);
   });

   route.put('/order', async (context) => {
      const userId = context.get('user').id;
      const input = await parseJsonBody(context.req.raw, pinOrderSchema);
      const db = await resolveScoped(sql, userId, input.workspaceId);
      const nodes = await sql.begin((tx) => reorderPins(tx, db.ctx.workspaceId, userId, input.ids));
      return json({ nodes });
   });

   route.delete('/:pinId', async (context) => {
      const userId = context.get('user').id;
      const pinId = pathId(context.req.param('pinId'), 'Pin');
      const db = await resolveScoped(sql, userId, workspaceParam(context.req.url));
      if (!(await unpin(sql, db.ctx.workspaceId, userId, pinId))) throw ApiError.notFound('Pin');
      return new Response(null, { status: 204 });
   });

   return [{ prefix: '/api/v1/pins', handler: route }];
}
```

`server-ts/src/mounts/join-links.ts`:

```ts
import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { acceptJoinLink, lookupJoinLink } from '../work/join-links.ts';
import { rethrowWork } from './work-errors.ts';

/**
 * `/api/v1/join-links/:token`: the one unauthenticated read in work tracking.
 * It reveals only the workspace name and role, and answers every unusable
 * token with the same 404 so tokens cannot be probed.
 */
export function joinLinkMounts(options: { sessions: SessionService; sql: Sql }): Mount[] {
   const { sql } = options;
   const route = new Hono<{ Variables: AuthVariables }>();

   route.get('/:token', async (context) => {
      const found = await lookupJoinLink(sql, context.req.param('token') ?? '');
      if (!found) throw new ApiError(404, 'NOT_FOUND', 'This join link is not valid.');
      const response = json({
         workspace: { id: found.workspaceId, name: found.workspaceName },
         role: found.role,
         expiresAt: found.expiresAt,
      });
      response.headers.set('Cache-Control', 'no-store');
      return response;
   });

   route.post('/:token/accept', requireSession(options.sessions), async (context) => {
      const result = await acceptJoinLink(sql, context.req.param('token') ?? '', context.get('user').id).catch(
         rethrowWork('Join link')
      );
      const response = json(result);
      response.headers.set('Cache-Control', 'no-store');
      return response;
   });

   return [{ prefix: '/api/v1/join-links', handler: route }];
}
```

- [ ] **Step 7: Add the extension options**

In `mounts/workspace-reads.ts`, add to `WorkspaceReadOptions`:

```ts
   /** Extra `/:workspaceId/...` catalog routes (work tracking). */
   catalogExtensions?: Hono<{ Variables: ScopedVariables }> | undefined;
   /** Extra `/api/v1/views` routes (saved-view writes, preferences, query). */
   viewExtensions?: Hono<{ Variables: AuthVariables }> | undefined;
```

In `viewsRoute`, directly after `route.use('*', requireSession(options.sessions));` add `if (options.viewExtensions) route.route('/', options.viewExtensions);`. In `catalogsRoute`, directly after `mountWorkspaceScope(route, ...)` add `if (options.catalogExtensions) route.route('/', options.catalogExtensions);`. The scope middleware matches by path, so it also guards the extension's handlers.

In `mounts/comments.ts`, add `import type { WorkTrackingHooks } from '../work/hooks.ts';`, and add to `CommentOptions`:

```ts
   /** Extra `/api/v1/comments/:id/...` routes (reactions, resolution). */
   extensions?: Hono<{ Variables: AuthVariables }> | undefined;
   /** Subscriptions and inbox rows after a comment is written. */
   hooks?: Pick<WorkTrackingHooks, 'afterCommentCreate'> | undefined;
```

In `commentMounts`, after `direct.use('*', requireSession(options.sessions));` add `if (options.extensions) direct.route('/', options.extensions);`. In `issueCommentRoutes`'s POST handler, after `await publish(options, [result.event]);` add:

```ts
      await options.hooks
         ?.afterCommentCreate({
            comment: result.comment,
            workspaceId: result.event.workspaceId,
            eventId: result.event.id,
            actorId: context.get('user').id,
         })
         .catch(() => undefined);
```

- [ ] **Step 8: Run the tests**

Run: `cd server-ts && node --test --experimental-strip-types src/mounts/work-mounts.test.ts && pnpm -w typecheck:server && pnpm -w test:server`
Expected: PASS, 6 tests; suite green.

- [ ] **Step 9: Commit**

```bash
git add server-ts/src/mounts/work-catalogs.ts server-ts/src/mounts/view-routes.ts server-ts/src/mounts/comment-tracking.ts server-ts/src/mounts/pins.ts server-ts/src/mounts/join-links.ts server-ts/src/mounts/workspace-reads.ts server-ts/src/mounts/comments.ts server-ts/src/mounts/work-mounts.test.ts
git commit -m "feat(server-ts): serve property, status, quick-action, join-link, view, pin and comment routes"
```

---
### Task 14: Wire work tracking into the server, and prove tenant isolation

**Files:**
- Modify: `server-ts/src/index.ts` (registry block, ~lines 314–387)
- Modify: `server-ts/SCOPE.md` (Served block)
- Test: `server-ts/src/mounts/work-tracking.leakage.test.ts`

**Interfaces:**
- Consumes: `issueTrackingRoutes`, `commentTrackingRoutes`, `workCatalogRoutes`, `savedViewRoutes`, `pinMounts`, `joinLinkMounts`, `workTrackingHooks`, `stageGate`; optionally A's `enqueueTask` from `server-ts/src/runs/queue.ts`.
- Produces: the served prefixes `/api/v1/pins` and `/api/v1/join-links`, plus every route in the Task 12/13 contract tables, live in the running server.

- [ ] **Step 1: Write the failing leakage test**

`server-ts/src/mounts/work-tracking.leakage.test.ts`:

```ts
// Cross-tenant guarantees for every work-tracking mount (spec §11): a member of
// W1 reading or writing W2's work-tracking resources gets the same 404 as a
// random id, W2 is unchanged, and an anonymous caller is refused first.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { SessionService } from '../auth/sessions.ts';
import { BoardRepository } from '../core/boards.ts';
import { CommentRepository } from '../core/comments.ts';
import { IssueRepository } from '../core/issues.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { IdempotencyStore } from '../http/idempotency.ts';
import { Registry } from '../http/registry.ts';
import { cleanupWorld, seedWorld, type World } from '../work/fixture.ts';
import { workTrackingHooks } from '../work/hooks.ts';
import { commentMounts, issueCommentRoutes } from './comments.ts';
import { commentTrackingRoutes } from './comment-tracking.ts';
import { issueMounts } from './issues.ts';
import { issueTrackingRoutes } from './issue-tracking.ts';
import { joinLinkMounts } from './join-links.ts';
import { pinMounts } from './pins.ts';
import { savedViewRoutes } from './view-routes.ts';
import { workCatalogRoutes } from './work-catalogs.ts';
import { workspaceReadMounts } from './workspace-reads.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('work tracking: cross-tenant leakage', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let w1: World;
   let w2: World;
   let token = '';
   let w2CommentId = '';
   let w2ViewId = '';
   let w2ActionId = '';
   let w2LinkId = '';
   let w2PropertyId = '';

   before(async () => {
      sql = openDatabase({ url: url as string });
      w1 = await seedWorld(sql, 'leak-1');
      w2 = await seedWorld(sql, 'leak-2');
      const [comment] = await sql`
         INSERT INTO comments (issue_id, author_type, author_id, body)
         VALUES (${w2.issueId}, 'user', ${w2.ownerId}, 'W2 only') RETURNING id`;
      w2CommentId = comment?.id as string;
      // W2-owned rows that W1 will try to change by id.
      const [view] = await sql`
         INSERT INTO saved_issue_views (workspace_id, owner_id, name, visibility, query)
         VALUES (${w2.workspaceId}, ${w2.ownerId}, 'W2 view', 'workspace', ${sql.json({} as never)})
         RETURNING id`;
      w2ViewId = view?.id as string;
      const [action] = await sql`
         INSERT INTO quick_action_definitions (workspace_id, name, target_agent_id, prompt, visibility, created_by)
         VALUES (${w2.workspaceId}, 'W2 action', ${w2.agentId}, 'Do it', 'workspace', ${w2.ownerId})
         RETURNING id`;
      w2ActionId = action?.id as string;
      const [link] = await sql`
         INSERT INTO workspace_join_links (workspace_id, role, token_hash, created_by)
         VALUES (${w2.workspaceId}, 'member', ${Buffer.alloc(32, 7)}, ${w2.ownerId})
         RETURNING id`;
      w2LinkId = link?.id as string;
      const [property] = await sql`
         INSERT INTO issue_property_definitions (workspace_id, name, kind)
         VALUES (${w2.workspaceId}, 'W2 field', 'text')
         RETURNING id`;
      w2PropertyId = property?.id as string;

      const sessions = new SessionService({ sql, sessionTtlMs: 3_600_000 });
      const issues = new IssueRepository(sql);
      const boards = new BoardRepository(sql);
      const comments = new CommentRepository(sql);
      const idempotency = new IdempotencyStore(sql);
      const hooks = workTrackingHooks({ sql, issues });
      const commentOptions = { sessions, comments, issues, idempotency, hooks, extensions: commentTrackingRoutes({ sql, comments }) };
      const registry = new Registry();
      registry.registerAll(workspaceReadMounts({ sessions, sql, boards, catalogExtensions: workCatalogRoutes(), viewExtensions: savedViewRoutes({ sql }) }));
      registry.registerAll(
         issueMounts({
            sessions,
            issues,
            boards,
            idempotency,
            hooks,
            nested: issueCommentRoutes(commentOptions),
            tracking: issueTrackingRoutes({ sql, issues, boards, comments, hooks }),
         })
      );
      registry.registerAll(commentMounts(commentOptions));
      registry.registerAll(pinMounts({ sessions, sql }));
      registry.registerAll(joinLinkMounts({ sessions, sql }));
      app = createApp(registry);
      token = (await sessions.issueForUser(w1.ownerId)).token;
   });
   after(async () => {
      await cleanupWorld(sql, w1);
      await cleanupWorld(sql, w2);
      await closeDatabase(sql);
   });

   async function as(method: string, path: string, body?: unknown, auth = true) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (auth) headers.authorization = `Bearer ${token}`;
      const response = await app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return response.status;
   }

   test('reads of another workspace are 404', async () => {
      const reads = [
         `/api/v1/issues/${w2.issueId}/properties`,
         `/api/v1/issues/${w2.issueId}/metadata`,
         `/api/v1/issues/${w2.issueId}/reactions`,
         `/api/v1/issues/${w2.issueId}/subscribers`,
         `/api/v1/issues/${w2.issueId}/children`,
         `/api/v1/issues/${w2.issueId}/activity`,
         `/api/v1/comments/${w2CommentId}/reactions`,
         `/api/v1/catalogs/${w2.workspaceId}/issue-properties`,
         `/api/v1/catalogs/${w2.workspaceId}/quick-actions`,
         `/api/v1/catalogs/${w2.workspaceId}/join-links`,
         `/api/v1/pins?workspaceId=${w2.workspaceId}`,
         `/api/v1/views/preferences?workspaceId=${w2.workspaceId}`,
         `/api/v1/issues/assignee-frequency?workspaceId=${w2.workspaceId}`,
      ];
      for (const path of reads) assert.equal(await as('GET', path), 404, path);
   });

   test('writes to another workspace are 404 and change nothing', async () => {
      const writes: Array<[string, string, unknown]> = [
         ['PUT', `/api/v1/issues/${w2.issueId}/subscription`, {}],
         ['POST', `/api/v1/issues/${w2.issueId}/reactions`, { emoji: '👍' }],
         ['PATCH', `/api/v1/issues/${w2.issueId}/metadata`, { set: { leaked: true } }],
         ['POST', `/api/v1/issues/${w2.issueId}/children`, { title: 'Leak' }],
         ['POST', `/api/v1/comments/${w2CommentId}/resolution`, undefined],
         ['POST', `/api/v1/catalogs/${w2.workspaceId}/issue-properties`, { name: 'Leak', kind: 'text' }],
         ['POST', `/api/v1/catalogs/${w2.workspaceId}/join-links`, {}],
         ['POST', '/api/v1/views/query', { workspaceId: w2.workspaceId }],
         ['POST', '/api/v1/views', { workspaceId: w2.workspaceId, name: 'Leak', query: {} }],
         ['POST', '/api/v1/pins', { workspaceId: w2.workspaceId, targetType: 'issue', targetId: w2.issueId }],
         ['POST', '/api/v1/pins', { workspaceId: w1.workspaceId, targetType: 'issue', targetId: w2.issueId }],
         ['POST', '/api/v1/issues/quick', { workspaceId: w2.workspaceId, title: 'Leak' }],
         ['PUT', `/api/v1/issues/${w2.issueId}/properties/${w2PropertyId}`, { value: 'leak' }],
         ['PUT', `/api/v1/issues/${w2.issueId}/status`, { statusId: randomUUID() }],
         ['POST', `/api/v1/issues/${w2.issueId}/move`, {}],
         ['POST', `/api/v1/issues/${w2.issueId}/quick-actions/${w2ActionId}/run`, undefined],
         ['POST', `/api/v1/issues/${w1.issueId}/quick-actions/${w2ActionId}/run`, undefined],
         ['POST', `/api/v1/comments/${w2CommentId}/reactions`, { emoji: '👍' }],
         ['PATCH', `/api/v1/catalogs/${w2.workspaceId}/issue-properties/${w2PropertyId}`, { name: 'Leak' }],
         ['PATCH', `/api/v1/catalogs/${w1.workspaceId}/issue-properties/${w2PropertyId}`, { name: 'Leak' }],
         ['POST', `/api/v1/catalogs/${w2.workspaceId}/issue-statuses`, { name: 'Leak', category: 'todo', color: '#123456' }],
         ['PATCH', `/api/v1/catalogs/${w2.workspaceId}/quick-actions/${w2ActionId}`, { name: 'Leak' }],
         ['DELETE', `/api/v1/catalogs/${w1.workspaceId}/quick-actions/${w2ActionId}`, undefined],
         ['DELETE', `/api/v1/catalogs/${w2.workspaceId}/join-links/${w2LinkId}`, undefined],
         ['DELETE', `/api/v1/catalogs/${w1.workspaceId}/join-links/${w2LinkId}`, undefined],
         ['PATCH', `/api/v1/views/${w2ViewId}`, { name: 'Leak', revision: 1 }],
         ['DELETE', `/api/v1/views/${w2ViewId}`, undefined],
         ['PUT', '/api/v1/views/preferences', { workspaceId: w2.workspaceId, activeViewId: null, preferences: {} }],
         ['PUT', '/api/v1/views/preferences', { workspaceId: w1.workspaceId, activeViewId: w2ViewId, preferences: {} }],
         ['POST', '/api/v1/pins', { workspaceId: w1.workspaceId, targetType: 'view', targetId: w2ViewId }],
         ['POST', '/api/v1/issues/batch-delete', { issueIds: [w2.issueId] }],
         // Re-parenting W1's issue under W2's: the one 422 by design (PARENT_NOT_FOUND).
         ['PUT', `/api/v1/issues/${w1.issueId}/parent`, { parentId: w2.issueId }],
         // Quick create in W1 naming W2's board.
         ['POST', '/api/v1/issues/quick', { workspaceId: w1.workspaceId, boardId: w2.boardId, title: 'Leak' }],
         ['DELETE', `/api/v1/issues/${w2.issueId}/reactions/${encodeURIComponent('👍')}`, undefined],
         ['DELETE', `/api/v1/issues/${w2.issueId}/subscription`, undefined],
         ['DELETE', `/api/v1/issues/${w2.issueId}/properties/${w2PropertyId}`, undefined],
         ['DELETE', `/api/v1/comments/${w2CommentId}/resolution`, undefined],
         ['DELETE', `/api/v1/comments/${w2CommentId}/reactions/${encodeURIComponent('👍')}`, undefined],
         ['DELETE', `/api/v1/catalogs/${w2.workspaceId}/issue-properties/${w2PropertyId}`, undefined],
         ['DELETE', `/api/v1/catalogs/${w1.workspaceId}/issue-properties/${w2PropertyId}`, undefined],
         ['PUT', `/api/v1/catalogs/${w2.workspaceId}/issue-statuses/order`, { ids: [randomUUID()] }],
         ['DELETE', `/api/v1/pins/${randomUUID()}?workspaceId=${w2.workspaceId}`, undefined],
         ['PUT', '/api/v1/pins/order', { workspaceId: w2.workspaceId, ids: [randomUUID()] }],
      ];
      // Only the re-parent answers 422 (PARENT_NOT_FOUND by design); every other
      // cross-tenant write must be the same 404 a random id gets, so a body that
      // fails validation can never hide a leak.
      const UNPROCESSABLE_BY_DESIGN = new Set([`PUT /api/v1/issues/${w1.issueId}/parent`]);
      for (const [method, path, body] of writes) {
         const status = await as(method, path, body);
         const key = `${method} ${path}`;
         if (UNPROCESSABLE_BY_DESIGN.has(key)) assert.ok(status === 404 || status === 422, `${key} answered ${status}`);
         else if (path.startsWith('/api/v1/issues/batch')) assert.equal(status, 200, key);
         else assert.equal(status, 404, key);
      }
      const [w2State] = await sql`
         SELECT
           (SELECT name FROM saved_issue_views WHERE id = ${w2ViewId}) AS view_name,
           (SELECT name FROM quick_action_definitions WHERE id = ${w2ActionId} AND archived_at IS NULL) AS action_name,
           (SELECT revoked_at FROM workspace_join_links WHERE id = ${w2LinkId}) AS link_revoked,
           (SELECT name FROM issue_property_definitions WHERE id = ${w2PropertyId}) AS property_name,
           (SELECT archived_at FROM issue_property_definitions WHERE id = ${w2PropertyId}) AS property_archived,
           (SELECT count(*) FROM issue_property_values WHERE issue_id = ${w2.issueId})::int AS values,
           (SELECT deleted_at FROM issues WHERE id = ${w2.issueId}) AS issue_deleted,
           (SELECT count(*) FROM comment_reactions WHERE comment_id = ${w2CommentId})::int AS comment_reactions,
           (SELECT count(*) FROM user_pins WHERE user_id = ${w1.ownerId})::int AS pins,
           (SELECT count(*) FROM issue_status_definitions WHERE workspace_id = ${w2.workspaceId} AND lower(name) = 'leak')::int AS statuses`;
      assert.deepEqual(w2State, {
         view_name: 'W2 view',
         action_name: 'W2 action',
         link_revoked: null,
         property_name: 'W2 field',
         property_archived: null,
         values: 0,
         issue_deleted: null,
         comment_reactions: 0,
         pins: 0,
         statuses: 0,
      });
      const [counts] = await sql`
         SELECT
           (SELECT count(*) FROM issue_property_definitions WHERE workspace_id = ${w2.workspaceId} AND name <> 'W2 field')::int AS properties,
           (SELECT count(*) FROM issue_subscribers WHERE issue_id = ${w2.issueId} AND user_id = ${w1.ownerId})::int AS subscriptions,
           (SELECT count(*) FROM issue_reactions WHERE issue_id = ${w2.issueId})::int AS reactions,
           (SELECT count(*) FROM workspace_join_links WHERE workspace_id = ${w2.workspaceId})::int AS links,
           (SELECT metadata FROM issues WHERE id = ${w2.issueId}) AS metadata,
           (SELECT parent_id FROM issues WHERE id = ${w1.issueId}) AS parent`;
      assert.deepEqual(counts, { properties: 0, subscriptions: 0, reactions: 0, links: 0, metadata: {}, parent: null });
   });

   test('a batch naming another workspace\'s issue reports it not found', async () => {
      const response = await app.request('/api/v1/issues/batch', {
         method: 'POST',
         headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
         body: JSON.stringify({ issueIds: [w2.issueId], patch: { priority: 'high' } }),
      });
      assert.deepEqual(await response.json(), { updated: [], failed: [{ id: w2.issueId, code: 'NOT_FOUND' }] });
   });

   test('an anonymous caller is refused before any handler runs', async () => {
      assert.equal(await as('GET', `/api/v1/issues/${w1.issueId}/properties`, undefined, false), 401);
      assert.equal(await as('GET', `/api/v1/pins?workspaceId=${w1.workspaceId}`, undefined, false), 401);
      assert.equal(await as('POST', `/api/v1/join-links/berry_join_${randomUUID()}/accept`, undefined, false), 401);
   });
});
```

The `PUT /issues/:w1/parent` case (present in `writes`) answers 422 `PARENT_NOT_FOUND` by design, which is why the assertion accepts 404 or 422 for that key only; the final `parent: null` check proves W1's issue was not re-parented under W2's.

- [ ] **Step 2: Run to confirm it passes against the mounts from Tasks 12–13**

Run: `cd server-ts && node --test --experimental-strip-types src/mounts/work-tracking.leakage.test.ts`
Expected: PASS. It fails only if a route leaks; fix the route, never the test.

- [ ] **Step 3: Wire `index.ts`**

Add imports next to the other mount imports:

```ts
import { issueTrackingRoutes } from './mounts/issue-tracking.ts';
import { commentTrackingRoutes } from './mounts/comment-tracking.ts';
import { workCatalogRoutes } from './mounts/work-catalogs.ts';
import { savedViewRoutes } from './mounts/view-routes.ts';
import { pinMounts } from './mounts/pins.ts';
import { joinLinkMounts } from './mounts/join-links.ts';
import { workTrackingHooks } from './work/hooks.ts';
import { stageGate } from './work/hierarchy.ts';
```

Replace `const commentOptions = { sessions, comments, issues, idempotency, broadcaster };` with:

```ts
// Work tracking: subscriptions and inbox rows after writes, and the stage
// barrier on sub-issues. Dispatch only where runs can execute, as below.
const workDispatch = executor ? runOptions.runs : undefined;
const workHooks = workTrackingHooks({ sql, issues, dispatch: workDispatch });
const commentOptions = {
   sessions,
   comments,
   issues,
   idempotency,
   broadcaster,
   hooks: workHooks,
   extensions: commentTrackingRoutes({ sql, comments, broadcaster }),
};
```

Inside the `issueMounts({ ... })` call add:

```ts
      stages: stageGate(sql),
      hooks: workHooks,
      tracking: issueTrackingRoutes({
         sql,
         issues,
         boards,
         comments,
         broadcaster,
         dispatch: workDispatch,
         hooks: workHooks,
      }),
```

Replace `registry.registerAll(workspaceReadMounts({ sessions, sql, boards }));` with:

```ts
registry.registerAll(
   workspaceReadMounts({
      sessions,
      sql,
      boards,
      catalogExtensions: workCatalogRoutes(),
      viewExtensions: savedViewRoutes({ sql }),
   })
);
registry.registerAll(pinMounts({ sessions, sql }));
registry.registerAll(joinLinkMounts({ sessions, sql }));
```

**Quick actions and A.** Check whether `server-ts/src/runs/queue.ts` exists with `test -f server-ts/src/runs/queue.ts && echo present`.
- If it prints `present`: add `import { enqueueTask } from './runs/queue.ts';` and `enqueue: enqueueTask,` inside the `issueTrackingRoutes({ ... })` options.
- If not: leave `enqueue` unset. The run route then answers 503 `QUICK_ACTIONS_UNAVAILABLE`, and the enqueue line is added in A's merge. Record this in the PR body.

- [ ] **Step 4: Update `SCOPE.md`**

In the Served block, add `/api/v1/join-links` and `/api/v1/pins` in alphabetical position:

```
/api/v1/agents        /api/v1/approvals     /api/v1/attachments   /api/v1/auth
/api/v1/boards        /api/v1/catalogs      /api/v1/comments      /api/v1/config
/api/v1/conversations /api/v1/editor        /api/v1/events        /api/v1/goals
/api/v1/inbox         /api/v1/integrations  /api/v1/invitations   /api/v1/issues
/api/v1/join-links    /api/v1/me            /api/v1/pins          /api/v1/plans
/api/v1/projects      /api/v1/runs          /api/v1/search        /api/v1/tokens
/api/v1/views         /api/v1/webhooks      /api/v1/workspaces
/health  /metrics  /ready  /readyz
```

- [ ] **Step 5: Run the full server gates**

Run: `pnpm typecheck:server && pnpm test:server && (cd server-ts && grep -rhoE "prefix: '/[^']+'" src/mounts/*.ts | sort -u)`
Expected: typecheck and tests PASS. The prefix list includes `/api/v1/join-links` and `/api/v1/pins`. Also run `pnpm dev:server` briefly: it must start without `mount ... overlaps` errors.

- [ ] **Step 6: Commit**

```bash
git add server-ts/src/index.ts server-ts/SCOPE.md server-ts/src/mounts/work-tracking.leakage.test.ts
git commit -m "feat(server-ts): serve work tracking and cover it with cross-tenant tests"
```

---
### Task 15: Frontend API clients for work tracking

The frontend has no test runner (see `docs/coding-playbook.md`), so frontend tasks gate on `pnpm lint` and `pnpm build:check`, plus the manual check each task names. Each client parses with Zod v3 and throws on an unrecognised shape, so a caller can tell a failed read from an empty one.

**Files:**
- Create: `frontend/lib/parse-response.ts`, `frontend/lib/properties.ts`, `frontend/lib/reactions.ts`, `frontend/lib/subscribers.ts`, `frontend/lib/issue-tracking.ts`, `frontend/lib/activity.ts`, `frontend/lib/pins.ts`, `frontend/lib/quick-actions.ts`, `frontend/lib/join-links.ts`
- Modify: `frontend/lib/comments.ts`, `frontend/lib/views.ts`, `frontend/lib/settings.ts`, `frontend/lib/issues.ts` (`issueSchema`, `toUiIssue`), `frontend/data/issues.ts` (`Issue`)

**Interfaces:**
- Consumes: the wire contracts in Tasks 12 and 13.
- Produces (exact names later tasks import):
  - `parseResponse(schema, json, what)`
  - `properties.ts`: `PROPERTY_KINDS`, `PROPERTY_KIND_LABELS`, `type PropertyKind`, `type PropertyOption`, `type PropertyDefinition`, `type PropertyValue`, `loadProperties(workspaceId)`, `createProperty(workspaceId, input)`, `updateProperty(workspaceId, id, patch)`, `archiveProperty(workspaceId, id)`, `loadIssueProperties(issueRef)`, `setIssueProperty(issueRef, propertyId, value)`, `clearIssueProperty(issueRef, propertyId)`, `loadIssueMetadata(issueRef)`, `patchIssueMetadata(issueRef, patch)`
  - `reactions.ts`: `type ReactionGroup`, `QUICK_EMOJI`, `loadReactions(target, id)`, `toggleReaction(target, id, emoji, reacted)` where `target: 'issue' | 'comment'`
  - `subscribers.ts`: `type Subscriber`, `loadSubscribers(issueRef)`, `setSubscription(issueRef, subscribed, subtree)`
  - `issue-tracking.ts`: `loadChildren(issueRef)`, `createChild(issueRef, input)`, `setParent(issueRef, parentId, stage)`, `setCustomStatus(issueRef, statusId)`, `moveIssue(issueRef, beforeId, afterId)`, `quickCreateIssue(input)`, `batchUpdateIssues(issueIds, patch)`, `batchDeleteIssues(issueIds)`, `loadAssigneeFrequency(workspaceId)`, `runQuickAction(issueRef, actionId)`
  - `activity.ts`: `type ActivityEntry`, `loadIssueActivity(issueRef)`, `describeActivity(entry)`
  - `pins.ts`: `type Pin`, `loadPins(workspaceId)`, `pinTarget(workspaceId, targetType, targetId)`, `unpinTarget(workspaceId, pinId)`, `reorderPins(workspaceId, ids)`
  - `quick-actions.ts`: `type QuickAction`, `loadQuickActions(workspaceId)`, `createQuickAction(workspaceId, input)`, `archiveQuickAction(workspaceId, id)`
  - `join-links.ts`: `type JoinLink`, `loadJoinLinks(workspaceId)`, `createJoinLink(workspaceId, input)`, `revokeJoinLink(workspaceId, id)`, `lookupJoinLink(token)`, `acceptJoinLink(token)`, `joinLinkUrl(token)`
  - `comments.ts`: `updateComment(commentId, body, revision)`, `deleteComment(commentId)`, `setCommentResolved(commentId, resolved)`
  - `views.ts`: `type SavedView`, `type IssueQueryResult`, `createSavedView(input)`, `updateSavedView(viewId, patch)`, `deleteSavedView(viewId)`, `loadViewPreferences(workspaceId)`, `saveViewPreferences(workspaceId, activeViewId, preferences)`, `queryIssues(input)`
  - `settings.ts`: `STATUS_CATEGORIES`, `createStatus(workspaceId, input)`, `archiveStatus(workspaceId, statusId)`, `reorderStatuses(workspaceId, ids)`
  - `data/issues.ts` `Issue` gains optional `parentId?: string | null; stage?: number | null; statusId?: string | null; childProgress?: { total: number; done: number }`.

- [ ] **Step 1: Shared parsing and the issue shape**

`frontend/lib/parse-response.ts`:

```ts
import type { z } from 'zod';

/** Parses a response body, naming what failed rather than returning a blank. */
export function parseResponse<T extends z.ZodTypeAny>(schema: T, json: unknown, what: string): z.infer<T> {
   const parsed = schema.safeParse(json);
   if (!parsed.success) throw new Error(`${what} response was not recognized`);
   return parsed.data;
}
```

In `frontend/lib/issues.ts`, add to `issueSchema` after `blocks`:

```ts
   parentId: z.string().nullish(),
   stage: z.number().nullish(),
   statusId: z.string().nullish(),
   childProgress: z.object({ total: z.number(), done: z.number() }).nullish(),
```

In the object `toUiIssue` returns, add:

```ts
      parentId: apiIssue.parentId ?? null,
      stage: apiIssue.stage ?? null,
      statusId: apiIssue.statusId ?? null,
      childProgress: apiIssue.childProgress ?? { total: 0, done: 0 },
```

Export the parser for other modules: add `export function parseApiIssue(json: unknown): Issue | undefined { const parsed = issueSchema.safeParse(json); return parsed.success ? toUiIssue(parsed.data) : undefined; }` below `toUiIssue`.

In `frontend/data/issues.ts`, inside `interface Issue` after `blocks?`:

```ts
   /** The task this one is a sub-task of. */
   parentId?: string | null;
   /** Ordered barrier among siblings: stage N+1 waits for stage N. */
   stage?: number | null;
   /** A workspace status refining `status`. */
   statusId?: string | null;
   childProgress?: { total: number; done: number };
```

- [ ] **Step 2: Properties, reactions, subscribers**

`frontend/lib/properties.ts`:

```ts
import { z } from 'zod';
import { apiFetch } from './api';
import { parseResponse } from './parse-response';

export const PROPERTY_KINDS = [
   'text',
   'number',
   'boolean',
   'date',
   'url',
   'select',
   'multi_select',
   'person',
   'multi_person',
] as const;
export type PropertyKind = (typeof PROPERTY_KINDS)[number];

export const PROPERTY_KIND_LABELS: Record<PropertyKind, string> = {
   text: 'Text',
   number: 'Number',
   boolean: 'Checkbox',
   date: 'Date',
   url: 'URL',
   select: 'Select',
   multi_select: 'Multi-select',
   person: 'Person',
   multi_person: 'People',
};

const optionSchema = z.object({ id: z.string(), name: z.string(), color: z.string() });
export type PropertyOption = z.infer<typeof optionSchema>;

const definitionSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   name: z.string(),
   description: z.string().nullable(),
   kind: z.enum(PROPERTY_KINDS),
   options: z.array(optionSchema),
   icon: z.string().nullable(),
   sortOrder: z.number(),
   createdAt: z.string(),
   updatedAt: z.string(),
   archivedAt: z.string().nullable(),
});
export type PropertyDefinition = z.infer<typeof definitionSchema>;

const valueSchema = z.object({ propertyId: z.string(), value: z.unknown() });
export type PropertyValue = { propertyId: string; value: unknown };

const catalog = (workspaceId: string, suffix = '') =>
   `/api/v1/catalogs/${encodeURIComponent(workspaceId)}/issue-properties${suffix}`;
const onIssue = (issueRef: string, suffix: string) =>
   `/api/v1/issues/${encodeURIComponent(issueRef)}${suffix}`;

export async function loadProperties(workspaceId: string): Promise<PropertyDefinition[]> {
   return parseResponse(z.object({ nodes: z.array(definitionSchema) }), await apiFetch(catalog(workspaceId)), 'Properties').nodes;
}

export async function createProperty(
   workspaceId: string,
   input: { name: string; kind: PropertyKind; options?: PropertyOption[]; description?: string | null }
): Promise<PropertyDefinition> {
   return parseResponse(
      definitionSchema,
      await apiFetch(catalog(workspaceId), { method: 'POST', body: JSON.stringify(input) }),
      'Property'
   );
}

export async function updateProperty(
   workspaceId: string,
   propertyId: string,
   patch: { name?: string; description?: string | null; options?: PropertyOption[] }
): Promise<PropertyDefinition> {
   return parseResponse(
      definitionSchema,
      await apiFetch(catalog(workspaceId, `/${encodeURIComponent(propertyId)}`), {
         method: 'PATCH',
         body: JSON.stringify(patch),
      }),
      'Property'
   );
}

export async function archiveProperty(workspaceId: string, propertyId: string): Promise<void> {
   await apiFetch(catalog(workspaceId, `/${encodeURIComponent(propertyId)}`), { method: 'DELETE' });
}

export async function loadIssueProperties(issueRef: string): Promise<PropertyValue[]> {
   const parsed = parseResponse(z.object({ nodes: z.array(valueSchema) }), await apiFetch(onIssue(issueRef, '/properties')), 'Property values');
   return parsed.nodes.map((node) => ({ propertyId: node.propertyId, value: node.value }));
}

export async function setIssueProperty(issueRef: string, propertyId: string, value: unknown): Promise<void> {
   await apiFetch(onIssue(issueRef, `/properties/${encodeURIComponent(propertyId)}`), {
      method: 'PUT',
      body: JSON.stringify({ value }),
   });
}

export async function clearIssueProperty(issueRef: string, propertyId: string): Promise<void> {
   await apiFetch(onIssue(issueRef, `/properties/${encodeURIComponent(propertyId)}`), { method: 'DELETE' });
}

const metadataSchema = z.object({ metadata: z.record(z.unknown()) });

export async function loadIssueMetadata(issueRef: string): Promise<Record<string, unknown>> {
   return parseResponse(metadataSchema, await apiFetch(onIssue(issueRef, '/metadata')), 'Metadata').metadata;
}

export async function patchIssueMetadata(
   issueRef: string,
   patch: { set?: Record<string, string | number | boolean | null>; remove?: string[] }
): Promise<Record<string, unknown>> {
   return parseResponse(
      metadataSchema,
      await apiFetch(onIssue(issueRef, '/metadata'), { method: 'PATCH', body: JSON.stringify(patch) }),
      'Metadata'
   ).metadata;
}
```

`frontend/lib/reactions.ts`:

```ts
import { z } from 'zod';
import { apiFetch } from './api';
import { parseResponse } from './parse-response';

const groupSchema = z.object({
   emoji: z.string(),
   count: z.number(),
   reactedByMe: z.boolean(),
   actorIds: z.array(z.string()),
});
export type ReactionGroup = z.infer<typeof groupSchema>;
const groupsSchema = z.object({ nodes: z.array(groupSchema) });

/** The picker's fixed set: enough to react, without an emoji catalogue. */
export const QUICK_EMOJI = ['👍', '🎉', '❤️', '👀', '🚀', '😄'] as const;

type Target = 'issue' | 'comment';
const base = (target: Target, id: string) =>
   `/api/v1/${target === 'issue' ? 'issues' : 'comments'}/${encodeURIComponent(id)}/reactions`;

export async function loadReactions(target: Target, id: string): Promise<ReactionGroup[]> {
   return parseResponse(groupsSchema, await apiFetch(base(target, id)), 'Reactions').nodes;
}

/** Adds the reaction, or removes it when the viewer already reacted with it. */
export async function toggleReaction(
   target: Target,
   id: string,
   emoji: string,
   reacted: boolean
): Promise<ReactionGroup[]> {
   const json = reacted
      ? await apiFetch(`${base(target, id)}/${encodeURIComponent(emoji)}`, { method: 'DELETE' })
      : await apiFetch(base(target, id), { method: 'POST', body: JSON.stringify({ emoji }) });
   return parseResponse(groupsSchema, json, 'Reactions').nodes;
}
```

`frontend/lib/subscribers.ts`:

```ts
import { z } from 'zod';
import { apiFetch } from './api';
import { parseResponse } from './parse-response';

const subscriberSchema = z.object({
   userId: z.string(),
   name: z.string().nullable(),
   avatarUrl: z.string().nullable(),
   reason: z.string(),
   subscribedAt: z.string(),
});
export type Subscriber = z.infer<typeof subscriberSchema>;

const path = (issueRef: string) => `/api/v1/issues/${encodeURIComponent(issueRef)}`;

export async function loadSubscribers(issueRef: string): Promise<{ nodes: Subscriber[]; subscribed: boolean }> {
   return parseResponse(
      z.object({ nodes: z.array(subscriberSchema), subscribed: z.boolean() }),
      await apiFetch(`${path(issueRef)}/subscribers`),
      'Subscribers'
   );
}

export async function setSubscription(issueRef: string, subscribed: boolean, subtree: boolean): Promise<void> {
   if (subscribed) {
      await apiFetch(`${path(issueRef)}/subscription`, { method: 'PUT', body: JSON.stringify({ subtree }) });
   } else {
      await apiFetch(`${path(issueRef)}/subscription${subtree ? '?subtree=true' : ''}`, { method: 'DELETE' });
   }
}
```

- [ ] **Step 3: Hierarchy, batch, timeline, pins, quick actions, join links**

`frontend/lib/issue-tracking.ts`:

```ts
import type { Issue } from '@/data/issues';
import { z } from 'zod';
import { apiFetch } from './api';
import { parseApiIssue } from './issues';
import { parseResponse } from './parse-response';

const path = (issueRef: string, suffix = '') => `/api/v1/issues/${encodeURIComponent(issueRef)}${suffix}`;

function issueOrThrow(json: unknown, what: string): Issue {
   const issue = parseApiIssue(json);
   if (!issue) throw new Error(`${what} response was not recognized`);
   return issue;
}

export async function loadChildren(issueRef: string): Promise<{ nodes: Issue[]; progress: { total: number; done: number } }> {
   const parsed = parseResponse(
      z.object({ nodes: z.array(z.unknown()), progress: z.object({ total: z.number(), done: z.number() }) }),
      await apiFetch(path(issueRef, '/children')),
      'Sub-tasks'
   );
   return {
      nodes: parsed.nodes.map(parseApiIssue).filter((issue): issue is Issue => issue !== undefined),
      progress: parsed.progress,
   };
}

export async function createChild(
   issueRef: string,
   input: { title?: string; fromCommentId?: string; stage?: number | null }
): Promise<Issue> {
   return issueOrThrow(await apiFetch(path(issueRef, '/children'), { method: 'POST', body: JSON.stringify(input) }), 'Sub-task');
}

export async function setParent(issueRef: string, parentId: string | null, stage: number | null): Promise<Issue> {
   return issueOrThrow(await apiFetch(path(issueRef, '/parent'), { method: 'PUT', body: JSON.stringify({ parentId, stage }) }), 'Task');
}

export async function setCustomStatus(issueRef: string, statusId: string): Promise<Issue> {
   return issueOrThrow(await apiFetch(path(issueRef, '/status'), { method: 'PUT', body: JSON.stringify({ statusId }) }), 'Task');
}

export async function moveIssue(issueRef: string, beforeId: string | null, afterId: string | null): Promise<Issue> {
   return issueOrThrow(await apiFetch(path(issueRef, '/move'), { method: 'POST', body: JSON.stringify({ beforeId, afterId }) }), 'Task');
}

export async function quickCreateIssue(input: { workspaceId: string; title: string; parentId?: string }): Promise<Issue> {
   return issueOrThrow(await apiFetch('/api/v1/issues/quick', { method: 'POST', body: JSON.stringify(input) }), 'Task');
}

const failedSchema = z.array(z.object({ id: z.string(), code: z.string() }));

export async function batchUpdateIssues(
   issueIds: string[],
   patch: { status?: string; statusId?: string; priority?: string; assignee?: { type: 'user' | 'agent'; id: string } | null }
): Promise<{ updated: string[]; failed: Array<{ id: string; code: string }> }> {
   return parseResponse(
      z.object({ updated: z.array(z.string()), failed: failedSchema }),
      await apiFetch('/api/v1/issues/batch', { method: 'POST', body: JSON.stringify({ issueIds, patch }) }),
      'Batch update'
   );
}

export async function batchDeleteIssues(
   issueIds: string[]
): Promise<{ deleted: string[]; failed: Array<{ id: string; code: string }> }> {
   return parseResponse(
      z.object({ deleted: z.array(z.string()), failed: failedSchema }),
      await apiFetch('/api/v1/issues/batch-delete', { method: 'POST', body: JSON.stringify({ issueIds }) }),
      'Batch delete'
   );
}

export async function loadAssigneeFrequency(
   workspaceId: string
): Promise<Array<{ type: string; id: string; count: number }>> {
   return parseResponse(
      z.object({ nodes: z.array(z.object({ type: z.string(), id: z.string(), count: z.number() })) }),
      await apiFetch(`/api/v1/issues/assignee-frequency?workspaceId=${encodeURIComponent(workspaceId)}`),
      'Assignee frequency'
   ).nodes;
}

export async function runQuickAction(issueRef: string, actionId: string): Promise<string> {
   return parseResponse(
      z.object({ runId: z.string() }),
      await apiFetch(path(issueRef, `/quick-actions/${encodeURIComponent(actionId)}/run`), { method: 'POST' }),
      'Quick action'
   ).runId;
}
```

`frontend/lib/activity.ts`:

```ts
import { z } from 'zod';
import { apiFetch } from './api';
import { connectionSchema } from './api-schemas';

const entrySchema = z.object({
   id: z.string(),
   type: z.string(),
   occurredAt: z.string(),
   actor: z
      .object({ type: z.string(), id: z.string(), name: z.string().nullable(), avatarUrl: z.string().nullable() })
      .nullable(),
   changedFields: z.array(z.string()),
   previousStatus: z.string().nullable(),
   status: z.string().nullable(),
   commentId: z.string().nullable(),
   details: z.record(z.unknown()),
});
export type ActivityEntry = z.infer<typeof entrySchema>;
const pageSchema = connectionSchema(entrySchema);

export async function loadIssueActivity(issueRef: string): Promise<ActivityEntry[]> {
   const collected: ActivityEntry[] = [];
   let after: string | undefined;
   for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ first: '100' });
      if (after) params.set('after', after);
      const parsed = pageSchema.safeParse(
         await apiFetch(`/api/v1/issues/${encodeURIComponent(issueRef)}/activity?${params.toString()}`)
      );
      if (!parsed.success) throw new Error('Activity response was not recognized');
      collected.push(...parsed.data.nodes);
      if (!parsed.data.pageInfo.hasNextPage || !parsed.data.pageInfo.endCursor) break;
      after = parsed.data.pageInfo.endCursor;
   }
   return collected;
}

/** One line for a timeline row; null for events the feed shows another way. */
export function describeActivity(entry: ActivityEntry): { event: string; text: string } | null {
   switch (entry.type) {
      case 'issue.created':
         return { event: 'created', text: 'created the task' };
      case 'issue.updated':
         if (entry.previousStatus && entry.status && entry.previousStatus !== entry.status) {
            return { event: 'status', text: `moved from ${entry.previousStatus} to ${entry.status}` };
         }
         return entry.changedFields.length > 0
            ? { event: 'created', text: `changed ${entry.changedFields.join(', ')}` }
            : null;
      case 'issue.properties.changed':
         return { event: 'label', text: 'changed a field' };
      case 'issue.hierarchy.changed':
         return { event: 'related', text: 'changed sub-tasks' };
      case 'comment.resolved':
         return { event: 'unblocked', text: 'resolved a thread' };
      case 'comment.unresolved':
         return { event: 'blocked', text: 'reopened a thread' };
      default:
         return null;
   }
}
```

`eventTopics` in `server-ts/src/core/issues.ts` emits `issue.created`, `issue.updated`, `issue.assigned`, `issue.started`, `issue.completed` and `issue.deleted`. A status change writes `issue.updated` plus `issue.started`/`issue.completed` for the same mutation, so only `issue.updated` is described and the companion topics fall to `default` (null), which keeps one timeline row per change.

`frontend/lib/pins.ts`:

```ts
import { z } from 'zod';
import { apiFetch } from './api';
import { parseResponse } from './parse-response';

const pinSchema = z.object({
   id: z.string(),
   targetType: z.enum(['issue', 'view', 'project']),
   targetId: z.string(),
   position: z.number(),
   title: z.string(),
   identifier: z.string().nullable(),
});
export type Pin = z.infer<typeof pinSchema>;
const pinsSchema = z.object({ nodes: z.array(pinSchema) });

export async function loadPins(workspaceId: string): Promise<Pin[]> {
   return parseResponse(pinsSchema, await apiFetch(`/api/v1/pins?workspaceId=${encodeURIComponent(workspaceId)}`), 'Pins').nodes;
}

export async function pinTarget(
   workspaceId: string,
   targetType: Pin['targetType'],
   targetId: string
): Promise<Pin> {
   return parseResponse(
      pinSchema,
      await apiFetch('/api/v1/pins', { method: 'POST', body: JSON.stringify({ workspaceId, targetType, targetId }) }),
      'Pin'
   );
}

export async function unpinTarget(workspaceId: string, pinId: string): Promise<void> {
   await apiFetch(`/api/v1/pins/${encodeURIComponent(pinId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
}

export async function reorderPins(workspaceId: string, ids: string[]): Promise<Pin[]> {
   return parseResponse(
      pinsSchema,
      await apiFetch('/api/v1/pins/order', { method: 'PUT', body: JSON.stringify({ workspaceId, ids }) }),
      'Pins'
   ).nodes;
}
```

`frontend/lib/quick-actions.ts`:

```ts
import { z } from 'zod';
import { apiFetch } from './api';
import { parseResponse } from './parse-response';

const actionSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   name: z.string(),
   description: z.string().nullable(),
   targetAgentId: z.string(),
   prompt: z.string(),
   visibility: z.enum(['private', 'workspace']),
   createdBy: z.string(),
   createdAt: z.string(),
   updatedAt: z.string(),
});
export type QuickAction = z.infer<typeof actionSchema>;

const base = (workspaceId: string) => `/api/v1/catalogs/${encodeURIComponent(workspaceId)}/quick-actions`;

export async function loadQuickActions(workspaceId: string): Promise<QuickAction[]> {
   return parseResponse(z.object({ nodes: z.array(actionSchema) }), await apiFetch(base(workspaceId)), 'Quick actions').nodes;
}

export async function createQuickAction(
   workspaceId: string,
   input: { name: string; targetAgentId: string; prompt: string; visibility: 'private' | 'workspace' }
): Promise<QuickAction> {
   return parseResponse(actionSchema, await apiFetch(base(workspaceId), { method: 'POST', body: JSON.stringify(input) }), 'Quick action');
}

export async function archiveQuickAction(workspaceId: string, actionId: string): Promise<void> {
   await apiFetch(`${base(workspaceId)}/${encodeURIComponent(actionId)}`, { method: 'DELETE' });
}
```

`frontend/lib/join-links.ts`:

```ts
import { z } from 'zod';
import { apiFetch } from './api';
import { parseResponse } from './parse-response';

const linkSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   role: z.string(),
   expiresAt: z.string().nullable(),
   maxUses: z.number().nullable(),
   useCount: z.number(),
   revokedAt: z.string().nullable(),
   createdAt: z.string(),
   createdBy: z.string(),
});
export type JoinLink = z.infer<typeof linkSchema>;

const base = (workspaceId: string) => `/api/v1/catalogs/${encodeURIComponent(workspaceId)}/join-links`;

export async function loadJoinLinks(workspaceId: string): Promise<JoinLink[]> {
   return parseResponse(z.object({ nodes: z.array(linkSchema) }), await apiFetch(base(workspaceId)), 'Join links').nodes;
}

/** The token is returned once; the caller shows it now or never. */
export async function createJoinLink(
   workspaceId: string,
   input: { role: 'admin' | 'member' | 'viewer'; expiresInDays?: number; maxUses?: number }
): Promise<JoinLink & { token: string }> {
   return parseResponse(
      linkSchema.extend({ token: z.string() }),
      await apiFetch(base(workspaceId), { method: 'POST', body: JSON.stringify(input) }),
      'Join link'
   );
}

export async function revokeJoinLink(workspaceId: string, linkId: string): Promise<void> {
   await apiFetch(`${base(workspaceId)}/${encodeURIComponent(linkId)}`, { method: 'DELETE' });
}

export async function lookupJoinLink(
   token: string
): Promise<{ workspace: { id: string; name: string }; role: string; expiresAt: string | null }> {
   return parseResponse(
      z.object({ workspace: z.object({ id: z.string(), name: z.string() }), role: z.string(), expiresAt: z.string().nullable() }),
      await apiFetch(`/api/v1/join-links/${encodeURIComponent(token)}`),
      'Join link'
   );
}

export async function acceptJoinLink(token: string): Promise<{ workspaceId: string; role: string; joined: boolean }> {
   return parseResponse(
      z.object({ workspaceId: z.string(), role: z.string(), joined: z.boolean() }),
      await apiFetch(`/api/v1/join-links/${encodeURIComponent(token)}/accept`, { method: 'POST' }),
      'Join'
   );
}

export function joinLinkUrl(token: string): string {
   return `${window.location.origin}/join/${encodeURIComponent(token)}`;
}
```

- [ ] **Step 4: Extend comments, views and settings clients**

Append to `frontend/lib/comments.ts`:

```ts
export async function updateComment(commentId: string, body: string, revision: number): Promise<ApiComment> {
   const json: unknown = await apiFetch(`/api/v1/comments/${encodeURIComponent(commentId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ body, revision }),
   });
   const parsed = commentSchema.safeParse(json);
   if (!parsed.success) throw new Error('Edit comment response was not recognized');
   return parsed.data;
}

export async function deleteComment(commentId: string): Promise<void> {
   await apiFetch(`/api/v1/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' });
}

export async function setCommentResolved(commentId: string, resolved: boolean): Promise<ApiComment> {
   const json: unknown = await apiFetch(`/api/v1/comments/${encodeURIComponent(commentId)}/resolution`, {
      method: resolved ? 'POST' : 'DELETE',
   });
   const parsed = commentSchema.safeParse(json);
   if (!parsed.success) throw new Error('Resolve comment response was not recognized');
   return parsed.data;
}
```

Append to `frontend/lib/views.ts` (and export `savedViewSchema` by changing `const savedViewSchema` to `export const savedViewSchema`):

```ts
export type SavedView = z.infer<typeof savedViewSchema>;

export async function createSavedView(input: {
   workspaceId: string;
   name: string;
   visibility: 'private' | 'workspace';
   query: Record<string, unknown>;
   display: Record<string, unknown>;
}): Promise<SavedView> {
   const parsed = savedViewSchema.safeParse(await apiFetch('/api/v1/views', { method: 'POST', body: JSON.stringify(input) }));
   if (!parsed.success) throw new Error('View response was not recognized');
   return parsed.data;
}

export async function updateSavedView(
   viewId: string,
   patch: { name?: string; visibility?: 'private' | 'workspace'; query?: Record<string, unknown>; display?: Record<string, unknown>; revision: number }
): Promise<SavedView> {
   const parsed = savedViewSchema.safeParse(
      await apiFetch(`/api/v1/views/${encodeURIComponent(viewId)}`, { method: 'PATCH', body: JSON.stringify(patch) })
   );
   if (!parsed.success) throw new Error('View response was not recognized');
   return parsed.data;
}

export async function deleteSavedView(viewId: string): Promise<void> {
   await apiFetch(`/api/v1/views/${encodeURIComponent(viewId)}`, { method: 'DELETE' });
}

const preferencesSchema = z.object({ activeViewId: z.string().nullable(), preferences: z.record(z.unknown()) });

export async function loadViewPreferences(workspaceId: string): Promise<z.infer<typeof preferencesSchema>> {
   const parsed = preferencesSchema.safeParse(
      await apiFetch(`/api/v1/views/preferences?workspaceId=${encodeURIComponent(workspaceId)}`)
   );
   if (!parsed.success) throw new Error('View preferences response was not recognized');
   return parsed.data;
}

export async function saveViewPreferences(
   workspaceId: string,
   activeViewId: string | null,
   preferences: Record<string, unknown>
): Promise<void> {
   await apiFetch('/api/v1/views/preferences', {
      method: 'PUT',
      body: JSON.stringify({ workspaceId, activeViewId, preferences }),
   });
}

const queryResultSchema = z.object({
   total: z.number(),
   groups: z.array(z.object({ key: z.string(), count: z.number(), issueIds: z.array(z.string()) })),
   facets: z.object({
      status: z.record(z.number()),
      priority: z.record(z.number()),
      assignee: z.record(z.number()),
   }),
});
export type IssueQueryResult = z.infer<typeof queryResultSchema>;

export async function queryIssues(input: {
   workspaceId: string;
   filter?: Record<string, unknown>;
   groupBy?: string | { propertyId: string };
   perGroup?: number;
}): Promise<IssueQueryResult> {
   const parsed = queryResultSchema.safeParse(
      await apiFetch('/api/v1/views/query', { method: 'POST', body: JSON.stringify(input) })
   );
   if (!parsed.success) throw new Error('Issue query response was not recognized');
   return parsed.data;
}
```

Append to the statuses section of `frontend/lib/settings.ts`:

```ts
export const STATUS_CATEGORIES = [
   'backlog',
   'todo',
   'in_progress',
   'in_review',
   'done',
   'blocked',
   'cancelled',
] as const;

export async function createStatus(
   workspaceId: string,
   input: { name: string; category: (typeof STATUS_CATEGORIES)[number]; color: string }
): Promise<WorkspaceStatus> {
   return parse(
      statusSchema,
      await apiFetch(`/api/v1/catalogs/${encodeURIComponent(workspaceId)}/issue-statuses`, {
         method: 'POST',
         body: JSON.stringify(input),
      }),
      'Status'
   );
}

export async function archiveStatus(workspaceId: string, statusId: string): Promise<void> {
   await apiFetch(
      `/api/v1/catalogs/${encodeURIComponent(workspaceId)}/issue-statuses/${encodeURIComponent(statusId)}`,
      { method: 'DELETE' }
   );
}

export async function reorderStatuses(workspaceId: string, ids: string[]): Promise<WorkspaceStatus[]> {
   return parse(
      z.object({ nodes: z.array(statusSchema) }),
      await apiFetch(`/api/v1/catalogs/${encodeURIComponent(workspaceId)}/issue-statuses/order`, {
         method: 'PUT',
         body: JSON.stringify({ ids }),
      }),
      'Statuses'
   ).nodes;
}
```

- [ ] **Step 5: Run the gates**

Run: `cd frontend && pnpm lint && pnpm build:check`
Expected: both succeed with no new warnings in the touched files.

- [ ] **Step 6: Commit**

```bash
git add frontend/lib frontend/data/issues.ts
git commit -m "feat(frontend): add work-tracking API clients"
```

---
### Task 16: Settings: properties, statuses, quick actions, join links

**Files:**
- Create: `frontend/components/common/settings/issue-properties-settings.tsx`, `frontend/components/common/settings/quick-actions-settings.tsx`, `frontend/components/common/settings/join-links-settings.tsx`
- Create: `frontend/app/[orgId]/settings/issue-properties/page.tsx`, `frontend/app/[orgId]/settings/quick-actions/page.tsx`, `frontend/app/[orgId]/settings/join-links/page.tsx`
- Modify: `frontend/components/common/settings/project-statuses-settings.tsx` (create, archive, reorder), `frontend/components/layout/sidebar/nav-settings.tsx` (three items)

**Interfaces:**
- Consumes: `lib/properties.ts`, `lib/quick-actions.ts`, `lib/join-links.ts`, `lib/settings.ts` (`createStatus`, `archiveStatus`, `reorderStatuses`, `STATUS_CATEGORIES`), `loadWorkspaceAgents` (`lib/agents.ts`), `useSettingsResource` (`components/common/settings/use-settings-resource.ts`), `useSessionStore`.
- Produces: routes `/{orgId}/settings/issue-properties`, `/{orgId}/settings/quick-actions`, `/{orgId}/settings/join-links`.

- [ ] **Step 1: Properties settings**

`frontend/components/common/settings/issue-properties-settings.tsx`:

```tsx
'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import {
   archiveProperty,
   createProperty,
   loadProperties,
   PROPERTY_KIND_LABELS,
   PROPERTY_KINDS,
   type PropertyDefinition,
   type PropertyKind,
} from '@/lib/properties';
import { useSessionStore } from '@/store/session-store';
import { useState } from 'react';
import { toast } from 'sonner';
import { useSettingsResource } from './use-settings-resource';

/**
 * Workspace task fields. Kind is fixed at creation: stored values were checked
 * against it. Options are typed as a comma list; ids are derived from names.
 */
const OPTION_COLORS = ['#6366f1', '#f97316', '#347b5a', '#9b6715', '#397caf', '#b4436c'];

function optionsFrom(raw: string) {
   return raw
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name, index) => ({
         id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `option-${index}`,
         name,
         color: OPTION_COLORS[index % OPTION_COLORS.length] ?? '#6366f1',
      }));
}

export default function IssuePropertiesSettings() {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const properties = useSettingsResource<PropertyDefinition[]>(
      () => (workspaceId ? loadProperties(workspaceId) : Promise.reject(new Error('No workspace is selected.'))),
      [workspaceId]
   );
   const [name, setName] = useState('');
   const [kind, setKind] = useState<PropertyKind>('text');
   const [options, setOptions] = useState('');
   const [creating, setCreating] = useState(false);
   const isSelect = kind === 'select' || kind === 'multi_select';

   const create = async () => {
      if (!name.trim()) return;
      setCreating(true);
      try {
         const created = await createProperty(workspaceId, {
            name: name.trim(),
            kind,
            ...(isSelect ? { options: optionsFrom(options) } : {}),
         });
         properties.set([...(properties.value ?? []), created]);
         setName('');
         setOptions('');
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : 'The field could not be created.');
      } finally {
         setCreating(false);
      }
   };

   const archive = (property: PropertyDefinition) =>
      void properties.mutate(
         (properties.value ?? []).filter((entry) => entry.id !== property.id),
         () => archiveProperty(workspaceId, property.id)
      );

   return (
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-8">
         <div>
            <h1 className="font-display text-xl">Task fields</h1>
            <p className="text-muted-foreground">Custom fields every task in this workspace can carry.</p>
         </div>
         <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex gap-2">
               <Input placeholder="Field name" value={name} onChange={(event) => setName(event.target.value)} />
               <Select value={kind} onValueChange={(value) => setKind(value as PropertyKind)}>
                  <SelectTrigger className="w-40">
                     <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                     {PROPERTY_KINDS.map((entry) => (
                        <SelectItem key={entry} value={entry}>
                           {PROPERTY_KIND_LABELS[entry]}
                        </SelectItem>
                     ))}
                  </SelectContent>
               </Select>
               <Button onClick={() => void create()} disabled={creating || !name.trim() || (isSelect && !options.trim())}>
                  Add
               </Button>
            </div>
            {isSelect ? (
               <Input
                  placeholder="Options, comma separated"
                  value={options}
                  onChange={(event) => setOptions(event.target.value)}
               />
            ) : null}
         </div>
         {properties.error ? <p role="alert" className="text-muted-foreground">{properties.error}</p> : null}
         <ul className="flex flex-col divide-y rounded-md border">
            {(properties.value ?? []).map((property) => (
               <li key={property.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 truncate">
                     {property.name}{' '}
                     <span className="text-muted-foreground">· {PROPERTY_KIND_LABELS[property.kind]}</span>
                     {property.options.length > 0 ? (
                        <span className="text-muted-foreground"> · {property.options.map((option) => option.name).join(', ')}</span>
                     ) : null}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => archive(property)}>
                     Archive
                  </Button>
               </li>
            ))}
            {!properties.loading && (properties.value ?? []).length === 0 ? (
               <li className="px-3 py-4 text-muted-foreground">No fields yet.</li>
            ) : null}
         </ul>
      </div>
   );
}
```

- [ ] **Step 2: Quick actions and join links settings**

`frontend/components/common/settings/quick-actions-settings.tsx`:

```tsx
'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { loadWorkspaceAgents, type Agent } from '@/lib/agents';
import {
   archiveQuickAction,
   createQuickAction,
   loadQuickActions,
   type QuickAction,
} from '@/lib/quick-actions';
import { useSessionStore } from '@/store/session-store';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useSettingsResource } from './use-settings-resource';

/**
 * Prompt templates run on a task as an agent task. `{{issue.identifier}}`,
 * `{{issue.title}}` and `{{issue.description}}` are filled in when run.
 */
export default function QuickActionsSettings() {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const actions = useSettingsResource<QuickAction[]>(
      () => (workspaceId ? loadQuickActions(workspaceId) : Promise.reject(new Error('No workspace is selected.'))),
      [workspaceId]
   );
   const [agents, setAgents] = useState<Agent[]>([]);
   const [name, setName] = useState('');
   const [agentId, setAgentId] = useState('');
   const [prompt, setPrompt] = useState('');
   const [visibility, setVisibility] = useState<'private' | 'workspace'>('workspace');

   useEffect(() => {
      void loadWorkspaceAgents()
         .then(setAgents)
         .catch(() => setAgents([]));
   }, []);

   const create = async () => {
      try {
         const created = await createQuickAction(workspaceId, { name: name.trim(), targetAgentId: agentId, prompt, visibility });
         actions.set([...(actions.value ?? []), created]);
         setName('');
         setPrompt('');
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : 'The quick action could not be created.');
      }
   };

   return (
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-8">
         <div>
            <h1 className="font-display text-xl">Quick actions</h1>
            <p className="text-muted-foreground">
               Saved prompts an agent runs on a task. Use {'{{issue.title}}'}, {'{{issue.identifier}}'} and{' '}
               {'{{issue.description}}'}.
            </p>
         </div>
         <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex gap-2">
               <Input placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} />
               <Select value={agentId} onValueChange={setAgentId}>
                  <SelectTrigger className="w-48">
                     <SelectValue placeholder="Agent" />
                  </SelectTrigger>
                  <SelectContent>
                     {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                           {agent.name}
                        </SelectItem>
                     ))}
                  </SelectContent>
               </Select>
               <Select value={visibility} onValueChange={(value) => setVisibility(value as 'private' | 'workspace')}>
                  <SelectTrigger className="w-36">
                     <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                     <SelectItem value="workspace">Workspace</SelectItem>
                     <SelectItem value="private">Only me</SelectItem>
                  </SelectContent>
               </Select>
            </div>
            <Textarea placeholder="Prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} />
            <Button className="self-end" onClick={() => void create()} disabled={!name.trim() || !agentId || !prompt.trim()}>
               Add
            </Button>
         </div>
         {actions.error ? <p role="alert" className="text-muted-foreground">{actions.error}</p> : null}
         <ul className="flex flex-col divide-y rounded-md border">
            {(actions.value ?? []).map((action) => (
               <li key={action.id} className="flex items-start justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                     <div>
                        {action.name}{' '}
                        <span className="text-muted-foreground">
                           · {agents.find((agent) => agent.id === action.targetAgentId)?.name ?? 'Agent'} ·{' '}
                           {action.visibility === 'private' ? 'only me' : 'workspace'}
                        </span>
                     </div>
                     <p className="truncate text-muted-foreground">{action.prompt}</p>
                  </div>
                  <Button
                     variant="ghost"
                     size="sm"
                     onClick={() =>
                        void actions.mutate(
                           (actions.value ?? []).filter((entry) => entry.id !== action.id),
                           () => archiveQuickAction(workspaceId, action.id)
                        )
                     }
                  >
                     Archive
                  </Button>
               </li>
            ))}
         </ul>
      </div>
   );
}
```

`frontend/components/common/settings/join-links-settings.tsx`:

```tsx
'use client';

import { Button } from '@/components/ui/button';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { createJoinLink, joinLinkUrl, loadJoinLinks, revokeJoinLink, type JoinLink } from '@/lib/join-links';
import { useSessionStore } from '@/store/session-store';
import { useState } from 'react';
import { toast } from 'sonner';
import { useSettingsResource } from './use-settings-resource';

/**
 * Shareable join links. The link itself is shown once, right after creation:
 * the server keeps only a hash, so a lost link is revoked and replaced.
 */
export default function JoinLinksSettings() {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const links = useSettingsResource<JoinLink[]>(
      () => (workspaceId ? loadJoinLinks(workspaceId) : Promise.reject(new Error('No workspace is selected.'))),
      [workspaceId]
   );
   const [role, setRole] = useState<'admin' | 'member' | 'viewer'>('member');
   const [expiry, setExpiry] = useState('7');
   const [fresh, setFresh] = useState<string | null>(null);

   const create = async () => {
      try {
         const created = await createJoinLink(workspaceId, {
            role,
            ...(expiry === 'never' ? {} : { expiresInDays: Number(expiry) }),
         });
         links.set([created, ...(links.value ?? [])]);
         setFresh(joinLinkUrl(created.token));
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : 'The link could not be created.');
      }
   };

   const copy = async (url: string) => {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
   };

   const state = (link: JoinLink) =>
      link.revokedAt
         ? 'revoked'
         : link.expiresAt && new Date(link.expiresAt) < new Date()
           ? 'expired'
           : link.maxUses !== null && link.useCount >= link.maxUses
             ? 'used up'
             : 'active';

   return (
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-8">
         <div>
            <h1 className="font-display text-xl">Join links</h1>
            <p className="text-muted-foreground">Anyone with a link can join this workspace at its role.</p>
         </div>
         <div className="flex gap-2 rounded-md border p-3">
            <Select value={role} onValueChange={(value) => setRole(value as 'admin' | 'member' | 'viewer')}>
               <SelectTrigger className="w-36">
                  <SelectValue />
               </SelectTrigger>
               <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="viewer">Viewer</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
               </SelectContent>
            </Select>
            <Select value={expiry} onValueChange={setExpiry}>
               <SelectTrigger className="w-40">
                  <SelectValue />
               </SelectTrigger>
               <SelectContent>
                  <SelectItem value="1">Expires in 1 day</SelectItem>
                  <SelectItem value="7">Expires in 7 days</SelectItem>
                  <SelectItem value="30">Expires in 30 days</SelectItem>
                  <SelectItem value="never">Never expires</SelectItem>
               </SelectContent>
            </Select>
            <Button onClick={() => void create()}>Create link</Button>
         </div>
         {fresh ? (
            <div className="flex items-center gap-2 rounded-md border border-dashed p-3">
               <code className="min-w-0 flex-1 truncate">{fresh}</code>
               <Button size="sm" variant="secondary" onClick={() => void copy(fresh)}>
                  Copy
               </Button>
            </div>
         ) : null}
         {links.error ? <p role="alert" className="text-muted-foreground">{links.error}</p> : null}
         <ul className="flex flex-col divide-y rounded-md border">
            {(links.value ?? []).map((link) => (
               <li key={link.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span>
                     {link.role} <span className="text-muted-foreground">· {state(link)} · used {link.useCount}</span>
                  </span>
                  {state(link) === 'active' ? (
                     <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                           void links.mutate(
                              (links.value ?? []).map((entry) =>
                                 entry.id === link.id ? { ...entry, revokedAt: new Date().toISOString() } : entry
                              ),
                              () => revokeJoinLink(workspaceId, link.id)
                           )
                        }
                     >
                        Revoke
                     </Button>
                  ) : null}
               </li>
            ))}
         </ul>
      </div>
   );
}
```

- [ ] **Step 3: Pages and navigation**

Each page mirrors `frontend/app/[orgId]/settings/issue-labels/page.tsx`. For example, `frontend/app/[orgId]/settings/issue-properties/page.tsx`:

```tsx
import IssuePropertiesSettings from '@/components/common/settings/issue-properties-settings';
import Header from '@/components/layout/headers/settings/header';
import MainLayout from '@/components/layout/main-layout';

export default function Page() {
   return (
      <MainLayout header={<Header />} headersNumber={1}>
         <IssuePropertiesSettings />
      </MainLayout>
   );
}
```

`quick-actions/page.tsx` is identical except it imports and renders `QuickActionsSettings` from `@/components/common/settings/quick-actions-settings`. `join-links/page.tsx` does the same with `JoinLinksSettings` from `@/components/common/settings/join-links-settings`.

In `frontend/components/layout/sidebar/nav-settings.tsx`, add `Link2`, `ListChecks`, `Zap` to the `lucide-react` import and append to the `workspace` group's `items`:

```ts
         { name: 'task fields', url: '/settings/issue-properties', icon: ListChecks },
         { name: 'quick actions', url: '/settings/quick-actions', icon: Zap },
         { name: 'join links', url: '/settings/join-links', icon: Link2 },
```

- [ ] **Step 4: Statuses: create, archive, reorder**

In `project-statuses-settings.tsx`, import `archiveStatus`, `createStatus`, `reorderStatuses`, `STATUS_CATEGORIES` from `@/lib/settings`, and `Button`, `Select*` from `@/components/ui`. Add these handlers inside the component:

```tsx
   const [newName, setNewName] = useState('');
   const [newCategory, setNewCategory] = useState<(typeof STATUS_CATEGORIES)[number]>('in_review');

   const add = async () => {
      if (!newName.trim()) return;
      try {
         const created = await createStatus(workspaceId, { name: newName.trim(), category: newCategory, color: '#8b5cf6' });
         statuses.set([...(statuses.value ?? []), created].sort((a, b) => a.sortOrder - b.sortOrder));
         setNewName('');
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : 'The status could not be created.');
      }
   };

   const archive = (status: WorkspaceStatus) =>
      void statuses.mutate(
         (statuses.value ?? []).filter((entry) => entry.id !== status.id),
         () => archiveStatus(workspaceId, status.id)
      );

   const move = (index: number, delta: -1 | 1) => {
      const list = [...(statuses.value ?? [])];
      const target = index + delta;
      const current = list[index];
      const other = list[target];
      if (!current || !other) return;
      list[index] = other;
      list[target] = current;
      void statuses.mutate(list, () => reorderStatuses(workspaceId, list.map((entry) => entry.id)));
   };
```

Render, above the existing task-status list, a row with an `Input` (`value={newName}`), a `Select` over `STATUS_CATEGORIES` (label each by replacing `_` with a space), and a `Button` "Add status" calling `add`. In each task-status row add two `Button variant="ghost" size="icon"` controls (`↑` → `move(index, -1)`, `↓` → `move(index, 1)`), plus an "Archive" `Button` shown only when `!status.isSystem`. Add `useState` to the React import and `toast` from `sonner` if they are not already imported.

- [ ] **Step 5: Run the gates and check the pages**

Run: `cd frontend && pnpm lint && pnpm build:check`
Expected: both succeed.

Manual check (`pnpm dev:frontend` against a server with Task 14):
- Settings shows "task fields", "quick actions" and "join links".
- Creating a select field with options lists it.
- A new "QA" status in the in_review category appears and moves with ↑/↓.
- A built-in status has no Archive button.
- Creating a join link shows a copyable URL once.

- [ ] **Step 6: Commit**

```bash
git add "frontend/app/[orgId]/settings/issue-properties" "frontend/app/[orgId]/settings/quick-actions" "frontend/app/[orgId]/settings/join-links" frontend/components/common/settings frontend/components/layout/sidebar/nav-settings.tsx
git commit -m "feat(frontend): manage task fields, statuses, quick actions and join links in settings"
```

---

### Task 17: Issue detail: fields, reactions, subscription, sub-tasks, quick actions, custom status

**Files:**
- Create: `frontend/components/common/issues/details/issue-custom-properties.tsx`, `issue-reactions.tsx`, `issue-subscription.tsx`, `sub-issues.tsx`, `issue-quick-actions.tsx`, `custom-status-select.tsx` (all in `frontend/components/common/issues/details/`)
- Modify: `frontend/components/common/issues/details/issue-details.tsx`, `frontend/components/common/issues/details/issue-properties-panel.tsx`

**Interfaces:**
- Consumes: the Task 15 clients; `Section` from `./panel-section`; `useIssuesStore().updateIssue(id, partial)`; `loadWorkspaceMembers(workspaceId)` from `lib/members.ts`; `loadStatuses` from `lib/settings.ts`.
- Produces: components `IssueCustomProperties({ issueRef })`, `IssueReactions({ issueRef })`, `IssueSubscription({ issueRef })`, `SubIssues({ issue })`, `IssueQuickActions({ issueRef })`, `CustomStatusSelect({ issue })`.

- [ ] **Step 1: Reactions and subscription**

`issue-reactions.tsx`:

```tsx
'use client';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { loadReactions, QUICK_EMOJI, toggleReaction, type ReactionGroup } from '@/lib/reactions';
import { cn } from '@/lib/utils';
import { SmilePlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

/** Reaction chips for a task or a comment, plus a small picker. */
export function ReactionBar({ target, id }: { target: 'issue' | 'comment'; id: string }) {
   const [groups, setGroups] = useState<ReactionGroup[]>([]);

   useEffect(() => {
      if (!id) return;
      let cancelled = false;
      void loadReactions(target, id)
         .then((loaded) => !cancelled && setGroups(loaded))
         .catch(() => undefined);
      return () => {
         cancelled = true;
      };
   }, [target, id]);

   const toggle = (emoji: string) => {
      const reacted = groups.find((group) => group.emoji === emoji)?.reactedByMe ?? false;
      void toggleReaction(target, id, emoji, reacted)
         .then(setGroups)
         .catch(() => toast.error('The reaction could not be saved.'));
   };

   return (
      <div className="flex flex-wrap items-center gap-1.5">
         {groups.map((group) => (
            <button
               key={group.emoji}
               type="button"
               onClick={() => toggle(group.emoji)}
               aria-pressed={group.reactedByMe}
               className={cn(
                  'inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5',
                  group.reactedByMe ? 'bg-accent' : 'bg-transparent'
               )}
            >
               {group.emoji} {group.count}
            </button>
         ))}
         <Popover>
            <PopoverTrigger asChild>
               <Button variant="ghost" size="icon" className="size-7" aria-label="Add reaction">
                  <SmilePlus className="size-4" />
               </Button>
            </PopoverTrigger>
            <PopoverContent className="flex w-auto gap-1 p-1.5" align="start">
               {QUICK_EMOJI.map((emoji) => (
                  <button key={emoji} type="button" className="rounded px-1.5 py-1 hover:bg-accent" onClick={() => toggle(emoji)}>
                     {emoji}
                  </button>
               ))}
            </PopoverContent>
         </Popover>
      </div>
   );
}

export function IssueReactions({ issueRef }: { issueRef: string }) {
   return <ReactionBar target="issue" id={issueRef} />;
}
```

`issue-subscription.tsx`:

```tsx
'use client';

import { Button } from '@/components/ui/button';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { loadSubscribers, setSubscription, type Subscriber } from '@/lib/subscribers';
import { Bell, BellOff, ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

/** Follow a task (and optionally its sub-tasks) so its changes reach the inbox. */
export function IssueSubscription({ issueRef }: { issueRef: string }) {
   const [state, setState] = useState<{ nodes: Subscriber[]; subscribed: boolean }>({ nodes: [], subscribed: false });

   const reload = useCallback(() => {
      void loadSubscribers(issueRef)
         .then(setState)
         .catch(() => undefined);
   }, [issueRef]);
   useEffect(reload, [reload]);

   const change = (subscribed: boolean, subtree: boolean) =>
      void setSubscription(issueRef, subscribed, subtree)
         .then(reload)
         .catch(() => toast.error('The subscription could not be changed.'));

   return (
      <div className="flex items-center gap-1">
         <Button variant="outline" size="sm" onClick={() => change(!state.subscribed, false)}>
            {state.subscribed ? <BellOff className="mr-1 size-3.5" /> : <Bell className="mr-1 size-3.5" />}
            {state.subscribed ? 'Unsubscribe' : 'Subscribe'}
         </Button>
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <Button variant="ghost" size="icon" className="size-8" aria-label="Subscription options">
                  <ChevronDown className="size-3.5" />
               </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
               <DropdownMenuItem onClick={() => change(true, true)}>Subscribe to all sub-tasks</DropdownMenuItem>
               <DropdownMenuItem onClick={() => change(false, true)}>Unsubscribe from all sub-tasks</DropdownMenuItem>
            </DropdownMenuContent>
         </DropdownMenu>
         <span className="text-muted-foreground">{state.nodes.length} following</span>
      </div>
   );
}
```

- [ ] **Step 2: Custom fields editor**

`issue-custom-properties.tsx`:

```tsx
'use client';

import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import type { User } from '@/data/users';
import { loadWorkspaceMembers } from '@/lib/members';
import {
   clearIssueProperty,
   loadIssueProperties,
   loadProperties,
   setIssueProperty,
   type PropertyDefinition,
} from '@/lib/properties';
import { useSessionStore } from '@/store/session-store';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Section } from './panel-section';

type Person = { type: 'user' | 'agent'; id: string };
const NONE = '__none__';

/** The workspace's custom fields on this task, each edited in place. */
export function IssueCustomProperties({ issueRef }: { issueRef: string }) {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [definitions, setDefinitions] = useState<PropertyDefinition[]>([]);
   const [values, setValues] = useState<Record<string, unknown>>({});
   const [members, setMembers] = useState<User[]>([]);

   useEffect(() => {
      if (!workspaceId || !issueRef) return;
      let cancelled = false;
      void Promise.all([loadProperties(workspaceId), loadIssueProperties(issueRef), loadWorkspaceMembers(workspaceId)])
         .then(([defs, current, people]) => {
            if (cancelled) return;
            setDefinitions(defs);
            setValues(Object.fromEntries(current.map((entry) => [entry.propertyId, entry.value])));
            setMembers(people);
         })
         .catch(() => undefined);
      return () => {
         cancelled = true;
      };
   }, [workspaceId, issueRef]);

   const save = (propertyId: string, value: unknown) => {
      const previous = values[propertyId];
      setValues((current) => ({ ...current, [propertyId]: value }));
      const write =
         value === null || value === '' || (Array.isArray(value) && value.length === 0)
            ? clearIssueProperty(issueRef, propertyId)
            : setIssueProperty(issueRef, propertyId, value);
      void write.catch((cause: unknown) => {
         setValues((current) => ({ ...current, [propertyId]: previous }));
         toast.error(cause instanceof Error ? cause.message : 'The field could not be saved.');
      });
   };

   if (definitions.length === 0) return null;

   return (
      <Section title="Fields">
         <div className="flex flex-col gap-2">
            {definitions.map((definition) => {
               const value = values[definition.id];
               return (
                  <label key={definition.id} className="flex items-center justify-between gap-2">
                     <span className="shrink-0 text-muted-foreground">{definition.name}</span>
                     <FieldEditor definition={definition} value={value} members={members} onChange={(next) => save(definition.id, next)} />
                  </label>
               );
            })}
         </div>
      </Section>
   );
}

function FieldEditor({
   definition,
   value,
   members,
   onChange,
}: {
   definition: PropertyDefinition;
   value: unknown;
   members: User[];
   onChange: (next: unknown) => void;
}) {
   switch (definition.kind) {
      case 'boolean':
         return <Checkbox checked={value === true} onCheckedChange={(checked) => onChange(checked === true)} />;
      case 'number':
         return (
            <Input
               type="number"
               className="h-7 w-32"
               defaultValue={typeof value === 'number' ? value : ''}
               onBlur={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
            />
         );
      case 'date':
         return (
            <Input
               type="date"
               className="h-7 w-36"
               defaultValue={typeof value === 'string' ? value : ''}
               onChange={(event) => onChange(event.target.value || null)}
            />
         );
      case 'select':
         return (
            <Select value={typeof value === 'string' ? value : NONE} onValueChange={(next) => onChange(next === NONE ? null : next)}>
               <SelectTrigger className="h-7 w-36">
                  <SelectValue />
               </SelectTrigger>
               <SelectContent>
                  <SelectItem value={NONE}>None</SelectItem>
                  {definition.options.map((option) => (
                     <SelectItem key={option.id} value={option.id}>
                        {option.name}
                     </SelectItem>
                  ))}
               </SelectContent>
            </Select>
         );
      case 'multi_select': {
         const selected = Array.isArray(value) ? (value as string[]) : [];
         return (
            <div className="flex flex-wrap justify-end gap-1">
               {definition.options.map((option) => {
                  const on = selected.includes(option.id);
                  return (
                     <button
                        key={option.id}
                        type="button"
                        aria-pressed={on}
                        className="rounded-full border px-2 py-0.5"
                        style={on ? { borderColor: option.color, color: option.color } : undefined}
                        onClick={() => onChange(on ? selected.filter((id) => id !== option.id) : [...selected, option.id])}
                     >
                        {option.name}
                     </button>
                  );
               })}
            </div>
         );
      }
      case 'person':
      case 'multi_person': {
         const people = definition.kind === 'person' ? (value ? [value as Person] : []) : ((value as Person[] | undefined) ?? []);
         const first = people[0];
         return (
            <Select
               value={first?.id ?? NONE}
               onValueChange={(next) => {
                  const person: Person | null = next === NONE ? null : { type: 'user', id: next };
                  if (definition.kind === 'person') onChange(person);
                  else onChange(person ? [...people.filter((entry) => entry.id !== person.id), person] : []);
               }}
            >
               <SelectTrigger className="h-7 w-40">
                  <SelectValue />
               </SelectTrigger>
               <SelectContent>
                  <SelectItem value={NONE}>Nobody</SelectItem>
                  {members.map((member) => (
                     <SelectItem key={member.id} value={member.id}>
                        {member.name}
                     </SelectItem>
                  ))}
               </SelectContent>
            </Select>
         );
      }
      default:
         return (
            <Input
               className="h-7 w-40"
               type={definition.kind === 'url' ? 'url' : 'text'}
               defaultValue={typeof value === 'string' ? value : ''}
               onBlur={(event) => onChange(event.target.value.trim() || null)}
            />
         );
   }
}
```

- [ ] **Step 3: Sub-tasks, quick actions, custom status**

`sub-issues.tsx`:

```tsx
'use client';

import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import type { Issue } from '@/data/issues';
import { createChild, loadChildren } from '@/lib/issue-tracking';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

/** Children with their stage, a progress bar, and an inline add. */
export function SubIssues({ issue }: { issue: Issue }) {
   const { orgId } = useParams<{ orgId: string }>();
   const [children, setChildren] = useState<Issue[]>([]);
   const [progress, setProgress] = useState({ total: 0, done: 0 });
   const [title, setTitle] = useState('');
   const [stage, setStage] = useState('');

   const reload = useCallback(() => {
      void loadChildren(issue.identifier)
         .then((loaded) => {
            setChildren(loaded.nodes);
            setProgress(loaded.progress);
         })
         .catch(() => undefined);
   }, [issue.identifier]);
   useEffect(reload, [reload]);

   const add = () => {
      if (!title.trim()) return;
      void createChild(issue.identifier, { title: title.trim(), stage: stage === '' ? null : Number(stage) })
         .then(() => {
            setTitle('');
            reload();
         })
         .catch(() => toast.error('The sub-task could not be created.'));
   };

   return (
      <div className="mt-6 flex flex-col gap-2">
         <div className="flex items-center justify-between">
            <span className="font-medium uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">sub-tasks</span>
            {progress.total > 0 ? (
               <span className="text-muted-foreground">
                  {progress.done}/{progress.total}
               </span>
            ) : null}
         </div>
         {progress.total > 0 ? <Progress value={(progress.done / progress.total) * 100} /> : null}
         <ul className="flex flex-col">
            {children.map((child) => (
               <li key={child.id} className="flex items-center gap-2 py-1">
                  {child.stage !== null && child.stage !== undefined ? (
                     <span className="rounded bg-accent px-1.5 text-muted-foreground">stage {child.stage}</span>
                  ) : null}
                  <span className="text-muted-foreground">{child.identifier}</span>
                  <Link className="min-w-0 truncate hover:underline" href={`/${orgId}/issue/${child.identifier}`}>
                     {child.title}
                  </Link>
                  <span className="ml-auto text-muted-foreground">{child.status.name}</span>
               </li>
            ))}
         </ul>
         <div className="flex gap-2">
            <Input
               placeholder="Add a sub-task"
               value={title}
               onChange={(event) => setTitle(event.target.value)}
               onKeyDown={(event) => event.key === 'Enter' && add()}
            />
            <Input
               className="w-24"
               type="number"
               min={0}
               placeholder="Stage"
               value={stage}
               onChange={(event) => setStage(event.target.value)}
            />
         </div>
      </div>
   );
}
```

`issue-quick-actions.tsx`:

```tsx
'use client';

import { Button } from '@/components/ui/button';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { BerryApiError } from '@/lib/api';
import { runQuickAction } from '@/lib/issue-tracking';
import { loadQuickActions, type QuickAction } from '@/lib/quick-actions';
import { useSessionStore } from '@/store/session-store';
import { Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

/** Run a saved prompt on this task as an agent task. */
export function IssueQuickActions({ issueRef }: { issueRef: string }) {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [actions, setActions] = useState<QuickAction[]>([]);

   useEffect(() => {
      if (!workspaceId) return;
      void loadQuickActions(workspaceId)
         .then(setActions)
         .catch(() => setActions([]));
   }, [workspaceId]);

   if (actions.length === 0) return null;

   const run = (action: QuickAction) =>
      void runQuickAction(issueRef, action.id)
         .then(() => toast.success(`${action.name} started`))
         .catch((cause: unknown) =>
            toast.error(
               cause instanceof BerryApiError && cause.status === 503
                  ? 'Agent runtime is not available on this server.'
                  : `${action.name} could not start.`
            )
         );

   return (
      <DropdownMenu>
         <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
               <Zap className="mr-1 size-3.5" />
               Quick action
            </Button>
         </DropdownMenuTrigger>
         <DropdownMenuContent align="end">
            {actions.map((action) => (
               <DropdownMenuItem key={action.id} onClick={() => run(action)}>
                  {action.name}
               </DropdownMenuItem>
            ))}
         </DropdownMenuContent>
      </DropdownMenu>
   );
}
```

`custom-status-select.tsx`:

```tsx
'use client';

import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import type { Issue } from '@/data/issues';
import { describePatchFailure } from '@/lib/issues';
import { setCustomStatus } from '@/lib/issue-tracking';
import { loadStatuses, type WorkspaceStatus } from '@/lib/settings';
import { useIssuesStore } from '@/store/issues-store';
import { useSessionStore } from '@/store/session-store';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

/**
 * The workspace's named statuses. Choosing one also moves the task to that
 * status's category, which is what the board and the review gate read.
 */
export function CustomStatusSelect({ issue }: { issue: Issue }) {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const updateIssue = useIssuesStore((state) => state.updateIssue);
   const [statuses, setStatuses] = useState<WorkspaceStatus[]>([]);

   useEffect(() => {
      if (!workspaceId) return;
      void loadStatuses(workspaceId)
         .then(setStatuses)
         .catch(() => setStatuses([]));
   }, [workspaceId]);

   if (!statuses.some((status) => !status.isSystem)) return null;

   return (
      <Select
         value={issue.statusId ?? ''}
         onValueChange={(statusId) =>
            void setCustomStatus(issue.identifier, statusId)
               .then((updated) => updateIssue(issue.id, updated))
               .catch((cause: unknown) => toast.error(describePatchFailure(cause)))
         }
      >
         <SelectTrigger className="h-7">
            <SelectValue placeholder="Named status" />
         </SelectTrigger>
         <SelectContent>
            {statuses.map((status) => (
               <SelectItem key={status.id} value={status.id}>
                  {status.name}
               </SelectItem>
            ))}
         </SelectContent>
      </Select>
   );
}
```

- [ ] **Step 4: Place them**

In `issue-details.tsx`:
- Import `IssueReactions`, `SubIssues`, `IssueSubscription`, `IssueQuickActions`.
- Directly after the `<h1>` title add:

```tsx
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                     <IssueReactions issueRef={issue.identifier} />
                     <div className="ml-auto flex items-center gap-2">
                        <IssueQuickActions issueRef={issue.identifier} />
                        <IssueSubscription issueRef={issue.identifier} />
                     </div>
                  </div>
```

- After `<IssueDescriptionEditor ... />` add `<SubIssues issue={issue} />`.

In `issue-properties-panel.tsx`:
- Import `CustomStatusSelect` and `IssueCustomProperties`.
- Inside the Properties section, right after the `StatusSelector` row, add `<CustomStatusSelect issue={issue} />`.
- After the Properties `</Section>` add `<IssueCustomProperties issueRef={issue.identifier} />`.

- [ ] **Step 5: Run the gates and check the page**

Run: `cd frontend && pnpm lint && pnpm build:check`
Expected: both succeed.

Manual check on a task page:
- Reactions toggle and persist across a reload.
- Subscribe flips to Unsubscribe.
- A sub-task added with stage 1 shows under "sub-tasks", and the progress count changes when it moves to done.
- A select field saves.
- Choosing a custom "QA" status moves the task into review.

- [ ] **Step 6: Commit**

```bash
git add frontend/components/common/issues/details
git commit -m "feat(frontend): show fields, reactions, subscription, sub-tasks and quick actions on a task"
```

---
### Task 18: Comments: edit, delete, resolve, react, split into a sub-task; timeline events

**Files:**
- Create: `frontend/components/common/issues/details/comment-actions.tsx`
- Modify: `frontend/data/issue-details.ts` (comment variant of `ActivityItem`), `frontend/lib/comments.ts` (`commentToActivityItem`), `frontend/components/common/issues/details/activity-feed.tsx`, `frontend/components/common/issues/details/issue-details.tsx`

**Interfaces:**
- Consumes: `updateComment`, `deleteComment`, `setCommentResolved` (Task 15), `createChild`, `loadIssueActivity`, `describeActivity`, `ReactionBar` (Task 17).
- Produces: the `ActivityItem` comment variant gains `comment?: ApiComment`. `useIssueActivity` returns `replaceComment(comment: ApiComment)` and `removeComment(commentId: string)`. `ActivityFeedList` takes optional `issueRef`, `onCommentChanged`, `onCommentDeleted`. `CommentActions({ comment, issueRef, onChanged, onDeleted })`.

- [ ] **Step 1: Carry the raw comment on the activity item**

In `frontend/data/issue-details.ts`, add `import type { ApiComment } from '@/lib/comments';` and, in the `kind: 'comment'` variant, after `reactions?`:

```ts
        /** The server comment, when the item came from the API; enables actions. */
        comment?: ApiComment;
```

In `frontend/lib/comments.ts` `commentToActivityItem`, add `comment,` to the returned object, and render a resolved thread's body unchanged (resolution shows as a badge in the card).

- [ ] **Step 2: Comment actions**

`comment-actions.tsx`:

```tsx
'use client';

import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogContent,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { BerryApiError } from '@/lib/api';
import { deleteComment, setCommentResolved, updateComment, type ApiComment } from '@/lib/comments';
import { createChild } from '@/lib/issue-tracking';
import { useSessionStore } from '@/store/session-store';
import { MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

/**
 * What a reader can do with one comment. Edit and delete follow the server's
 * rule (author, or an owner/admin); the menu offers them to the author and lets
 * the server refuse anyone else with a message.
 */
export function CommentActions({
   comment,
   issueRef,
   onChanged,
   onDeleted,
}: {
   comment: ApiComment;
   issueRef: string;
   onChanged: (comment: ApiComment) => void;
   onDeleted: (commentId: string) => void;
}) {
   const userId = useSessionStore((state) => state.user?.id ?? '');
   const [editing, setEditing] = useState(false);
   const [draft, setDraft] = useState(comment.body);
   const isRoot = !comment.parentId;
   const mine = comment.author.type === 'user' && comment.author.id === userId;

   const fail = (cause: unknown, fallback: string) =>
      toast.error(
         cause instanceof BerryApiError && cause.status === 409
            ? 'This comment changed since you opened it. Reload and try again.'
            : cause instanceof BerryApiError && cause.status === 403
              ? 'You cannot change this comment.'
              : fallback
      );

   const save = () =>
      void updateComment(comment.id, draft, comment.revision)
         .then((updated) => {
            onChanged(updated);
            setEditing(false);
         })
         .catch((cause: unknown) => fail(cause, 'The comment could not be saved.'));

   const remove = () => {
      if (!window.confirm('Delete this comment?')) return;
      void deleteComment(comment.id)
         .then(() => onDeleted(comment.id))
         .catch((cause: unknown) => fail(cause, 'The comment could not be deleted.'));
   };

   const resolve = () =>
      void setCommentResolved(comment.id, !comment.resolvedAt)
         .then(onChanged)
         .catch((cause: unknown) => fail(cause, 'The thread could not be updated.'));

   const split = () =>
      void createChild(issueRef, { fromCommentId: comment.id })
         .then((child) => toast.success(`${child.identifier} created from this comment`))
         .catch(() => toast.error('The sub-task could not be created.'));

   return (
      <>
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <Button variant="ghost" size="icon" className="ml-auto size-6" aria-label="Comment actions">
                  <MoreHorizontal className="size-4" />
               </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
               {isRoot ? (
                  <DropdownMenuItem onClick={resolve}>{comment.resolvedAt ? 'Reopen thread' : 'Resolve thread'}</DropdownMenuItem>
               ) : null}
               <DropdownMenuItem onClick={split}>Create sub-task from comment</DropdownMenuItem>
               {mine ? (
                  <>
                     <DropdownMenuSeparator />
                     <DropdownMenuItem
                        onClick={() => {
                           setDraft(comment.body);
                           setEditing(true);
                        }}
                     >
                        Edit
                     </DropdownMenuItem>
                     <DropdownMenuItem onClick={remove}>Delete</DropdownMenuItem>
                  </>
               ) : null}
            </DropdownMenuContent>
         </DropdownMenu>
         <Dialog open={editing} onOpenChange={setEditing}>
            <DialogContent>
               <DialogHeader>
                  <DialogTitle>Edit comment</DialogTitle>
               </DialogHeader>
               <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={6} />
               <DialogFooter>
                  <Button variant="ghost" onClick={() => setEditing(false)}>
                     Cancel
                  </Button>
                  <Button onClick={save} disabled={!draft.trim() || draft === comment.body}>
                     Save
                  </Button>
               </DialogFooter>
            </DialogContent>
         </Dialog>
      </>
   );
}
```

- [ ] **Step 3: Wire into the feed**

In `activity-feed.tsx`:

1. Import `CommentActions` from `./comment-actions`, `ReactionBar` from `./issue-reactions`, `loadIssueActivity` and `describeActivity` from `@/lib/activity`, and `commentToActivityItem` plus `type ApiComment` from `@/lib/comments`.

2. Change `CommentCard` to take `{ item, issueRef, onChanged, onDeleted }` (the callbacks optional). In its header row, after the `timeAgo` span, add:

```tsx
            {item.comment?.resolvedAt ? (
               <span className="rounded bg-accent px-1.5 text-muted-foreground">resolved</span>
            ) : null}
            {item.comment && issueRef && onChanged && onDeleted ? (
               <CommentActions comment={item.comment} issueRef={issueRef} onChanged={onChanged} onDeleted={onDeleted} />
            ) : null}
```

   Replace the static `item.reactions` block with:

```tsx
         {item.comment ? (
            <div className="mt-1">
               <ReactionBar target="comment" id={item.comment.id} />
            </div>
         ) : null}
```

3. In `useIssueActivity`, add `loadIssueActivity(issueRef).catch(() => [])` as a third element of the `Promise.all`, destructure it as `activity`, and build event items:

```ts
         const eventItems = activity.flatMap((entry) => {
            const described = describeActivity(entry);
            if (!described || !entry.actor) return [];
            return [
               {
                  item: {
                     kind: 'event' as const,
                     id: entry.id,
                     actor: toUiUser({
                        id: entry.actor.id,
                        name: entry.actor.name ?? 'Someone',
                        avatarUrl: entry.actor.avatarUrl ?? '',
                        type: entry.actor.type === 'agent' ? 'agent' : 'user',
                     }),
                     event: described.event,
                     text: described.text,
                     timeAgo: formatDistanceToNow(parseISO(entry.occurredAt), { addSuffix: true }),
                  },
                  at: entry.occurredAt,
               },
            ];
         });
         const merged = [...commentItems, ...runItems, ...eventItems].sort((left, right) =>
            left.at.localeCompare(right.at)
         );
```

   Import `formatDistanceToNow` and `parseISO` from `date-fns`. `toUiUser` (`lib/catalog.ts`) accepts `{ id, name, avatarUrl?, email?, type? }`, so the call above type-checks as written. Then add, before the `return`:

```ts
   const replaceComment = useCallback((comment: ApiComment) => {
      setItems((previous) =>
         previous.map((item) => (item.kind === 'comment' && item.id === comment.id ? commentToActivityItem(comment) : item))
      );
   }, []);
   const removeComment = useCallback((commentId: string) => {
      setItems((previous) => previous.filter((item) => item.id !== commentId));
   }, []);
```

   and return `{ items, error, draft, setDraft, submitComment, submitting, replaceComment, removeComment }`.

4. Give `ActivityFeedList` optional props `issueRef?: string; onCommentChanged?: (comment: ApiComment) => void; onCommentDeleted?: (commentId: string) => void;`, and render `<CommentCard key={item.id} item={item} issueRef={issueRef} onChanged={onCommentChanged} onDeleted={onCommentDeleted} />`.

In `issue-details.tsx`, pass them through:

```tsx
                        <ActivityFeedList
                           items={activityFeed.items}
                           error={activityFeed.error}
                           issueRef={issue.identifier}
                           onCommentChanged={activityFeed.replaceComment}
                           onCommentDeleted={activityFeed.removeComment}
                        />
```

- [ ] **Step 4: Run the gates and check the page**

Run: `cd frontend && pnpm lint && pnpm build:check`
Expected: both succeed.

Manual check:
- On your own comment, Edit saves and the text updates; Delete removes it.
- Resolve thread shows a "resolved" badge, and Reopen clears it.
- Reacting to a comment persists.
- "Create sub-task from comment" creates a sub-task titled with the comment's first line.
- Changing a field or status shows a timeline event row.

- [ ] **Step 5: Commit**

```bash
git add frontend/data/issue-details.ts frontend/lib/comments.ts frontend/components/common/issues/details
git commit -m "feat(frontend): edit, delete, resolve and react to comments, and show timeline events"
```

---

### Task 19: Table, swimlane and gantt layouts

**Files:**
- Create: `frontend/lib/use-virtual-rows.ts`, `frontend/components/common/issues/issue-table.tsx`, `frontend/components/common/issues/issue-swimlanes.tsx`, `frontend/components/common/issues/issue-gantt.tsx`
- Modify: `frontend/store/view-store.ts` (`ViewType`), `frontend/components/layout/headers/display-options.tsx` (switcher), `frontend/components/common/issues/all-issues.tsx` (render by type)

**Interfaces:**
- Consumes: `Issue` (`data/issues.ts`), `Status` and `displayOrderedStatus` (`data/status.ts`), `StatusSelector`, `PrioritySelector`, `AssigneeUser` (`components/common/issues/*`), `useIssuesStore().updateIssue`, `patchBoardIssue` (`lib/issues.ts`).
- Produces: `type ViewType = 'list' | 'grid' | 'table' | 'swimlane' | 'gantt'`, `useVirtualRows(count: number, rowHeight: number): { ref; start; end; totalHeight; offset }`, and components `IssueTable({ issues })`, `IssueSwimlanes({ issues, statuses })`, `IssueGantt({ issues })`.

- [ ] **Step 1: Virtual rows**

`frontend/lib/use-virtual-rows.ts`:

```ts
'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Fixed-height row windowing for long tables: only the rows in view (plus an
 * overscan) are rendered, inside a spacer as tall as all of them.
 */
export function useVirtualRows(count: number, rowHeight: number, overscan = 8) {
   const ref = useRef<HTMLDivElement>(null);
   const [range, setRange] = useState({ start: 0, end: 60 });

   useEffect(() => {
      const element = ref.current;
      if (!element) return;
      const update = () => {
         const start = Math.max(0, Math.floor(element.scrollTop / rowHeight) - overscan);
         const end = Math.min(count, Math.ceil((element.scrollTop + element.clientHeight) / rowHeight) + overscan);
         setRange({ start, end });
      };
      update();
      element.addEventListener('scroll', update, { passive: true });
      const observer = new ResizeObserver(update);
      observer.observe(element);
      return () => {
         element.removeEventListener('scroll', update);
         observer.disconnect();
      };
   }, [count, rowHeight, overscan]);

   return {
      ref,
      start: range.start,
      end: Math.min(range.end, count),
      totalHeight: count * rowHeight,
      offset: range.start * rowHeight,
   };
}
```

- [ ] **Step 2: Table with column picker and inline edit**

`frontend/components/common/issues/issue-table.tsx`:

```tsx
'use client';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { Issue } from '@/data/issues';
import { describePatchFailure, patchBoardIssue } from '@/lib/issues';
import { useVirtualRows } from '@/lib/use-virtual-rows';
import { useIssueSelectionStore } from '@/store/issue-selection-store';
import { useIssuesStore } from '@/store/issues-store';
import { Columns3 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AssigneeUser } from './assignee-user';
import { PrioritySelector } from './priority-selector';
import { StatusSelector } from './status-selector';

const COLUMNS = ['identifier', 'status', 'priority', 'assignee', 'dueDate', 'created', 'progress'] as const;
type Column = (typeof COLUMNS)[number];
const LABELS: Record<Column, string> = {
   identifier: 'ID',
   status: 'Status',
   priority: 'Priority',
   assignee: 'Assignee',
   dueDate: 'Due',
   created: 'Created',
   progress: 'Sub-tasks',
};
const STORAGE_KEY = 'berry.issue-table.columns';
const ROW_HEIGHT = 36;

function TitleCell({ issue }: { issue: Issue }) {
   const { orgId } = useParams<{ orgId: string }>();
   const updateIssue = useIssuesStore((state) => state.updateIssue);
   const [editing, setEditing] = useState(false);
   const [title, setTitle] = useState(issue.title);

   const commit = () => {
      setEditing(false);
      const next = title.trim();
      if (!next || next === issue.title) return;
      const previous = issue.title;
      updateIssue(issue.id, { title: next });
      void patchBoardIssue(issue.id, { title: next }).catch((cause: unknown) => {
         updateIssue(issue.id, { title: previous });
         toast.error(describePatchFailure(cause));
      });
   };

   return editing ? (
      <Input
         autoFocus
         className="h-7"
         value={title}
         onChange={(event) => setTitle(event.target.value)}
         onBlur={commit}
         onKeyDown={(event) => event.key === 'Enter' && commit()}
      />
   ) : (
      <span className="flex min-w-0 items-center gap-2" onDoubleClick={() => setEditing(true)}>
         <Link className="truncate hover:underline" href={`/${orgId}/issue/${issue.identifier}`}>
            {issue.title}
         </Link>
      </span>
   );
}

/** A virtualised issue table. Double-click a title to rename it; status, priority and assignee edit in place. */
export function IssueTable({ issues }: { issues: Issue[] }) {
   const [visible, setVisible] = useState<Column[]>(['identifier', 'status', 'priority', 'assignee', 'dueDate']);
   const { selected, toggle } = useIssueSelectionStore();
   const rows = useVirtualRows(issues.length, ROW_HEIGHT);

   useEffect(() => {
      try {
         const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as unknown;
         if (Array.isArray(stored)) setVisible(stored.filter((entry): entry is Column => COLUMNS.includes(entry as Column)));
      } catch {
         // A corrupt preference falls back to the defaults.
      }
   }, []);

   const flip = (column: Column) => {
      const next = visible.includes(column) ? visible.filter((entry) => entry !== column) : [...visible, column];
      setVisible(next);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
   };

   const template = `32px minmax(240px, 1fr) ${visible.map(() => '120px').join(' ')}`;

   return (
      <div className="flex h-full flex-col">
         <div className="flex justify-end border-b px-4 py-1.5">
            <Popover>
               <PopoverTrigger asChild>
                  <Button size="xs" variant="ghost">
                     <Columns3 className="mr-1 size-3.5" />
                     Columns
                  </Button>
               </PopoverTrigger>
               <PopoverContent align="end" className="flex w-48 flex-col gap-1.5 p-2">
                  {COLUMNS.map((column) => (
                     <label key={column} className="flex items-center gap-2">
                        <Checkbox checked={visible.includes(column)} onCheckedChange={() => flip(column)} />
                        {LABELS[column]}
                     </label>
                  ))}
               </PopoverContent>
            </Popover>
         </div>
         <div className="grid border-b px-4 py-1.5 text-muted-foreground" style={{ gridTemplateColumns: template }}>
            <span />
            <span>Title</span>
            {visible.map((column) => (
               <span key={column}>{LABELS[column]}</span>
            ))}
         </div>
         <div ref={rows.ref} className="min-h-0 flex-1 overflow-auto">
            <div style={{ height: rows.totalHeight, position: 'relative' }}>
               <div style={{ transform: `translateY(${rows.offset}px)` }}>
                  {issues.slice(rows.start, rows.end).map((issue) => (
                     <div
                        key={issue.id}
                        className="grid items-center border-b px-4"
                        style={{ gridTemplateColumns: template, height: ROW_HEIGHT }}
                     >
                        <Checkbox checked={selected.includes(issue.id)} onCheckedChange={() => toggle(issue.id)} aria-label="Select task" />
                        <TitleCell issue={issue} />
                        {visible.map((column) => (
                           <span key={column} className="truncate">
                              {column === 'identifier' ? issue.identifier : null}
                              {column === 'status' ? <StatusSelector status={issue.status} issueId={issue.id} /> : null}
                              {column === 'priority' ? <PrioritySelector priority={issue.priority} issueId={issue.id} /> : null}
                              {column === 'assignee' ? <AssigneeUser user={issue.assignee} issueId={issue.id} /> : null}
                              {column === 'dueDate' ? (issue.dueDate?.slice(0, 10) ?? '') : null}
                              {column === 'created' ? issue.createdAt.slice(0, 10) : null}
                              {column === 'progress' && issue.childProgress && issue.childProgress.total > 0
                                 ? `${issue.childProgress.done}/${issue.childProgress.total}`
                                 : null}
                           </span>
                        ))}
                     </div>
                  ))}
               </div>
            </div>
         </div>
      </div>
   );
}
```

`IssueTable` imports `useIssueSelectionStore`, which Task 21 creates. If Task 19 lands first, create `frontend/store/issue-selection-store.ts` here with exactly the code from Task 21 Step 1, and let Task 21 skip that step.

- [ ] **Step 3: Swimlanes and gantt**

`frontend/components/common/issues/issue-swimlanes.tsx`:

```tsx
'use client';

import type { Issue } from '@/data/issues';
import type { Status } from '@/data/status';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';

/** Rows by assignee, columns by status. */
export function IssueSwimlanes({ issues, statuses }: { issues: Issue[]; statuses: Status[] }) {
   const { orgId } = useParams<{ orgId: string }>();
   const lanes = useMemo(() => {
      const byLane = new Map<string, { name: string; issues: Issue[] }>();
      for (const issue of issues) {
         const key = issue.assignee?.id ?? 'unassigned';
         const lane = byLane.get(key) ?? { name: issue.assignee?.name ?? 'Unassigned', issues: [] };
         lane.issues.push(issue);
         byLane.set(key, lane);
      }
      return [...byLane.entries()].sort(([a], [b]) => (a === 'unassigned' ? 1 : b === 'unassigned' ? -1 : 0));
   }, [issues]);

   return (
      <div className="h-full overflow-auto">
         <div className="grid min-w-max" style={{ gridTemplateColumns: `160px repeat(${statuses.length}, 240px)` }}>
            <div className="sticky top-0 z-10 border-b bg-container px-3 py-2" />
            {statuses.map((status) => (
               <div key={status.id} className="sticky top-0 z-10 border-b bg-container px-3 py-2 font-medium">
                  {status.name}
               </div>
            ))}
            {lanes.map(([key, lane]) => (
               <div key={key} className="contents">
                  <div className="border-b px-3 py-2 font-medium">{lane.name}</div>
                  {statuses.map((status) => (
                     <div key={status.id} className="flex flex-col gap-1 border-b border-l p-2">
                        {lane.issues
                           .filter((issue) => issue.status.id === status.id)
                           .map((issue) => (
                              <Link
                                 key={issue.id}
                                 href={`/${orgId}/issue/${issue.identifier}`}
                                 className="rounded border bg-background px-2 py-1 hover:bg-accent"
                              >
                                 <span className="text-muted-foreground">{issue.identifier}</span> {issue.title}
                              </Link>
                           ))}
                     </div>
                  ))}
               </div>
            ))}
         </div>
      </div>
   );
}
```

`frontend/components/common/issues/issue-gantt.tsx`:

```tsx
'use client';

import type { Issue } from '@/data/issues';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';

const DAY = 86_400_000;

/**
 * Created-to-due bars on a day axis. A task without a due date has no span to
 * draw, so it is listed below rather than given a made-up one.
 */
export function IssueGantt({ issues }: { issues: Issue[] }) {
   const { orgId } = useParams<{ orgId: string }>();
   const { dated, undated, start, days } = useMemo(() => {
      const withDue = issues.filter((issue) => issue.dueDate);
      const starts = withDue.map((issue) => Date.parse(issue.createdAt));
      const ends = withDue.map((issue) => Date.parse(issue.dueDate ?? issue.createdAt));
      const first = starts.length ? Math.min(...starts) : Date.now();
      const last = ends.length ? Math.max(...ends) : Date.now();
      const span = Math.min(180, Math.max(7, Math.ceil((last - first) / DAY) + 1));
      return { dated: withDue, undated: issues.filter((issue) => !issue.dueDate), start: first, days: span };
   }, [issues]);

   const percent = (time: number) => Math.max(0, Math.min(100, ((time - start) / (days * DAY)) * 100));

   return (
      <div className="flex h-full flex-col overflow-auto px-4 py-3">
         <div className="mb-2 flex justify-between text-muted-foreground">
            <span>{new Date(start).toISOString().slice(0, 10)}</span>
            <span>{new Date(start + days * DAY).toISOString().slice(0, 10)}</span>
         </div>
         <div className="flex flex-col gap-1">
            {dated.map((issue) => {
               const left = percent(Date.parse(issue.createdAt));
               const right = percent(Date.parse(issue.dueDate ?? issue.createdAt));
               return (
                  <div key={issue.id} className="grid grid-cols-[240px_1fr] items-center gap-3">
                     <Link href={`/${orgId}/issue/${issue.identifier}`} className="truncate hover:underline">
                        <span className="text-muted-foreground">{issue.identifier}</span> {issue.title}
                     </Link>
                     <div className="relative h-5 rounded bg-accent/40">
                        <div
                           className="absolute top-0 h-5 rounded bg-primary/70"
                           style={{ left: `${left}%`, width: `${Math.max(1, right - left)}%` }}
                           title={`${issue.createdAt.slice(0, 10)} to ${issue.dueDate?.slice(0, 10) ?? ''}`}
                        />
                     </div>
                  </div>
               );
            })}
         </div>
         {undated.length > 0 ? (
            <div className="mt-6">
               <div className="mb-1 text-muted-foreground">No due date ({undated.length})</div>
               <ul className="flex flex-col gap-0.5">
                  {undated.map((issue) => (
                     <li key={issue.id}>
                        <Link href={`/${orgId}/issue/${issue.identifier}`} className="hover:underline">
                           <span className="text-muted-foreground">{issue.identifier}</span> {issue.title}
                        </Link>
                     </li>
                  ))}
               </ul>
            </div>
         ) : null}
      </div>
   );
}
```

- [ ] **Step 4: Switcher and rendering**

In `frontend/store/view-store.ts` change the type to `export type ViewType = 'list' | 'grid' | 'table' | 'swimlane' | 'gantt';`.

In `display-options.tsx`, add `CalendarRange`, `Rows3`, `Table2` to the `lucide-react` import. Replace the `grid grid-cols-2` switch block with a data-driven one:

```tsx
               <div className="grid grid-cols-5 gap-1 bg-accent/50 rounded-md p-1">
                  {(
                     [
                        ['list', 'List', LayoutList],
                        ['grid', 'Board', LayoutGrid],
                        ['table', 'Table', Table2],
                        ['swimlane', 'Lanes', Rows3],
                        ['gantt', 'Gantt', CalendarRange],
                     ] as const
                  ).map(([type, label, Icon]) => (
                     <button
                        key={type}
                        onClick={() => setViewType(type)}
                        className={cn(
                           'flex flex-col items-center justify-center gap-0.5 h-12 rounded font-medium transition-colors',
                           viewType === type ? 'bg-background shadow-sm' : 'text-muted-foreground'
                        )}
                     >
                        <Icon className="size-3.5" />
                        {label}
                     </button>
                  ))}
               </div>
```

Change the dot condition `viewType === 'grid'` to `viewType !== 'list'`.

In `all-issues.tsx`, import the three components, then replace the `<GroupedIssuesView ... />` element with:

```tsx
               {viewType === 'table' ? (
                  <IssueTable issues={displayedIssues} />
               ) : viewType === 'swimlane' ? (
                  <IssueSwimlanes issues={displayedIssues} statuses={statuses} />
               ) : viewType === 'gantt' ? (
                  <IssueGantt issues={displayedIssues} />
               ) : (
                  <GroupedIssuesView
                     issues={displayedIssues}
                     totalIssues={scopedIssues}
                     statuses={statuses}
                     isViewTypeGrid={isViewTypeGrid}
                  />
               )}
```

Search for other `viewType === ` switches with `grep -rn "viewType ===" frontend/components frontend/app`. Each must still handle the new values; anything that is not `'grid'` falls back to list behaviour.

- [ ] **Step 5: Run the gates and check the views**

Run: `cd frontend && pnpm lint && pnpm build:check`
Expected: both succeed.

Manual check on `/{orgId}/my-issues`, with 500+ tasks if the seed allows:
- Display → Table scrolls smoothly.
- The Columns picker hides "Priority", and that survives a reload.
- Double-clicking a title renames the task.
- Lanes shows a row per assignee.
- Gantt draws bars for tasks with due dates and lists the rest.

- [ ] **Step 6: Commit**

```bash
git add frontend/lib/use-virtual-rows.ts frontend/components/common/issues frontend/store/view-store.ts frontend/components/layout/headers/display-options.tsx
git commit -m "feat(frontend): add table, swimlane and gantt task layouts"
```

---
### Task 20: Saved views end to end, preferences, and pins in the rail

**Files:**
- Create: `frontend/components/common/views/save-view-dialog.tsx`, `frontend/components/common/views/view-facets.tsx`, `frontend/store/pins-store.ts`, `frontend/components/layout/shell/shell-pins.tsx`, `frontend/components/common/issues/details/issue-pin-button.tsx`
- Modify: `frontend/components/common/views/views.tsx` (hydrate, delete, pin), `frontend/components/common/views/view-details.tsx` (facets, remember active view), `frontend/components/layout/headers/display-options.tsx` ("Save as view"), `frontend/components/layout/shell/shell-rail.tsx` (render pins), `frontend/components/common/issues/details/issue-details.tsx` (pin button, next to Task 17's subscription control; run after Task 17)

**Interfaces:**
- Consumes: `loadWorkspaceViews`, `createSavedView`, `deleteSavedView`, `saveViewPreferences`, `queryIssues`, `toUiView` (`lib/views.ts`); `loadPins`, `pinTarget`, `unpinTarget` (`lib/pins.ts`); `useViewsStore` (`views`, `hydrateViews`); `useViewStore` (`viewType`); `useFilterStore` (`filters`).
- Produces: `usePinsStore` (`{ pins: Pin[]; loaded: boolean; hydrate(pins): void; add(pin): void; remove(pinId): void }`), `SaveViewDialog({ open, onOpenChange })`, `ViewFacets({ view })`, `ShellPins({ orgId })`, `IssuePinButton({ issueId })`, `PinToggle({ targetType, targetId })`.

- [ ] **Step 1: Pins store, rail section, pin toggle**

`frontend/store/pins-store.ts`:

```ts
import type { Pin } from '@/lib/pins';
import { create } from 'zustand';

interface PinsState {
   pins: Pin[];
   loaded: boolean;
   hydrate: (pins: Pin[]) => void;
   add: (pin: Pin) => void;
   remove: (pinId: string) => void;
}

export const usePinsStore = create<PinsState>((set) => ({
   pins: [],
   loaded: false,
   hydrate: (pins) => set({ pins, loaded: true }),
   add: (pin) => set((state) => ({ pins: state.pins.some((entry) => entry.id === pin.id) ? state.pins : [...state.pins, pin] })),
   remove: (pinId) => set((state) => ({ pins: state.pins.filter((entry) => entry.id !== pinId) })),
}));
```

`frontend/components/layout/shell/shell-pins.tsx`:

```tsx
'use client';

import { loadPins, type Pin } from '@/lib/pins';
import { usePinsStore } from '@/store/pins-store';
import { useSessionStore } from '@/store/session-store';
import Link from 'next/link';
import { useEffect } from 'react';

function hrefFor(orgId: string, pin: Pin): string {
   if (pin.targetType === 'issue') return `/${orgId}/issue/${pin.identifier ?? pin.targetId}`;
   if (pin.targetType === 'view') return `/${orgId}/view/${pin.targetId}`;
   return `/${orgId}/project/${pin.targetId}/overview`;
}

/** The rail's "pinned" section. Hidden when nothing is pinned. */
export function ShellPins({ orgId }: { orgId: string }) {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const { pins, hydrate } = usePinsStore();

   useEffect(() => {
      if (!workspaceId) return;
      void loadPins(workspaceId)
         .then(hydrate)
         .catch(() => undefined);
   }, [workspaceId, hydrate]);

   if (pins.length === 0) return null;
   return (
      <div>
         <div className="px-[18px] pt-[18px] pb-[7px] uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">pinned</div>
         <ul className="flex flex-col gap-px px-2">
            {pins.map((pin) => (
               <li key={pin.id}>
                  <Link
                     data-shell-nav
                     href={hrefFor(orgId, pin)}
                     className="flex items-center gap-2.5 truncate rounded px-2.5 py-1.5 text-[var(--shell-text-muted)] hover:bg-[var(--shell-hover)] hover:text-[var(--shell-text)]"
                  >
                     {pin.identifier ? <span className="text-[var(--shell-text-dim)]">{pin.identifier}</span> : null}
                     <span className="truncate">{pin.title}</span>
                  </Link>
               </li>
            ))}
         </ul>
      </div>
   );
}
```

In `shell-rail.tsx`, import `ShellPins` from `./shell-pins` and render `<ShellPins orgId={orgId} />` immediately before `<div className="mt-auto flex items-center gap-1.5 p-3.5">`.

`frontend/components/common/issues/details/issue-pin-button.tsx`:

```tsx
'use client';

import { Button } from '@/components/ui/button';
import { pinTarget, unpinTarget, type Pin } from '@/lib/pins';
import { usePinsStore } from '@/store/pins-store';
import { useSessionStore } from '@/store/session-store';
import { Pin as PinIcon, PinOff } from 'lucide-react';
import { toast } from 'sonner';

/** Pins or unpins a task, view or project in the rail. */
export function PinToggle({ targetType, targetId }: { targetType: Pin['targetType']; targetId: string }) {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const { pins, add, remove } = usePinsStore();
   const existing = pins.find((pin) => pin.targetType === targetType && pin.targetId === targetId);

   const toggle = () => {
      const write = existing
         ? unpinTarget(workspaceId, existing.id).then(() => remove(existing.id))
         : pinTarget(workspaceId, targetType, targetId).then(add);
      void write.catch(() => toast.error('The pin could not be changed.'));
   };

   return (
      <Button variant="ghost" size="icon" className="size-8" onClick={toggle} aria-label={existing ? 'Unpin' : 'Pin'} title={existing ? 'Unpin' : 'Pin'}>
         {existing ? <PinOff className="size-4" /> : <PinIcon className="size-4" />}
      </Button>
   );
}

export function IssuePinButton({ issueId }: { issueId: string }) {
   return <PinToggle targetType="issue" targetId={issueId} />;
}
```

In `issue-details.tsx`, import `IssuePinButton`, and inside the `ml-auto` group added by Task 17 put `<IssuePinButton issueId={issue.id} />` first.

- [ ] **Step 2: Save as view, hydrate, delete, pin a view**

`frontend/components/common/views/save-view-dialog.tsx`:

```tsx
'use client';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { createSavedView, toUiView } from '@/lib/views';
import { useFilterStore } from '@/store/filter-store';
import { useSessionStore } from '@/store/session-store';
import { useViewStore } from '@/store/view-store';
import { useViewsStore } from '@/store/views-store';
import { useState } from 'react';
import { toast } from 'sonner';

/** Saves the current filters and layout as a named view. */
export function SaveViewDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const user = useSessionStore((state) => state.user);
   const { filters } = useFilterStore();
   const { viewType } = useViewStore();
   const { views, hydrateViews } = useViewsStore();
   const [name, setName] = useState('');
   const [shared, setShared] = useState(false);

   const save = () => {
      if (!user) return;
      void createSavedView({
         workspaceId,
         name: name.trim(),
         visibility: shared ? 'workspace' : 'private',
         query: { filters: JSON.parse(JSON.stringify(filters)) as unknown },
         display: { layout: viewType },
      })
         .then((saved) => {
            hydrateViews([toUiView(saved, user, user.id), ...views]);
            setName('');
            onOpenChange(false);
            toast.success('View saved');
         })
         .catch(() => toast.error('The view could not be saved.'));
   };

   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent>
            <DialogHeader>
               <DialogTitle>Save as view</DialogTitle>
            </DialogHeader>
            <Input placeholder="View name" value={name} onChange={(event) => setName(event.target.value)} />
            <label className="flex items-center justify-between">
               Share with the workspace
               <Switch checked={shared} onCheckedChange={setShared} />
            </label>
            <DialogFooter>
               <Button onClick={save} disabled={!name.trim() || !workspaceId}>
                  Save
               </Button>
            </DialogFooter>
         </DialogContent>
      </Dialog>
   );
}
```

In `display-options.tsx`, add `const [saveOpen, setSaveOpen] = useState(false);` (import `useState`), import `SaveViewDialog` from `@/components/common/views/save-view-dialog`, and at the end of the `PopoverContent` add:

```tsx
            <div className="border-t p-3">
               <Button size="sm" variant="secondary" className="w-full" onClick={() => setSaveOpen(true)}>
                  Save as view
               </Button>
            </div>
```

Then, right after the closing `</Popover>`, render `<SaveViewDialog open={saveOpen} onOpenChange={setSaveOpen} />`. Wrap both in a fragment if the component returns the `Popover` directly.

In `views.tsx`:
- Import `loadWorkspaceViews` and `deleteSavedView` from `@/lib/views`, `useSessionStore`, `PinToggle` from `@/components/common/issues/details/issue-pin-button`, `Trash2` from `lucide-react`, `toast` from `sonner`, and `useEffect`.
- In `Views`, add:

```tsx
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const user = useSessionStore((state) => state.user);
   const hydrateViews = useViewsStore((state) => state.hydrateViews);

   useEffect(() => {
      if (!workspaceId || !user) return;
      void loadWorkspaceViews(workspaceId, user).then(hydrateViews);
   }, [workspaceId, user, hydrateViews]);

   const remove = (viewId: string) =>
      void deleteSavedView(viewId)
         .then(() => hydrateViews(savedViews.filter((view) => view.id !== viewId)))
         .catch(() => toast.error('You cannot delete this view.'));
```

- Change `ViewRow` to take `onDelete: () => void`. Make its root a `div` holding the existing `Link` (now `flex-1`), and add `<PinToggle targetType="view" targetId={view.id} />` and `<Button size="xs" variant="ghost" aria-label="Delete view" onClick={onDelete}><Trash2 className="size-3.5" /></Button>` after it. Render as `<ViewRow key={view.id} view={view} orgId={orgId} onDelete={() => remove(view.id)} />`.

- [ ] **Step 3: Server facets on a view, and remember the active view**

`frontend/components/common/views/view-facets.tsx`:

```tsx
'use client';

import type { View } from '@/data/views';
import { API_PRIORITY_BY_UI, API_STATUS_BY_UI } from '@/lib/catalog';
import { queryIssues, saveViewPreferences, type IssueQueryResult } from '@/lib/views';
import { useSessionStore } from '@/store/session-store';
import { useEffect, useState } from 'react';

/**
 * Counts for a view, computed by the server over the whole workspace rather
 * than over whatever the board has loaded. Opening a view also records it as
 * the person's active view.
 */
export function ViewFacets({ view }: { view: View }) {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [result, setResult] = useState<IssueQueryResult | null>(null);

   useEffect(() => {
      if (!workspaceId) return;
      const statuses = (view.filter.statusIds ?? []).map((id) => API_STATUS_BY_UI[id] ?? id);
      const priorities = (view.filter.priorityIds ?? []).map((id) => API_PRIORITY_BY_UI[id] ?? id);
      void queryIssues({
         workspaceId,
         filter: {
            ...(statuses.length ? { statuses } : {}),
            ...(priorities.length ? { priorities } : {}),
            ...(view.filter.labelIds?.length ? { labelIds: view.filter.labelIds } : {}),
            ...(view.filter.unassigned ? { unassigned: true } : {}),
         },
         groupBy: 'status',
         perGroup: 1,
      })
         .then(setResult)
         .catch(() => setResult(null));
      void saveViewPreferences(workspaceId, view.id, {}).catch(() => undefined);
   }, [workspaceId, view]);

   if (!result) return null;
   return (
      <div className="flex flex-wrap items-center gap-3 border-b px-6 py-2 text-muted-foreground">
         <span className="text-foreground">{result.total} tasks</span>
         {Object.entries(result.facets.status).map(([status, count]) => (
            <span key={status}>
               {status} {count}
            </span>
         ))}
      </div>
   );
}
```

`ViewFilter` in `data/views.ts` has exactly `statusCategories`, `statusIds`, `labelIds`, `priorityIds`, `hasProject` and `unassigned`. Status and priority ids are UI ids, mapped to the API spellings through `API_STATUS_BY_UI` / `API_PRIORITY_BY_UI` (`lib/catalog.ts`). `statusCategories` and `hasProject` have no server filter and are not sent, so the counts can be broader than the board for a view that uses them; a rejected query leaves the facets hidden.

In `view-details.tsx`, import `ViewFacets` and render `<ViewFacets view={view} />` as the first child of `IssueViewBody`'s outer `div`.

- [ ] **Step 4: Run the gates and check**

Run: `cd frontend && pnpm lint && pnpm build:check`
Expected: both succeed.

Manual check:
- Display → "Save as view" creates a view that appears on `/{orgId}/views` after a reload.
- Delete removes it.
- Pinning a task or a view shows it under "pinned" in the rail, and unpinning removes it.
- Opening a view shows server counts; `GET /api/v1/views/preferences` then returns that view as `activeViewId`.

- [ ] **Step 5: Commit**

```bash
git add frontend/components/common/views frontend/store/pins-store.ts frontend/components/layout/shell frontend/components/common/issues/details/issue-pin-button.tsx frontend/components/common/issues/details/issue-details.tsx frontend/components/layout/headers/display-options.tsx
git commit -m "feat(frontend): save and delete views, show server counts, and pin tasks and views"
```

---

### Task 21: Batch toolbar, quick create, assignee frequency, join page

**Files:**
- Create: `frontend/store/issue-selection-store.ts` (unless Task 19 already created it), `frontend/components/common/issues/batch-toolbar.tsx`, `frontend/components/common/issues/quick-create.tsx`, `frontend/app/join/[token]/page.tsx`
- Modify: `frontend/components/common/issues/all-issues.tsx`

**Interfaces:**
- Consumes: `batchUpdateIssues`, `batchDeleteIssues`, `quickCreateIssue`, `loadAssigneeFrequency` (`lib/issue-tracking.ts`); `lookupJoinLink`, `acceptJoinLink` (`lib/join-links.ts`); `getBoardIssue`, `assigneeToApi` (`lib/issues.ts`); `apiStatusFromUi`, `apiPriorityFromUi` (`lib/catalog.ts`); `status` (`data/status.ts`), `priorities` (`data/priorities.ts`); `loadWorkspaceMembers`, `loadWorkspaceAgents`.
- Produces: `useIssueSelectionStore` (`{ selected: string[]; toggle(id): void; clear(): void; setAll(ids): void }`), `BatchToolbar()`, `QuickCreate()`, page `/join/[token]`.

- [ ] **Step 1: Selection store**

`frontend/store/issue-selection-store.ts`:

```ts
import { create } from 'zustand';

interface IssueSelectionState {
   selected: string[];
   toggle: (id: string) => void;
   clear: () => void;
   setAll: (ids: string[]) => void;
}

/** Tasks picked for a batch change. Not persisted: a selection is momentary. */
export const useIssueSelectionStore = create<IssueSelectionState>((set) => ({
   selected: [],
   toggle: (id) =>
      set((state) => ({
         selected: state.selected.includes(id) ? state.selected.filter((entry) => entry !== id) : [...state.selected, id],
      })),
   clear: () => set({ selected: [] }),
   setAll: (ids) => set({ selected: ids }),
}));
```

- [ ] **Step 2: Batch toolbar with assignee frequency**

`frontend/components/common/issues/batch-toolbar.tsx`:

```tsx
'use client';

import { Button } from '@/components/ui/button';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuLabel,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { priorities } from '@/data/priorities';
import { status as allStatus } from '@/data/status';
import { loadWorkspaceAgents } from '@/lib/agents';
import { apiPriorityFromUi, apiStatusFromUi } from '@/lib/catalog';
import { batchDeleteIssues, batchUpdateIssues, loadAssigneeFrequency } from '@/lib/issue-tracking';
import { getBoardIssue } from '@/lib/issues';
import { loadWorkspaceMembers } from '@/lib/members';
import { useIssueSelectionStore } from '@/store/issue-selection-store';
import { useIssuesStore } from '@/store/issues-store';
import { useSessionStore } from '@/store/session-store';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

type Candidate = { type: 'user' | 'agent'; id: string; name: string };

/**
 * Appears while tasks are selected. Each change is applied per task on the
 * server, and anything it could not change is reported by count.
 */
export function BatchToolbar() {
   const { selected, clear } = useIssueSelectionStore();
   const updateIssue = useIssuesStore((state) => state.updateIssue);
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [candidates, setCandidates] = useState<Candidate[]>([]);

   useEffect(() => {
      if (!workspaceId || selected.length === 0 || candidates.length > 0) return;
      void Promise.all([loadAssigneeFrequency(workspaceId), loadWorkspaceMembers(workspaceId), loadWorkspaceAgents()])
         .then(([frequent, members, agents]) => {
            const named: Candidate[] = [
               ...members.map((member) => ({ type: 'user' as const, id: member.id, name: member.name })),
               ...agents.map((agent) => ({ type: 'agent' as const, id: agent.id, name: agent.name })),
            ];
            const rank = (candidate: Candidate) =>
               frequent.find((entry) => entry.type === candidate.type && entry.id === candidate.id)?.count ?? 0;
            setCandidates(named.sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name)).slice(0, 12));
         })
         .catch(() => undefined);
   }, [workspaceId, selected.length, candidates.length]);

   if (selected.length === 0) return null;

   const refresh = async (ids: string[]) => {
      for (const id of ids) {
         const fresh = await getBoardIssue(id);
         if (fresh) updateIssue(id, fresh);
      }
   };

   const apply = (patch: Parameters<typeof batchUpdateIssues>[1]) =>
      void batchUpdateIssues(selected, patch)
         .then(async (result) => {
            await refresh(result.updated);
            if (result.failed.length > 0) toast.error(`${result.failed.length} task(s) could not be changed.`);
            clear();
         })
         .catch(() => toast.error('The change could not be applied.'));

   const remove = () => {
      if (!window.confirm(`Delete ${selected.length} task(s)?`)) return;
      void batchDeleteIssues(selected)
         .then((result) => {
            useIssuesStore.setState((state) => ({ issues: state.issues.filter((issue) => !result.deleted.includes(issue.id)) }));
            if (result.failed.length > 0) toast.error(`${result.failed.length} task(s) could not be deleted.`);
            clear();
         })
         .catch(() => toast.error('The tasks could not be deleted.'));
   };

   return (
      <div className="flex items-center gap-2 border-b bg-accent/40 px-4 py-1.5">
         <span>{selected.length} selected</span>
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <Button size="xs" variant="secondary">Status</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
               {allStatus.map((entry) => (
                  <DropdownMenuItem key={entry.id} onClick={() => apply({ status: apiStatusFromUi(entry.id) })}>
                     {entry.name}
                  </DropdownMenuItem>
               ))}
            </DropdownMenuContent>
         </DropdownMenu>
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <Button size="xs" variant="secondary">Priority</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
               {priorities.map((entry) => (
                  <DropdownMenuItem key={entry.id} onClick={() => apply({ priority: apiPriorityFromUi(entry.id) })}>
                     {entry.name}
                  </DropdownMenuItem>
               ))}
            </DropdownMenuContent>
         </DropdownMenu>
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <Button size="xs" variant="secondary">Assign</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
               <DropdownMenuLabel>Most assigned by you first</DropdownMenuLabel>
               {candidates.map((candidate) => (
                  <DropdownMenuItem key={`${candidate.type}:${candidate.id}`} onClick={() => apply({ assignee: { type: candidate.type, id: candidate.id } })}>
                     {candidate.name}
                  </DropdownMenuItem>
               ))}
               <DropdownMenuSeparator />
               <DropdownMenuItem onClick={() => apply({ assignee: null })}>Unassign</DropdownMenuItem>
            </DropdownMenuContent>
         </DropdownMenu>
         <Button size="xs" variant="ghost" onClick={remove}>
            Delete
         </Button>
         <Button size="xs" variant="ghost" className="ml-auto" onClick={clear}>
            Clear
         </Button>
      </div>
   );
}
```

- [ ] **Step 3: Quick create**

`frontend/components/common/issues/quick-create.tsx`:

```tsx
'use client';

import { Input } from '@/components/ui/input';
import { quickCreateIssue } from '@/lib/issue-tracking';
import { useIssuesStore } from '@/store/issues-store';
import { useSessionStore } from '@/store/session-store';
import { useState } from 'react';
import { toast } from 'sonner';

/** One line, Enter to create: a task on the workspace's default board. */
export function QuickCreate() {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const addIssue = useIssuesStore((state) => state.addIssue);
   const [title, setTitle] = useState('');
   const [busy, setBusy] = useState(false);

   const submit = () => {
      if (!title.trim() || !workspaceId || busy) return;
      setBusy(true);
      void quickCreateIssue({ workspaceId, title: title.trim() })
         .then((issue) => {
            addIssue(issue);
            setTitle('');
         })
         .catch(() => toast.error('The task could not be created.'))
         .finally(() => setBusy(false));
   };

   return (
      <div className="border-b px-4 py-1.5">
         <Input
            className="h-8"
            placeholder="Quick add a task and press Enter"
            value={title}
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && submit()}
         />
      </div>
   );
}
```

In `all-issues.tsx`, import `BatchToolbar` and `QuickCreate`, and render them right after `<IssueFilterBar />`:

```tsx
         <QuickCreate />
         <BatchToolbar />
```

- [ ] **Step 4: Join page**

`frontend/app/join/[token]/page.tsx`:

```tsx
'use client';

import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { BerryApiError } from '@/lib/api';
import { acceptJoinLink, lookupJoinLink } from '@/lib/join-links';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type State =
   | { kind: 'loading' }
   | { kind: 'invalid' }
   | { kind: 'ready'; workspace: string; role: string }
   | { kind: 'signin' }
   | { kind: 'error' };

/** Public landing for a join link: shows the workspace, then joins it. */
export default function JoinPage() {
   const { token } = useParams<{ token: string }>();
   const router = useRouter();
   const [state, setState] = useState<State>({ kind: 'loading' });
   const [joining, setJoining] = useState(false);

   useEffect(() => {
      void lookupJoinLink(token)
         .then((found) => setState({ kind: 'ready', workspace: found.workspace.name, role: found.role }))
         .catch(() => setState({ kind: 'invalid' }));
   }, [token]);

   const join = () => {
      setJoining(true);
      void acceptJoinLink(token)
         .then(() => router.push('/'))
         .catch((cause: unknown) =>
            setState(cause instanceof BerryApiError && cause.status === 401 ? { kind: 'signin' } : { kind: 'error' })
         )
         .finally(() => setJoining(false));
   };

   return (
      <AuthCard title="Join a workspace">
         {state.kind === 'loading' ? <p className="text-muted-foreground">Checking the link…</p> : null}
         {state.kind === 'invalid' ? <p>This join link is not valid. It may have expired or been revoked.</p> : null}
         {state.kind === 'ready' ? (
            <div className="flex flex-col gap-4">
               <p>
                  Join <strong>{state.workspace}</strong> as {state.role}.
               </p>
               <Button onClick={join} disabled={joining}>
                  Join workspace
               </Button>
            </div>
         ) : null}
         {state.kind === 'signin' ? (
            <p>
               <Link className="underline" href="/sign-in">
                  Sign in
               </Link>
               , then open this link again to join.
            </p>
         ) : null}
         {state.kind === 'error' ? <p>Joining failed. Try the link again.</p> : null}
      </AuthCard>
   );
}
```

`AuthCard` (`frontend/components/auth/auth-card.tsx`) takes a required `title` plus optional `description`, `children` and `footer`.

- [ ] **Step 5: Run the gates and check**

Run: `cd frontend && pnpm lint && pnpm build:check`
Expected: both succeed.

Manual check:
- In Table layout, select three tasks → Priority → High updates all three. Selecting one you cannot edit reports "1 task(s) could not be changed".
- Assign lists the people you assign most first.
- Quick add creates a task.
- Opening a join link signed out shows the workspace name and asks you to sign in. Signed in as a non-member, it joins and lands in the app.

- [ ] **Step 6: Commit**

```bash
git add frontend/store/issue-selection-store.ts frontend/components/common/issues frontend/app/join
git commit -m "feat(frontend): batch-edit tasks, quick-add tasks and join a workspace by link"
```

---

### Task 22: Whole-workstream verification

**Files:** none new.

- [ ] **Step 1: Server gates, offline and with a database**

Run: `pnpm typecheck:server && pnpm test:server`, then the DB-backed pass with `BERRY_TEST_DATABASE_URL` set (see "Running the DB-backed tests").
Expected: all PASS. Every `src/work/*.test.ts` and `src/mounts/{issue-tracking,work-mounts,work-tracking.leakage}.test.ts` runs rather than skips.

- [ ] **Step 2: Frontend gates**

Run: `cd frontend && pnpm lint && pnpm build:check`
Expected: both succeed.

- [ ] **Step 3: End-to-end smoke on the compose stack**

Run: `docker compose up -d --build && pnpm migrate:server` (with `DATABASE_URL` set), then `pnpm dev:frontend`. As one user, walk through:
1. Settings: create a field, a custom status and a quick action.
2. On a task, set the field, react, subscribe, and add two staged sub-tasks assigned to an agent. Finish stage 1 and see stage 2 get a run (only on a server with an executor).
3. Comment with a mention (`[@Name](mention://user/<id>)`) and see it in the mentioned member's inbox.
4. Run a quick action. Expect a 202, or the "runtime not available" toast before A merges.
5. Switch to Table, Lanes and Gantt. Save a view, pin it, batch-edit, quick-add.
6. Create a join link and join with a second account.

- [ ] **Step 4: Spec §13 inventory row**

Add B's rows to the parity inventory the release uses. Each row maps a §3 bullet to its endpoint(s) and page(s), using the tables in Tasks 12, 13 and 16–21. Google OAuth is listed as "out of scope by decision", not as a gap.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A server-ts frontend
git commit -m "fix: address work-tracking verification findings"
```

(Skip the commit if nothing changed.)

---

## Self-review

**Spec §3 coverage.**

| §3 item | Task(s) |
|---|---|
| Custom properties (9 types), workspace CRUD, per-issue values | 1, 4, 12, 13, 16, 17 |
| Filtering and grouping by properties in views | 9 (`properties` filter, `groupBy.propertyId`), 13, 20 |
| Issue metadata (key/value) | 1, 4, 12, 15 (no dedicated UI; agents and integrations write it through the API) |
| Reactions on issues and comments | 5, 12, 13, 17, 18 |
| Comment resolve/unresolve; edit/delete UI | 5, 13, 18 |
| Subscribers (creator, assignee, commenter, mentioned; manual; subtree), feeding the inbox | 1, 6, 12 (hooks), 13, 17 |
| Sub-issues, child progress, sub-issue from a comment, stage barrier in auto-dispatch | 1, 2, 7, 12, 17, 18 |
| Custom statuses by category (create, rename, reorder, archive), `in_review` as gate | 1, 2, 8, 12, 13, 16, 17 (rename already served by the existing PATCH) |
| Views: board, list, table (virtualised, column picker, inline edit), swimlane, gantt | 19 |
| Saved views CRUD, per-user preferences, server grouped/faceted queries | 9, 13, 15, 20 |
| Timeline from `outbox_events` | 1 (index), 3, 10, 12, 18 |
| Pins in the sidebar | 10, 13, 20 |
| Quick actions run as agent tasks (`enqueueTask`, source `quick_action`) | 10, 12, 14, 16, 17 |
| Batch update/delete, move/reorder, quick create, assignee frequency | 11, 12, 21 (move/reorder is served by `POST /issues/:ref/move` and used by the board's existing drag path) |
| Share links: create, list, revoke, public lookup, join page | 1, 11, 13, 16, 21 |
| No Google OAuth | Global Constraints; no task |
| §11 isolation (every mount in leakage tests), outbox-only realtime | 14, all mounts |

**Consistency check.** The names used across tasks match their definitions:
- `recordIssueEvent`/`publishEvents` (Task 3)
- `stageGate`/`StageGate` (Task 7)
- `QuickActionEnqueue` (Task 10)
- `WorkTrackingHooks`/`workTrackingHooks` (Task 12)
- `rethrowWork` (Task 12)
- `serializeIssue` (exported in Task 2)
- `parseApiIssue` (Task 15)
- `useIssueSelectionStore` (Task 21; created early by 19 if needed)
- `usePinsStore`/`PinToggle` (Task 20)

Wire field names in Task 15's Zod schemas match the Task 12/13 tables.

**Known limits, stated rather than hidden:**
- The table's custom-property columns are not rendered, since a value per row would need one request per task. Properties are edited on the task page and filtered through the server query.
- Moving a task to another board is not included. Issue numbers are allocated per board, so a move changes a task's identifier. "Move" here means reorder and re-parent.
- Stage release fires on status writes through the issues API and batch. A review decision that marks a task done is covered only if the reviews mount calls the same hook (see Open Questions).

## Open Questions

1. **Mention syntax.** B defines `[@Name](mention://user/<uuid>)` for subscriptions and inbox mentions. Workstream D's mention triggers should use the same token. Confirm D adopts it, or name the syntax D wants before both ship.
2. **Stage release on review decisions.** When a human approves a review and the task goes to `done`, the reviews mount changes the status without the issue hooks. Should B also call `afterIssueWrite` from `mounts/reviews.ts`, which is outside §3's surface, or is release on the next issue edit acceptable?
3. **Auth cutover (workstream J).** Spec §3a says J (Better Auth, GitHub only) merges first and replaces `server-ts/src/auth/`. The mount and leakage tests here mint sessions with `SessionService.issueForUser` and guard routes with `requireSession`. If J has merged when B starts, replace both with J's session helper and guard before writing Tasks 12–14; the assertions do not change.
4. **Outbox retention.** The timeline reads `outbox_events` directly. Today the only statement that deletes outbox rows is the development reset (`server-ts/src/reset/reset.ts`); there is no retention job. If one is ever added, it must keep rows with `payload ? 'issueId'`, or a dedicated `issue_activity` projection table is added in block 065+.
