# Parity workstream I — frontend fixture removal, navigation, global search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shipped rail honest. No page in it reads a `frontend/data/*` fixture collection. Surfaces with no backend (initiatives, cycles, documents, the 14 placeholder settings) leave navigation. Global search (`/api/v1/search` plus the command palette) also finds projects, agents, chat threads and skills.

**Architecture:** On the server, the `searchRoute` in `server-ts/src/mounts/workspace-reads.ts` gains a pure, offline-tested type parser and four new result types. Each one is scoped the same way the existing issue and board queries are: through the membership-confirmed `ScopedDb`. Chat is further scoped to threads the caller participates in. Skills are queried only when workstream D's `skills` table exists. On the frontend, `lib/search.ts` gains the new types and one `searchResultHref` mapper, and the command palette gets a live "Search" group. Navigation lives in the rail (`shell-routes.ts`, `sidebar-prefs-store.ts`, `customize-sidebar-dialog.tsx`) and the settings nav (`nav-settings.tsx`). Fixture removal is enforced by an ESLint `no-restricted-imports` block, because lint is the frontend's gate and it has no test runner.

**Tech Stack:** Node 22 + Hono + postgres.js (`node --test --experimental-strip-types`, Zod v4) on the server. Next.js 15 App Router, Zustand, cmdk 1.0.0 and Zod v3 on the frontend.

**Spec:** `docs/superpowers/specs/2026-09-10-multica-parity-design.md` §10 (plus §11 isolation/tests rules). Read both before starting.

## Global Constraints

- Scope is spec §10 cross-cutting frontend only: fixture removal, rail/navigation, global search (backend part in `workspace-reads.ts`). Pages for new areas (runtimes, usage, dashboard, skills, agents/new, squads, autopilots, members detail, settings tabs…) are owned by their workstreams and are **not** built here.
- "No page in the shipped rail imports `frontend/data/*`" is read as: no shipped code imports a **fixture collection or fixture getter** (`users`, `labels`, `projects`, `issues`, `inboxItems`, `views`, `cycles`, `initiatives`, `documentFolders`, `side-bar-nav` items and the getters over them). Domain **types** and fixed **vocabularies** (`status`, `priorities`, `health`, `statusUserColors`, the view filter helpers) stay in `data/` — `frontend/ARCHITECTURE.md` defines `data/` as "domain types". See Open Questions.
- Hidden surfaces: initiatives, cycles, documents and the 14 placeholder settings (`agent-personalization`, `code-and-reviews`, `issue-templates`, `slas`, `project-labels`, `project-templates`, `project-updates`, `initiatives`, `documents`, `customer-requests`, `releases`, `pulse`, `asks`, `emojis`) are "hidden from navigation, not faked". This plan deletes their routes, so a stale link gets a 404 and no longer renders an empty fake.
- Workstream I has **no migrations**.
- Realtime: none added here; if a later change needs one it goes through `outbox_events` + the SSE hub. No WebSocket.
- Server code: no emitted TS syntax (no enums, namespaces, parameter properties), relative imports with `.ts` extensions, `import type` for types, 3-space indent, single quotes, match surrounding style, Zod v4 only if Zod is needed (it is not here).
- Server tests: `node --test`; DB-backed tests self-skip without `BERRY_TEST_DATABASE_URL` so `pnpm test:server` stays green offline.
- Frontend: Prettier 3-space, single quotes, semicolons, `es5` trailing commas, width 100; Zod v3 (`^3.24.2`); all server traffic through `lib/api.ts`; gates are `pnpm lint` and `pnpm build:check` (never `pnpm build` while `next dev` runs).
- Isolation (§11): every search result is derived from the confirmed `ctx.workspaceId`, never the raw query param; cross-tenant leakage is asserted in tests.
- Clean-room: never copy multica source, schema text, copy, icons or UI. Web only. No new integrations.
- Shared cross-plan names are not redefined here (`enqueueTask`, `TaskEnvelope`, `registerAgentTool`, `recordTaskUsage`, …); this plan consumes none of them.
- Commits: `type(scope): imperative summary`, scope `server-ts` or `frontend`; end with the `Co-Authored-By` line the session gives. Do not push.

## Cross-workstream seams this plan creates

| Seam | Owner here | Consumer |
|---|---|---|
| `SHELL_SECTIONS` in `frontend/components/layout/shell/shell-routes.ts` | I (structure) | A (runtimes), C (usage, dashboard), D (skills, squads), E (autopilots): each appends **one** `ShellRouteDef` + one `SidebarItemKey` + one `DEFAULT_ORDER` slot + one `customize-sidebar-dialog` item, only when its page exists |
| `settingsNav` in `frontend/components/layout/sidebar/nav-settings.tsx` | I (structure) | A, B, D, G, H append items when their settings page exists. **Anchor warning:** workstream A's plan (Task at its line ~7923) inserts its `runtimes` item "after `agent personalization`", an item this plan deletes in Task 4. Once I has merged, A appends after `{ name: 'agents', url: '/settings/ai', … }` in the `workspace` group. Whichever lands second resolves the conflict that way. |
| `searchResultHref` in `frontend/lib/search.ts` | I | D must serve `/{orgId}/skills/{skillId}` or edit the `'skill'` case |
| `skills` table (`workspace_id`, `name`, `description`) | D | search reads it only when `to_regclass('public.skills')` is non-null. Before D the skill branch is unexercised, so D **must** add a W1/W2 skill to `workspace-reads.search.test.ts` in its skills task and assert that a W1 `types=skill` search never returns the W2 skill (spec §11 cross-tenant coverage). If D's table soft-deletes (for example with an `archived_at` column), D also adds that predicate to the skill branch. |

### §10 surfaces no workstream plan owns (spec gap, escalate before execution)

A grep of every `2026-09-10-parity-*.md` plan found no task for these §10 pages. They are out of this plan's stated scope ("pages … owned by their workstreams"), but no workstream claims them. The coordinator must assign each one, or record it in the §13 "verified-offline-only" list:
- Settings tabs: **members**, **chat**, **keyboard shortcuts**, **delete workspace**, **repositories** (§7 names a workstream K, which has no plan file).
- **Invitations** (B owns join links and the join page; nobody owns the invitations UI).
- **Billing** page and settings tab: §9 declares billing out of scope, which contradicts §10. H's plan must say which rule wins.

## File Structure

**Server**
- Modify `server-ts/src/mounts/workspace-reads.ts` — export `SEARCH_TYPES`, `SearchType`, `parseSearchTypes`; add `project`, `agent`, `chat`, `skill` branches to `searchRoute`; every node gains `agentId`.
- Create `server-ts/src/mounts/workspace-reads.search-types.test.ts` — offline unit test for `parseSearchTypes`.
- Create `server-ts/src/mounts/workspace-reads.search.test.ts` — DB-gated two-workspace test for the new types, including leakage and chat privacy.
- Modify `server-ts/SCOPE.md` — the Analytics row.

**Frontend**
- Modify `frontend/lib/search.ts` — new types, `agentId`, `searchResultHref`.
- Modify `frontend/components/layout/command-palette.tsx` — live Search group, Chat go-to; drop cycle route, initiatives link, fake "Add to release".
- Modify `frontend/components/common/chat/chat.tsx`, `frontend/app/[orgId]/chat/page.tsx` — `?agent=` deep link.
- Modify `frontend/components/layout/shell/shell-routes.ts`, `frontend/store/sidebar-prefs-store.ts`, `frontend/components/layout/sidebar/customize-sidebar-dialog.tsx`, `frontend/components/layout/shell/shell-tab-model.ts` — rail.
- Modify `frontend/components/layout/sidebar/nav-settings.tsx`, `frontend/components/layout/shell/shell-rail-settings.tsx` (doc comment only) — settings nav.
- Modify `frontend/components/common/projects/details/project-properties-panel.tsx`, `frontend/components/common/projects/project-peek-panel.tsx` — drop the faked "Initiatives" and "Slack" property rows.
- Modify `frontend/components/layout/headers/view/header.tsx`, `frontend/data/views.ts` — the view header reads `useViewsStore`, not the `views` fixture.
- Modify `frontend/eslint.config.mjs` — fixture import guard.
- Delete legacy sidebar: `frontend/components/layout/sidebar/{app-sidebar,nav-inbox,nav-account,nav-features,nav-workspace,help-button,org-switcher,back-to-app}.tsx`, `frontend/data/side-bar-nav.ts`.
- Delete placeholders: 14 `frontend/app/[orgId]/settings/<slug>/` dirs, `frontend/components/common/settings/{settings-placeholder.tsx,placeholder-sections.ts}`, `frontend/data/documents.ts`.
- Delete initiatives: `frontend/app/[orgId]/initiatives/`, `frontend/app/[orgId]/initiative/`, `frontend/app/[orgId]/@drawer/(.)initiative/`, `frontend/components/common/initiatives/`, `frontend/components/layout/headers/initiative/`, `frontend/components/layout/headers/initiatives/`, `frontend/store/initiatives-{display,filter}-store.ts`, `frontend/data/initiatives.ts`.
- Delete cycles: `frontend/data/cycles.ts`, `frontend/components/common/cycles/cycle-icon.tsx`; edit `issue-line.tsx`, `issue-properties-panel.tsx`, `headers/issue/header-nav.tsx`, `project-properties-panel.tsx`, `issue-filter-columns.tsx`, `use-panel-filter.ts`, `display-settings-store.ts`.
- Modify fixture consumers: `store/{issues,projects,notifications}-store.ts`, `app/[orgId]/profiles/[memberId]/page.tsx`, `app/[orgId]/@drawer/(.)profiles/[memberId]/page.tsx`, `components/layout/headers/members/header-nav.tsx`, `components/layout/headers/profile/header.tsx`, `components/layout/sidebar/create-new-issue/assignee-selector.tsx`, `components/common/members/member-profile.tsx`; trim `data/{users,labels,projects,issues,inbox}.ts`.
- Modify `frontend/ARCHITECTURE.md` — `data/` row.

## Task order and parallelism

Tasks 1→2 (server) and Tasks 3–6 (frontend) touch disjoint trees and can run in parallel. Within the frontend, run 4→5→6 in order: 5 and 6 edit `command-palette.tsx` and `eslint.config.mjs` after 4. Task 3 edits `command-palette.tsx` too, so run it before 4, or rebase carefully. Task 3 must not ship ahead of Tasks 1–2. The palette requests `types=issue,project,agent,chat,skill`, and the current server answers any unknown type with a 422. `searchWorkspace` turns that into `[]`, so even issue search would go blank. Develop Task 3 in parallel, but merge it only on top of Tasks 1–2. Task 7 runs last.

---

### Task 1: Server search — type parser, projects and agents

**Files:**
- Modify: `server-ts/src/mounts/workspace-reads.ts` (constants near `MAX_QUERY` at line 34; `searchRoute` lines 58–137)
- Create: `server-ts/src/mounts/workspace-reads.search-types.test.ts`
- Create: `server-ts/src/mounts/workspace-reads.search.test.ts`

**Interfaces:**
- Consumes: `requireWorkspace(context, options, url): Promise<ScopedDb>` (same file, line 479); `db.list((q) => q.sql\`…\`)` where `q.scope` is the `workspace_id = ctx.workspaceId` fragment and `q.workspaceId` the confirmed id; `assertValid`, `fieldError` from `../http/body.ts`.
- Produces:
  - `export const SEARCH_TYPES = ['issue', 'board', 'project', 'agent', 'chat', 'skill'] as const;`
  - `export type SearchType = (typeof SEARCH_TYPES)[number];`
  - `export function parseSearchTypes(raw: string | null): Set<SearchType>`: defaults to `issue` when `raw` is null or empty, and throws the validation envelope (field `/types`, code `invalid_value`) on an unknown type.
  - Wire node shape (every type): `{ type: SearchType, id: string, title: string, subtitle: string | null, identifier: string | null, boardId: string | null, agentId: string | null }`. The `agentId` field is additive; it is the agent id for `agent` and `chat` results and null otherwise.

- [ ] **Step 1: Write the failing offline test**

Create `server-ts/src/mounts/workspace-reads.search-types.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSearchTypes, SEARCH_TYPES } from './workspace-reads.ts';

test('an absent types parameter searches issues only, as it always has', () => {
   assert.deepEqual([...parseSearchTypes(null)], ['issue']);
   assert.deepEqual([...parseSearchTypes('')], ['issue']);
});

test('every advertised type is accepted, and duplicates collapse', () => {
   const parsed = parseSearchTypes(`${SEARCH_TYPES.join(',')},issue`);
   assert.deepEqual([...parsed].sort(), [...SEARCH_TYPES].sort());
});

test('whitespace around a type is tolerated', () => {
   assert.deepEqual([...parseSearchTypes(' project , agent ')].sort(), ['agent', 'project']);
});

test('an unknown type is refused rather than silently ignored', () => {
   assert.throws(() => parseSearchTypes('issue,initiative'));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/mounts/workspace-reads.search-types.test.ts`
Expected: FAIL. The module has no export named `parseSearchTypes` (a SyntaxError about the missing export).

- [ ] **Step 3: Implement the parser and switch the route to it**

In `workspace-reads.ts`, directly under `const MAX_QUERY = 200;` add:

```ts
/**
 * What the palette may ask for. `board` stays for API callers even though the
 * palette no longer requests it: a board has no page of its own to open.
 */
export const SEARCH_TYPES = ['issue', 'board', 'project', 'agent', 'chat', 'skill'] as const;

export type SearchType = (typeof SEARCH_TYPES)[number];

function isSearchType(value: string): value is SearchType {
   return (SEARCH_TYPES as readonly string[]).includes(value);
}

/**
 * The `types` query parameter, as a set. Absent means issues, which is what
 * the parameter meant before it grew; an unknown name is a 422 rather than a
 * silent drop, so a client asking for a type this server lacks finds out.
 */
export function parseSearchTypes(raw: string | null): Set<SearchType> {
   const names = (raw ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
   if (names.length === 0) return new Set<SearchType>(['issue']);
   const types = new Set<SearchType>();
   for (const name of names) {
      if (!isSearchType(name)) {
         assertValid([
            fieldError('/types', 'invalid_value', `types are ${SEARCH_TYPES.join(', ')}.`),
         ]);
      } else {
         types.add(name);
      }
   }
   return types;
}
```

In `searchRoute`, replace the block that starts `const types = new Set((url.searchParams.get('types') ?? 'issue').split(','));` and ends with the closing brace of its `for` loop (lines 74–79) with:

```ts
      const types = parseSearchTypes(url.searchParams.get('types'));
```

Add `agentId: null,` as the last property of both existing `nodes.push({...})` objects (issue and board).

- [ ] **Step 4: Run the offline test to verify it passes**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/mounts/workspace-reads.search-types.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing DB-backed test for projects and agents**

Create `server-ts/src/mounts/workspace-reads.search.test.ts`:

```ts
// Global search over the new result types, against a two-workspace world.
//
// W1 has members U1 (the caller) and U3; W2 has member U2 only. Each workspace
// carries a project and an agent whose names share a random marker, so a
// search for the marker would surface W2's rows if the scope leaked. Driven
// through the real app with U1's session, gated on BERRY_TEST_DATABASE_URL so a
// fresh `pnpm test:server` stays green offline.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { SessionService } from '../auth/sessions.ts';
import { BoardRepository } from '../core/boards.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { workspaceReadMounts } from './workspace-reads.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;
const TTL_MS = 3_600_000;

interface SearchNode {
   type: string;
   id: string;
   title: string;
   subtitle: string | null;
   agentId: string | null;
}

interface World {
   marker: string;
   u1Token: string;
   u1Id: string;
   u3Id: string;
   w1Id: string;
   w2Id: string;
   w1ProjectId: string;
   w2ProjectId: string;
   w1DeletedProjectId: string;
   w1AgentId: string;
   w2AgentId: string;
   w1ArchivedAgentId: string;
   userIds: string[];
   workspaceIds: string[];
}

describe(
   'global search: projects, agents, chat and skills',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let app: BerryApp;
      const world = {} as World;

      async function insertUser(label: string): Promise<string> {
         const [row] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`search-${label}-${world.marker}@berry.test`}, ${`Search ${label}`})
            RETURNING id`;
         return row!.id as string;
      }

      async function insertWorkspace(label: string, ownerId: string): Promise<string> {
         const [row] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${`${label} ${world.marker}`}, ${`${label.toLowerCase()}-${world.marker}`},
                    ${sql.json({ issuePrefix: `${label}S`, defaultRole: 'member', allowMemberInvites: false } as never)},
                    ${ownerId})
            RETURNING id`;
         return row!.id as string;
      }

      async function insertProject(workspaceId: string, name: string, deleted = false): Promise<string> {
         const [row] = await sql`
            INSERT INTO projects (workspace_id, name, description, deleted_at)
            VALUES (${workspaceId}, ${name}, 'search fixture', ${deleted ? new Date() : null})
            RETURNING id`;
         return row!.id as string;
      }

      // runtime_agent_id was dropped by migration 032; do not insert it. (Keep this
      // note outside the tagged template: a backtick inside it ends the literal.)
      async function insertAgent(workspaceId: string, name: string, archived = false): Promise<string> {
         const [row] = await sql`
            INSERT INTO agents (workspace_id, name, description, archived_at)
            VALUES (${workspaceId}, ${name}, 'search fixture', ${archived ? new Date() : null})
            RETURNING id`;
         return row!.id as string;
      }

      before(async () => {
         sql = openDatabase({ url: url as string });
         const sessions = new SessionService({ sql, sessionTtlMs: TTL_MS });
         const boards = new BoardRepository(sql);
         const registry = new Registry();
         registry.registerAll(workspaceReadMounts({ sessions, sql, boards }));
         app = createApp(registry);

         world.marker = randomUUID().slice(0, 8);
         world.u1Id = await insertUser('u1');
         const u2Id = await insertUser('u2');
         world.u3Id = await insertUser('u3');
         world.userIds = [world.u1Id, u2Id, world.u3Id];

         world.w1Id = await insertWorkspace('W1', world.u1Id);
         world.w2Id = await insertWorkspace('W2', u2Id);
         world.workspaceIds = [world.w1Id, world.w2Id];
         await sql`
            INSERT INTO workspace_memberships (workspace_id, user_id, role)
            VALUES (${world.w1Id}, ${world.u1Id}, 'owner'),
                   (${world.w1Id}, ${world.u3Id}, 'member'),
                   (${world.w2Id}, ${u2Id}, 'owner')`;

         world.w1ProjectId = await insertProject(world.w1Id, `proj-${world.marker}-w1`);
         world.w2ProjectId = await insertProject(world.w2Id, `proj-${world.marker}-w2`);
         world.w1DeletedProjectId = await insertProject(world.w1Id, `proj-${world.marker}-gone`, true);

         world.w1AgentId = await insertAgent(world.w1Id, `agent-${world.marker}-w1`);
         world.w2AgentId = await insertAgent(world.w2Id, `agent-${world.marker}-w2`);
         world.w1ArchivedAgentId = await insertAgent(world.w1Id, `agent-${world.marker}-old`, true);

         world.u1Token = (await sessions.issueForUser(world.u1Id)).token;
      });

      after(async () => {
         if (!sql) return;
         if (world.workspaceIds?.length) {
            await sql`ALTER TABLE agents DISABLE TRIGGER berry_agents_block_protected_delete`;
            try {
               for (const ws of world.workspaceIds) {
                  await sql`DELETE FROM outbox_events WHERE workspace_id = ${ws}`;
                  await sql`DELETE FROM conversations WHERE workspace_id = ${ws}`;
                  await sql`DELETE FROM projects WHERE workspace_id = ${ws}`;
                  await sql`DELETE FROM agents WHERE workspace_id = ${ws}`;
                  await sql`DELETE FROM issue_status_definitions WHERE workspace_id = ${ws}`;
                  await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${ws}`;
                  await sql`DELETE FROM workspaces WHERE id = ${ws}`;
               }
            } finally {
               await sql`ALTER TABLE agents ENABLE TRIGGER berry_agents_block_protected_delete`;
            }
         }
         for (const uid of world.userIds ?? []) {
            await sql`DELETE FROM users WHERE id = ${uid}`;
         }
         await closeDatabase(sql);
      });

      async function search(types: string, query: string): Promise<SearchNode[]> {
         const response = await app.request(
            `/api/v1/search?workspaceId=${world.w1Id}&types=${types}&query=${encodeURIComponent(query)}`,
            { headers: { authorization: `Bearer ${world.u1Token}` } }
         );
         assert.equal(response.status, 200);
         return ((await response.json()) as { nodes: SearchNode[] }).nodes;
      }

      test('a project search finds the workspace’s live projects and nothing from another workspace', async () => {
         const nodes = await search('project', `proj-${world.marker}`);
         const ids = nodes.map((node) => node.id);
         assert.ok(ids.includes(world.w1ProjectId), 'W1 project is found');
         assert.ok(!ids.includes(world.w2ProjectId), 'W2 project must not leak into a W1 search');
         assert.ok(!ids.includes(world.w1DeletedProjectId), 'a deleted project is not found');
         assert.ok(nodes.every((node) => node.type === 'project' && node.agentId === null));
      });

      test('an agent search finds live agents of the workspace only', async () => {
         const nodes = await search('agent', `agent-${world.marker}`);
         const ids = nodes.map((node) => node.id);
         assert.ok(ids.includes(world.w1AgentId), 'W1 agent is found');
         assert.ok(!ids.includes(world.w2AgentId), 'W2 agent must not leak into a W1 search');
         assert.ok(!ids.includes(world.w1ArchivedAgentId), 'an archived agent is not found');
         const own = nodes.find((node) => node.id === world.w1AgentId);
         assert.equal(own?.agentId, world.w1AgentId, 'an agent result carries its own id as agentId');
      });

      test('an unknown type is a 422, not an empty result', async () => {
         const response = await app.request(
            `/api/v1/search?workspaceId=${world.w1Id}&types=initiative&query=x`,
            { headers: { authorization: `Bearer ${world.u1Token}` } }
         );
         assert.equal(response.status, 422);
      });
   }
);
```

- [ ] **Step 6: Run it against a test database to verify it fails**

Run (DB setup per `server-ts/ROUTING.md` "Running the database-backed tests"):
`cd /Users/secret/Code/berry-circle/server-ts && BERRY_TEST_DATABASE_URL='postgres://berry:berry@127.0.0.1:15432/berry_test?sslmode=disable' node --test --experimental-strip-types src/mounts/workspace-reads.search.test.ts`
Expected: the project and agent tests FAIL. Their `nodes` arrays are empty because the route accepts the types but has no branch for them. The 422 test PASSES. Without the env var the whole suite reports as skipped.

- [ ] **Step 7: Implement the project and agent branches**

In `searchRoute`, after the `if (types.has('board')) { … }` block and before `// No cursor:`, add:

```ts
      if (types.has('project')) {
         // `scope` is the pre-bound `workspace_id = ctx.workspaceId` fragment.
         const rows = await db.list((q) => q.sql`
            SELECT id, name, description
              FROM projects
             WHERE ${q.scope} AND deleted_at IS NULL AND name ILIKE ${like}
             ORDER BY updated_at DESC, id DESC
             LIMIT ${page.first}`);
         for (const row of rows) {
            nodes.push({
               type: 'project',
               id: row.id as string,
               title: row.name as string,
               subtitle: (row.description as string | null) ?? null,
               identifier: null,
               boardId: null,
               agentId: null,
            });
         }
      }

      if (types.has('agent')) {
         const rows = await db.list((q) => q.sql`
            SELECT id, name, description
              FROM agents
             WHERE ${q.scope} AND archived_at IS NULL AND name ILIKE ${like}
             ORDER BY name ASC, id ASC
             LIMIT ${page.first}`);
         for (const row of rows) {
            nodes.push({
               type: 'agent',
               id: row.id as string,
               title: row.name as string,
               subtitle: (row.description as string | null) ?? null,
               identifier: null,
               boardId: null,
               agentId: row.id as string,
            });
         }
      }
```

- [ ] **Step 8: Run both test files and the typecheck**

Run: `cd /Users/secret/Code/berry-circle/server-ts && BERRY_TEST_DATABASE_URL='postgres://berry:berry@127.0.0.1:15432/berry_test?sslmode=disable' node --test --experimental-strip-types src/mounts/workspace-reads.search-types.test.ts src/mounts/workspace-reads.search.test.ts src/mounts/cross-tenant-leakage.test.ts && cd .. && pnpm typecheck:server`
Expected: all PASS; typecheck exits 0. The existing cross-tenant board search still passes, which shows the `types=board` path is unchanged.

- [ ] **Step 9: Commit**

```bash
cd /Users/secret/Code/berry-circle
git add server-ts/src/mounts/workspace-reads.ts server-ts/src/mounts/workspace-reads.search-types.test.ts server-ts/src/mounts/workspace-reads.search.test.ts
git commit -m "feat(server-ts): let global search find projects and agents"
```

---

### Task 2: Server search — chat threads and skills

**Files:**
- Modify: `server-ts/src/mounts/workspace-reads.ts` (`searchRoute`)
- Modify: `server-ts/src/mounts/workspace-reads.search.test.ts`
- Modify: `server-ts/SCOPE.md` (Analytics row, line 40)

**Interfaces:**
- Consumes: `parseSearchTypes`, `SearchType`, node shape with `agentId` (Task 1); `context.get('user').id`; `options.sql` (raw pool, used only for the catalogue probe); tables `conversations`, `conversation_participants`, `agents` (migration 011 / 003).
- Produces: `type: 'chat'` nodes `{ id: conversationId, title: topic ?? agentName ?? 'Conversation', subtitle: agentName, identifier: null, boardId: null, agentId: agentId | null }`. They cover only open conversations the caller participates in, within the confirmed workspace. `type: 'skill'` nodes `{ id, title: name, subtitle: description, identifier: null, boardId: null, agentId: null }`, read from D's `skills` table only when it exists. Before D merges, a `skill` search returns zero nodes with status 200.

- [ ] **Step 1: Add the failing chat and skill tests**

In `workspace-reads.search.test.ts`:

Add to `interface World`:

```ts
   ownThreadId: string;
   foreignThreadId: string;
   crossTenantThreadId: string;
```

At the end of `before(...)`, before the session is issued, add:

```ts
         // U1's own thread with the W1 agent, found by topic and by agent name.
         const [own] = await sql`
            INSERT INTO conversations (workspace_id, kind, topic, created_by)
            VALUES (${world.w1Id}, 'direct', ${`thread-${world.marker}-mine`}, ${world.u1Id})
            RETURNING id`;
         world.ownThreadId = own!.id as string;
         await sql`
            INSERT INTO conversation_participants (conversation_id, participant_type, participant_id, role)
            VALUES (${world.ownThreadId}, 'user', ${world.u1Id}, 'owner'),
                   (${world.ownThreadId}, 'agent', ${world.w1AgentId}, 'member')`;

         // U3's thread in the same workspace. U1 is a fellow member but not a
         // participant, so it must stay private to U3.
         const [foreign] = await sql`
            INSERT INTO conversations (workspace_id, kind, topic, created_by)
            VALUES (${world.w1Id}, 'direct', ${`thread-${world.marker}-theirs`}, ${world.u3Id})
            RETURNING id`;
         world.foreignThreadId = foreign!.id as string;
         await sql`
            INSERT INTO conversation_participants (conversation_id, participant_type, participant_id, role)
            VALUES (${world.foreignThreadId}, 'user', ${world.u3Id}, 'owner')`;

         // A W2 thread that U1 participates in (participant rows carry no
         // membership FK). A W1-scoped search must still never return it, and
         // the W2 agent on it must not leak its name.
         const [crossTenant] = await sql`
            INSERT INTO conversations (workspace_id, kind, topic, created_by)
            VALUES (${world.w2Id}, 'direct', ${`thread-${world.marker}-w2`}, ${world.u1Id})
            RETURNING id`;
         world.crossTenantThreadId = crossTenant!.id as string;
         await sql`
            INSERT INTO conversation_participants (conversation_id, participant_type, participant_id, role)
            VALUES (${world.crossTenantThreadId}, 'user', ${world.u1Id}, 'owner'),
                   (${world.crossTenantThreadId}, 'agent', ${world.w2AgentId}, 'member')`;
```

Add these tests inside the `describe` after the agent test:

```ts
      test('a chat search finds the caller’s own threads by topic', async () => {
         const nodes = await search('chat', `thread-${world.marker}`);
         const ids = nodes.map((node) => node.id);
         assert.ok(ids.includes(world.ownThreadId), 'the caller’s thread is found');
         const own = nodes.find((node) => node.id === world.ownThreadId);
         assert.equal(own?.agentId, world.w1AgentId, 'a thread result names the agent it is with');
      });

      test('a chat search never surfaces a thread the caller is not in, even in their workspace', async () => {
         const nodes = await search('chat', `thread-${world.marker}`);
         assert.ok(!nodes.some((node) => node.id === world.foreignThreadId));
      });

      test('a chat search never surfaces the caller’s own thread from another workspace', async () => {
         const byTopic = await search('chat', `thread-${world.marker}`);
         assert.ok(!byTopic.some((node) => node.id === world.crossTenantThreadId));
         const byAgent = await search('chat', `agent-${world.marker}-w2`);
         assert.ok(!byAgent.some((node) => node.id === world.crossTenantThreadId));
         assert.ok(!byAgent.some((node) => node.agentId === world.w2AgentId));
      });

      test('a chat search also matches the agent’s name', async () => {
         const nodes = await search('chat', `agent-${world.marker}-w1`);
         assert.ok(nodes.some((node) => node.id === world.ownThreadId));
      });

      test('a skill search answers 200 whether or not the skills catalogue exists yet', async () => {
         const nodes = await search('skill', world.marker);
         assert.ok(Array.isArray(nodes));
         assert.ok(nodes.every((node) => node.type === 'skill'));
      });
```

- [ ] **Step 2: Run to verify the chat tests fail**

Run: `cd /Users/secret/Code/berry-circle/server-ts && BERRY_TEST_DATABASE_URL='postgres://berry:berry@127.0.0.1:15432/berry_test?sslmode=disable' node --test --experimental-strip-types src/mounts/workspace-reads.search.test.ts`
Expected: "finds the caller’s own threads" and "also matches the agent’s name" FAIL, because there is no chat branch. The privacy, cross-workspace and skill tests pass vacuously for now. They are regression guards, and they turn red if the branch drops either the participant predicate or the workspace scope. Check this once after Step 3 by temporarily replacing `${q.workspaceId}` in the conversation predicate with `conversation.workspace_id`. The cross-workspace test must fail. Then revert.

- [ ] **Step 3: Implement chat and skill branches**

In `searchRoute`, after the agent block from Task 1, add:

```ts
      if (types.has('chat')) {
         // Membership is not enough for a conversation: it is private to its
         // participants, so the caller must be one. The workspace predicate is
         // still the confirmed scope, so a thread in another workspace the
         // caller happens to be in never answers a search here.
         const userId = context.get('user').id;
         const rows = await db.list((q) => q.sql`
            SELECT conversation.id, conversation.topic,
                   agent.id AS agent_id, agent.name AS agent_name
              FROM conversations AS conversation
              JOIN conversation_participants AS me
                ON me.conversation_id = conversation.id
               AND me.participant_type = 'user'
               AND me.participant_id = ${userId}
               AND me.left_at IS NULL
              -- One agent per thread (LATERAL + LIMIT 1), so a thread with two
              -- agents is one row, not two with a duplicate React key. The agent
              -- is re-scoped to the confirmed workspace: participant_id has no
              -- FK, so an unscoped join could surface another tenant's agent name.
              LEFT JOIN LATERAL (
                 SELECT candidate.id, candidate.name
                   FROM conversation_participants AS bot
                   JOIN agents AS candidate
                     ON candidate.id = bot.participant_id
                    AND candidate.workspace_id = ${q.workspaceId}
                  WHERE bot.conversation_id = conversation.id
                    AND bot.participant_type = 'agent'
                    AND bot.left_at IS NULL
                  ORDER BY bot.joined_at ASC, candidate.id ASC
                  LIMIT 1
              ) AS agent ON true
             WHERE conversation.workspace_id = ${q.workspaceId}
               AND conversation.status = 'open'
               AND (conversation.topic ILIKE ${like} OR agent.name ILIKE ${like})
             ORDER BY conversation.updated_at DESC, conversation.id DESC
             LIMIT ${page.first}`);
         for (const row of rows) {
            const agentName = (row.agent_name as string | null) ?? null;
            nodes.push({
               type: 'chat',
               id: row.id as string,
               title: (row.topic as string | null) ?? agentName ?? 'Conversation',
               subtitle: agentName,
               identifier: null,
               boardId: null,
               agentId: (row.agent_id as string | null) ?? null,
            });
         }
      }

      if (types.has('skill') && (await skillsCatalogueExists(options.sql))) {
         const rows = await db.list((q) => q.sql`
            SELECT id, name, description
              FROM skills
             WHERE ${q.scope} AND name ILIKE ${like}
             ORDER BY name ASC, id ASC
             LIMIT ${page.first}`);
         for (const row of rows) {
            nodes.push({
               type: 'skill',
               id: row.id as string,
               title: row.name as string,
               subtitle: (row.description as string | null) ?? null,
               identifier: null,
               boardId: null,
               agentId: null,
            });
         }
      }
```

Below `searchRoute` (before the `viewsRoute` doc comment), add:

```ts
/**
 * Whether the skills catalogue has been migrated in yet. Skills belong to
 * another workstream's migration; until it lands, a skill search is an empty
 * answer rather than a 500 from a missing relation. A catalogue probe, not
 * workspace data, so it runs on the pool rather than through the scope.
 */
async function skillsCatalogueExists(sql: Sql): Promise<boolean> {
   const [row] = await sql`SELECT to_regclass('public.skills') IS NOT NULL AS present`;
   return row?.present === true;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/secret/Code/berry-circle/server-ts && BERRY_TEST_DATABASE_URL='postgres://berry:berry@127.0.0.1:15432/berry_test?sslmode=disable' node --test --experimental-strip-types src/mounts/workspace-reads.search.test.ts src/mounts/cross-tenant-leakage.test.ts && cd .. && pnpm typecheck:server && pnpm test:server`
Expected: all PASS. The final offline `pnpm test:server` passes with the DB suites skipped.

- [ ] **Step 5: Update SCOPE.md**

In `server-ts/SCOPE.md`, replace the Analytics row:

```
| Analytics | — | The rail links it, but no prefix exists. |
```

with:

```
| Analytics | — | No prefix exists, and the rail no longer links it. Usage and dashboard pages arrive with the usage workstream. |
```

- [ ] **Step 6: Commit**

```bash
cd /Users/secret/Code/berry-circle
git add server-ts/src/mounts/workspace-reads.ts server-ts/src/mounts/workspace-reads.search.test.ts server-ts/SCOPE.md
git commit -m "feat(server-ts): let global search find your chat threads and skills"
```

---

### Task 3: Frontend search client, palette results, chat deep link

**Files:**
- Modify: `frontend/lib/search.ts`
- Modify: `frontend/components/layout/command-palette.tsx`
- Modify: `frontend/components/common/chat/chat.tsx`
- Modify: `frontend/app/[orgId]/chat/page.tsx`

**Interfaces:**
- Consumes: the wire node shape from Tasks 1–2 (`agentId` nullable; the parser defaults it so an older server still validates); `useSessionStore((state) => state.workspace)` → `{ id, name, slug } | null`.
- Produces (in `frontend/lib/search.ts`):
  - `export const SEARCH_TYPES = ['issue', 'board', 'project', 'agent', 'chat', 'skill'] as const;`
  - `export type SearchType = (typeof SEARCH_TYPES)[number];`
  - `export type SearchResult = { type: SearchType; id: string; title: string; subtitle: string | null; identifier: string | null; boardId: string | null; agentId: string | null }`
  - `export const PALETTE_SEARCH_TYPES: SearchType[] = ['issue', 'project', 'agent', 'chat', 'skill'];`
  - `export async function searchWorkspace(workspaceId: string, query: string, types?: SearchType[]): Promise<SearchResult[]>`
  - `export function searchResultHref(result: SearchResult): string | null`: a path relative to `/{orgId}`, or null when the result has no page.
  - The chat page honours `/{orgId}/chat?agent={agentId}`.

The frontend has no test runner. The test cycle for this task is `pnpm lint` + `pnpm build:check`, plus a manual palette check.

- [ ] **Step 1: Rewrite `frontend/lib/search.ts`**

```ts
import { z } from 'zod';
import { apiFetch } from './api';
import { connectionSchema } from './api-schemas';

/** Every type `/api/v1/search` answers for. */
export const SEARCH_TYPES = ['issue', 'board', 'project', 'agent', 'chat', 'skill'] as const;

export type SearchType = (typeof SEARCH_TYPES)[number];

/** What the palette asks for. Boards are left out: a board has no page to open. */
export const PALETTE_SEARCH_TYPES: SearchType[] = ['issue', 'project', 'agent', 'chat', 'skill'];

const searchResultSchema = z.object({
   type: z.enum(SEARCH_TYPES),
   id: z.string(),
   title: z.string(),
   subtitle: z.string().nullable(),
   identifier: z.string().nullable(),
   boardId: z.string().nullable(),
   // Additive on the server; defaulted so an older server's answer still parses.
   agentId: z.string().nullable().default(null),
});

const searchConnectionSchema = connectionSchema(searchResultSchema);

export type SearchResult = z.infer<typeof searchResultSchema>;

export async function searchWorkspace(
   workspaceId: string,
   query: string,
   types: SearchType[] = ['issue']
): Promise<SearchResult[]> {
   const trimmed = query.trim();
   if (!workspaceId || trimmed.length < 1) return [];
   try {
      const params = new URLSearchParams({
         workspaceId,
         query: trimmed,
         types: types.join(','),
         first: '25',
      });
      const json: unknown = await apiFetch(`/api/v1/search?${params.toString()}`);
      const parsed = searchConnectionSchema.safeParse(json);
      if (!parsed.success) return [];
      return parsed.data.nodes;
   } catch {
      return [];
   }
}

/**
 * Where a result opens, relative to `/{orgId}`. Null when it has no page of
 * its own. The one place a result type is mapped to a route, so a page that
 * moves is fixed here rather than in every caller.
 */
export function searchResultHref(result: SearchResult): string | null {
   switch (result.type) {
      case 'issue':
         return result.identifier ? `/issue/${result.identifier}` : null;
      case 'project':
         return `/project/${result.id}/overview`;
      case 'agent':
         return `/agents/${result.id}`;
      case 'chat':
         return result.agentId ? `/chat?agent=${encodeURIComponent(result.agentId)}` : '/chat';
      case 'skill':
         return `/skills/${result.id}`;
      case 'board':
         return null;
   }
}
```

- [ ] **Step 2: Add the live Search group to the palette**

In `frontend/components/layout/command-palette.tsx`:

Add imports:

```ts
import { Bot, MessageSquare, Wrench } from 'lucide-react';
import {
   PALETTE_SEARCH_TYPES,
   searchResultHref,
   searchWorkspace,
   type SearchResult,
} from '@/lib/search';
import { useSessionStore } from '@/store/session-store';
```

Merge the `lucide-react` names into the existing `lucide-react` import rather than adding a second one.

Directly after `const allLabels = useLabelsStore((state) => state.labels);` add:

```ts
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? null);
   const [results, setResults] = useState<SearchResult[]>([]);

   // Server search only from the root, and only once the query is worth a
   // round trip. Debounced so typing a word is one request, not five; the
   // `cancelled` flag drops an answer that arrives after a newer keystroke.
   useEffect(() => {
      const trimmed = query.trim();
      if (!open || route !== 'root' || !workspaceId || trimmed.length < 2) {
         setResults([]);
         return;
      }
      let cancelled = false;
      const timer = window.setTimeout(() => {
         void searchWorkspace(workspaceId, trimmed, PALETTE_SEARCH_TYPES).then((found) => {
            if (!cancelled) setResults(found);
         });
      }, 150);
      return () => {
         cancelled = true;
         window.clearTimeout(timer);
      };
   }, [open, route, query, workspaceId]);

   const resultIcon = (type: SearchResult['type']) => {
      switch (type) {
         case 'issue':
            return <CircleDot className="text-muted-foreground" />;
         case 'project':
            return <Box className="text-muted-foreground" />;
         case 'agent':
            return <Bot className="text-muted-foreground" />;
         case 'chat':
            return <MessageSquare className="text-muted-foreground" />;
         default:
            return <Wrench className="text-muted-foreground" />;
      }
   };
```

Inside `<CommandList …>`, immediately after `<CommandEmpty>No results found.</CommandEmpty>`, add:

```tsx
                  {route === 'root' && results.length > 0 && (
                     <CommandGroup heading="Search">
                        {results.map((result) => {
                           const href = searchResultHref(result);
                           if (!href) return null;
                           return (
                              <CommandItem
                                 key={`${result.type}-${result.id}`}
                                 value={`${result.type}-${result.id}`}
                                 // The server already matched; cmdk's own filter
                                 // would drop a hit whose title lacks the literal
                                 // query (an agent-name match on a chat thread).
                                 forceMount
                                 onSelect={() => go(href)}
                              >
                                 {resultIcon(result.type)}
                                 {result.identifier ? (
                                    <span className="text-muted-foreground shrink-0">
                                       {result.identifier}
                                    </span>
                                 ) : null}
                                 <span className="truncate">{result.title}</span>
                                 {result.subtitle ? (
                                    <span className="ml-auto truncate text-muted-foreground">
                                       {result.subtitle}
                                    </span>
                                 ) : null}
                              </CommandItem>
                           );
                        })}
                     </CommandGroup>
                  )}
```

`reset` already clears `query`, and the effect then clears `results`, so closing the palette leaves no stale hits.

- [ ] **Step 3: Honour `?agent=` in chat**

In `frontend/components/common/chat/chat.tsx`, add `import { useSearchParams } from 'next/navigation';`. Then, directly after the `select` `useCallback`, add:

```ts
   // A search result or a link can name the agent to open: `/chat?agent=…`.
   // Waits for the agent list, and only opens an agent that can answer.
   const searchParams = useSearchParams();
   const requestedAgentId = searchParams?.get('agent') ?? null;
   useEffect(() => {
      if (!requestedAgentId || agent?.id === requestedAgentId) return;
      const match = agents.find((item) => item.id === requestedAgentId);
      if (match) void select(match);
   }, [requestedAgentId, agents, agent?.id, select]);
```

Replace `frontend/app/[orgId]/chat/page.tsx` with:

```tsx
import { Suspense } from 'react';

import { Chat } from '@/components/common/chat/chat';

// `Chat` reads the query string, which Next requires to sit under a Suspense
// boundary so the rest of the page can still prerender.
export default function ChatPage() {
   return (
      <Suspense fallback={null}>
         <Chat />
      </Suspense>
   );
}
```

- [ ] **Step 4: Lint and build**

Run: `cd /Users/secret/Code/berry-circle/frontend && pnpm lint && pnpm build:check`
Expected: both exit 0. If ESLint reports the new file as unformatted, run `pnpm exec prettier --write lib/search.ts components/layout/command-palette.tsx components/common/chat/chat.tsx app/[orgId]/chat/page.tsx` and re-run.

- [ ] **Step 5: Manual check**

With the stack and `pnpm dev:frontend` running, open `/{orgId}/my-issues`, press ⌘K and type two characters of a known project name. Expected: a "Search" group lists the project, and Enter opens `/{orgId}/project/{id}/overview`. Type the name of an agent you have chatted with. Expected: a chat row appears, and Enter opens `/chat?agent=…` with that thread loaded.

- [ ] **Step 6: Commit**

```bash
cd /Users/secret/Code/berry-circle
git add frontend/lib/search.ts frontend/components/layout/command-palette.tsx frontend/components/common/chat/chat.tsx "frontend/app/[orgId]/chat/page.tsx"
git commit -m "feat(frontend): search projects, agents, chat and skills from the palette"
```

---

### Task 4: Rail and settings navigation; delete the legacy sidebar and placeholder settings

**Files:**
- Modify: `frontend/components/layout/shell/shell-routes.ts`
- Modify: `frontend/store/sidebar-prefs-store.ts` (`DEFAULT_ORDER`, lines 62–69)
- Modify: `frontend/components/layout/sidebar/customize-sidebar-dialog.tsx` (lines 19–53)
- Modify: `frontend/components/layout/sidebar/nav-settings.tsx`
- Modify: `frontend/components/layout/shell/shell-rail-settings.tsx` (doc comment, line 17)
- Modify: `frontend/components/layout/command-palette.tsx` ("Go to" group)
- Modify: `frontend/eslint.config.mjs`
- Delete: `frontend/components/layout/sidebar/{app-sidebar,nav-inbox,nav-account,nav-features,nav-workspace,help-button,org-switcher,back-to-app}.tsx`, `frontend/data/side-bar-nav.ts`, `frontend/data/documents.ts`
- Delete: `frontend/app/[orgId]/settings/{agent-personalization,code-and-reviews,issue-templates,slas,project-labels,project-templates,project-updates,initiatives,documents,customer-requests,releases,pulse,asks,emojis}/`, `frontend/components/common/settings/settings-placeholder.tsx`, `frontend/components/common/settings/placeholder-sections.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `ShellRoute` becomes `'issues' | 'runs' | 'reviews' | 'chat' | 'inbox' | 'projects' | 'goals' | 'members'` (`'analytics'` removed).
  - `FIXTURE_IMPORT_PATHS` in `frontend/eslint.config.mjs` is an array of `{ name: string; importNames?: string[]; message: string }`, fed to `no-restricted-imports`. Tasks 5 and 6 append to it.
  - `settingsNav: SettingsNavGroup[]` keeps its name and shape; the `NavSettings` component is removed.

- [ ] **Step 1: Add the guard and prove it fires**

In `frontend/eslint.config.mjs`, above `const eslintConfig = [`, add:

```js
/* Fixture collections and surfaces with no backend. The frontend talks to
   Berry only; an import from this list would render an empty fake instead of
   real data, or bring a hidden surface back into navigation. Each workstream
   task that removes a fixture adds its entry here so it cannot return. */
const FIXTURE_IMPORT_PATHS = [
   {
      name: '@/data/side-bar-nav',
      message: 'The legacy sidebar is gone; navigation lives in shell-routes.ts and nav-settings.tsx.',
   },
   {
      name: '@/data/documents',
      message: 'Documents have no backend and are hidden from navigation.',
   },
   {
      name: '@/components/common/settings/settings-placeholder',
      message: 'Placeholder settings pages are hidden, not faked. Build a real settings page instead.',
   },
];
```

In the first rules object (the one with `files: ['**/*.{ts,tsx}']`), add beside `'no-restricted-syntax'`:

```js
         'no-restricted-imports': ['error', { paths: FIXTURE_IMPORT_PATHS }],
```

Prove the guard fires by creating `frontend/lib/__guard_probe.ts`:

```ts
import { featuresItems } from '@/data/side-bar-nav';
export const probe = featuresItems;
```

Run: `cd /Users/secret/Code/berry-circle/frontend && pnpm exec eslint lib/__guard_probe.ts`
Expected: FAIL with `'@/data/side-bar-nav' import is restricted from being used. The legacy sidebar is gone…`.
Then delete the probe: `rm lib/__guard_probe.ts`.

- [ ] **Step 2: Confirm the legacy sidebar is dead code**

Run: `cd /Users/secret/Code/berry-circle/frontend && grep -rnE "sidebar/(app-sidebar|nav-inbox|nav-account|nav-features|nav-workspace|help-button|org-switcher|back-to-app)|data/side-bar-nav|data/documents|settings-placeholder|placeholder-sections|NavSettings" app components hooks lib store`
Expected: matches only inside the files this task deletes, the `app/[orgId]/settings/<placeholder>/page.tsx` files, `nav-settings.tsx` itself, and the doc comment at `components/layout/shell/shell-rail-settings.tsx:17` (rewritten in Step 4). If anything else matches, stop and report it.

- [ ] **Step 3: Delete the legacy sidebar, documents fixture and placeholder settings**

```bash
cd /Users/secret/Code/berry-circle/frontend
git rm components/layout/sidebar/app-sidebar.tsx components/layout/sidebar/nav-inbox.tsx \
   components/layout/sidebar/nav-account.tsx components/layout/sidebar/nav-features.tsx \
   components/layout/sidebar/nav-workspace.tsx components/layout/sidebar/help-button.tsx \
   components/layout/sidebar/org-switcher.tsx components/layout/sidebar/back-to-app.tsx \
   data/side-bar-nav.ts data/documents.ts \
   components/common/settings/settings-placeholder.tsx components/common/settings/placeholder-sections.ts
for slug in agent-personalization code-and-reviews issue-templates slas project-labels \
   project-templates project-updates initiatives documents customer-requests releases pulse asks emojis; do
   git rm -r "app/[orgId]/settings/$slug"
done
```

- [ ] **Step 4: Trim the settings nav**

Replace `frontend/components/layout/sidebar/nav-settings.tsx` with:

```tsx
import { Bell, Blocks, Columns3, KeyRound, LucideIcon, Settings, Sparkles, Tag, UserRound, Users } from 'lucide-react';

interface SettingsNavItem {
   name: string;
   /** Path under /{orgId}. */
   url: string;
   icon: LucideIcon;
}

interface SettingsNavGroup {
   label: string;
   items: SettingsNavItem[];
}

/**
 * Settings navigation, rendered by the rail in settings mode.
 *
 * Only pages with a backend are listed. A workstream that ships a settings
 * page appends its item here in the same change; a page with nothing behind
 * it is not listed and not built.
 */
export const settingsNav: SettingsNavGroup[] = [
   {
      label: 'personal',
      items: [
         { name: 'preferences', url: '/settings/preferences', icon: Settings },
         { name: 'profile', url: '/settings/profile', icon: UserRound },
         { name: 'notifications', url: '/settings/notifications', icon: Bell },
         { name: 'security & access', url: '/settings/security', icon: KeyRound },
         { name: 'connected accounts', url: '/settings/connected-accounts', icon: Users },
      ],
   },
   {
      label: 'workspace',
      items: [
         { name: 'agents', url: '/settings/ai', icon: Sparkles },
         { name: 'task labels', url: '/settings/issue-labels', icon: Tag },
         { name: 'statuses', url: '/settings/project-statuses', icon: Columns3 },
         { name: 'integrations', url: '/settings/integrations', icon: Blocks },
      ],
   },
];
```

(Prettier will wrap the long `lucide-react` import.)

In `frontend/components/layout/shell/shell-rail-settings.tsx`, the doc comment says `The route data comes from \`settingsNav\`, which NavSettings already exports,`. Change that line to:

```ts
 * The route data comes from `settingsNav` in `nav-settings.tsx`,
```

- [ ] **Step 5: Rail — add chat, drop the analytics placeholder**

In `frontend/components/layout/shell/shell-routes.ts`:

Replace the `ShellRoute` union with:

```ts
export type ShellRoute =
   | 'issues'
   | 'runs'
   | 'reviews'
   | 'chat'
   | 'inbox'
   | 'projects'
   | 'goals'
   | 'members';
```

In `WORK`, insert after the `reviews` entry:

```ts
   {
      id: 'chat',
      label: 'chat',
      href: '/chat',
      prefsKey: 'chat',
      icon: '<path d="M4 5h16v11H9l-5 4z" />',
   },
```

In `MANAGE`, delete the whole `analytics` object (the one with `id: 'analytics'` and no `href`). Replace the doc comment on `href` with:

```ts
   /** Route this navigates to, relative to the workspace. Every rail item has a page. */
```

In `frontend/store/sidebar-prefs-store.ts`, change `DEFAULT_ORDER` to:

```ts
const DEFAULT_ORDER: Record<SidebarSection, SidebarItemKey[]> = {
   personal: [],
   // Goals sits under projects because that is where a goal comes from: it
   // groups the tasks one plan compiled inside a project.
   workspace: ['projects', 'goals', 'my-issues', 'reviews', 'chat'],
   automate: [],
   configure: ['agent', 'agents'],
};
```

In the same file, remove `| 'analytics'` from the `SidebarItemKey` union and `'analytics': 'always',` from `DEFAULT_VISIBILITY`. `resolveOrder` drops `analytics` from stored orders and inserts `chat` after `reviews`. The `merge` spreads a stored `visibility` over the defaults, so a stale `analytics` key in a browser is carried but never read. The persisted `sidebar-prefs-v6` key therefore needs no bump.

In `frontend/components/layout/sidebar/customize-sidebar-dialog.tsx`, replace `BarChart3,` with `MessageSquare,` in the `lucide-react` import, and change the two lists to:

```ts
export const WORKSPACE_ITEMS: ItemConfig[] = [
   { key: 'my-issues', label: 'tasks', icon: FolderKanban },
   { key: 'reviews', label: 'reviews', icon: GitPullRequest },
   { key: 'chat', label: 'chat', icon: MessageSquare },
   { key: 'goals', label: 'goals', icon: Target },
   { key: 'projects', label: 'projects', icon: Box },
];

export const CONFIGURE_ITEMS: ItemConfig[] = [
   { key: 'agent', label: 'runtimes', icon: Activity },
   { key: 'agents', label: 'agents', icon: Sparkles },
];
```

- [ ] **Step 6: Palette "Go to" — add Chat**

In `command-palette.tsx`, in the "Go to" `CommandGroup`, insert after the Reviews item:

```tsx
                           <CommandItem onSelect={() => go('/chat')}>
                              <MessageSquare className="text-muted-foreground" /> Chat
                           </CommandItem>
```

(`MessageSquare` was imported in Task 3.)

- [ ] **Step 7: Lint, build, manual check**

Run: `cd /Users/secret/Code/berry-circle/frontend && pnpm lint && pnpm build:check`
Expected: both exit 0.
Manual check: the rail shows tasks, reviews, chat, goals, projects under Work and runtimes, agents under Manage, with no analytics entry. "Customize sidebar" lists chat. `/{orgId}/settings/emojis` returns the not-found page. Settings mode lists 9 items.

- [ ] **Step 8: Commit**

```bash
cd /Users/secret/Code/berry-circle
git add -A frontend/eslint.config.mjs frontend/components frontend/app frontend/data frontend/store/sidebar-prefs-store.ts
git commit -m "feat(frontend): link chat from the rail and drop navigation to surfaces with no backend"
```

---

### Task 5: Remove initiatives and cycles

**Files:**
- Delete: `frontend/app/[orgId]/initiatives/`, `frontend/app/[orgId]/initiative/`, `frontend/app/[orgId]/@drawer/(.)initiative/`, `frontend/components/common/initiatives/`, `frontend/components/layout/headers/initiative/`, `frontend/components/layout/headers/initiatives/`, `frontend/store/initiatives-display-store.ts`, `frontend/store/initiatives-filter-store.ts`, `frontend/data/initiatives.ts`, `frontend/data/cycles.ts`, `frontend/components/common/cycles/cycle-icon.tsx`
- Modify: `frontend/components/layout/shell/shell-tab-model.ts` (line 28)
- Modify: `frontend/store/sidebar-prefs-store.ts` (`SidebarItemKey`, `DEFAULT_VISIBILITY`)
- Modify: `frontend/components/common/projects/project-peek-panel.tsx` (lines 14–16, 186–202)
- Modify: `frontend/components/common/projects/details/project-properties-panel.tsx` also lines 20 and 387–402 (Slack and Initiatives rows)
- Modify: `frontend/components/layout/command-palette.tsx`
- Modify: `frontend/components/common/issues/issue-line.tsx` (lines 4, 24, 66–70)
- Modify: `frontend/components/common/issues/details/issue-properties-panel.tsx` (lines 4, 6, 34, 56–61)
- Modify: `frontend/components/layout/headers/issue/header-nav.tsx`
- Modify: `frontend/components/common/projects/details/project-properties-panel.tsx` (line 9, `cycleRows` ~307–320, Cycles tab ~520–532)
- Modify: `frontend/components/common/issues/issue-filter-columns.tsx` (line 7, `cycleOptions` 58–70, cycle column 162–169)
- Modify: `frontend/components/common/issues/use-panel-filter.ts` (line 9)
- Modify: `frontend/store/display-settings-store.ts` (lines 8–41)
- Modify: `frontend/eslint.config.mjs` (`FIXTURE_IMPORT_PATHS`)

**Interfaces:**
- Consumes: `FIXTURE_IMPORT_PATHS` (Task 4).
- Produces:
  - `DisplayPropertyKey` = `'id' | 'status' | 'priority' | 'assignee' | 'labels' | 'project' | 'dueDate' | 'created'`.
  - `PanelFilterTarget['columnId']` = `'status' | 'assignee' | 'priority' | 'labels' | 'project'`.
  - `Issue.cycleId` stays on the type as an unread vestige (like `teamId`, per `AGENTS.md`).
  - `components/common/cycles/capacity-ring.tsx` stays; projects use it.

- [ ] **Step 1: Extend the guard and prove it fires**

Append to `FIXTURE_IMPORT_PATHS`:

```js
   {
      name: '@/data/cycles',
      message: 'Cycles have no backend and are hidden from navigation.',
   },
   {
      name: '@/data/initiatives',
      message: 'Initiatives have no backend and are hidden from navigation.',
   },
   {
      name: '@/components/common/cycles/cycle-icon',
      message: 'Cycles have no backend and are hidden from navigation.',
   },
```

Run: `cd /Users/secret/Code/berry-circle/frontend && pnpm lint`
Expected: FAIL. It lists `'@/data/cycles' import is restricted` in `issue-line.tsx`, `issue-properties-panel.tsx`, `header-nav.tsx`, `project-properties-panel.tsx`, `issue-filter-columns.tsx`, `command-palette.tsx`, and `'@/data/initiatives'` in the initiatives components. These are the call sites this task removes.

- [ ] **Step 2: Confirm the initiatives tree is self-contained, then delete it**

Run: `cd /Users/secret/Code/berry-circle/frontend && grep -rnE "common/initiatives|initiatives-display-store|initiatives-filter-store|headers/initiatives?/|data/initiatives" app components hooks lib store | grep -vE "^(components/common/initiatives/|components/layout/headers/initiatives?/|app/\[orgId\]/(initiatives|initiative)/|app/\[orgId\]/@drawer/\(\.\)initiative/|store/initiatives-)"`
Expected: no output.

```bash
cd /Users/secret/Code/berry-circle/frontend
git rm -r "app/[orgId]/initiatives" "app/[orgId]/initiative" "app/[orgId]/@drawer/(.)initiative" \
   components/common/initiatives components/layout/headers/initiative \
   components/layout/headers/initiatives \
   store/initiatives-display-store.ts store/initiatives-filter-store.ts data/initiatives.ts \
   data/cycles.ts components/common/cycles/cycle-icon.tsx
```

In `frontend/components/layout/shell/shell-tab-model.ts`, delete the line `   'initiative': 'initiatives',` from `SECTION_LABELS`.

In `frontend/store/sidebar-prefs-store.ts`, remove `| 'initiatives'` from `SidebarItemKey` and `'initiatives': 'always',` from `DEFAULT_VISIBILITY`.

- [ ] **Step 2b: Drop the faked Initiatives and Slack rows from both project panels**

Both `project-properties-panel.tsx` and `project-peek-panel.tsx` render an "Initiatives" row, which always reads "No initiative" because no initiative exists. They also render a "Slack · Connect channel" button that does nothing; Slack is out of scope per spec §7. In **each** file, delete these two adjacent elements in full:

```tsx
               <PropertyRow label="Slack">
                  <button className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors">
                     <Slack className="size-3.5" />
                     Connect channel
                  </button>
               </PropertyRow>
               <PropertyRow label="Initiatives">
                  {project.initiative ? (
                     <span className="truncate max-w-44">{project.initiative}</span>
                  ) : (
                     <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                        <Compass className="size-3.5" />
                        No initiative
                     </span>
                  )}
               </PropertyRow>
```

Then remove `Compass` and `Slack` from each file's `lucide-react` import; nothing else in either file uses them. `Project.initiative` stays on the type as an unread vestige, the same treatment `AGENTS.md` gives `teamId`.

- [ ] **Step 3: Palette — drop the cycle route, the initiatives link and the fake release action**

In `command-palette.tsx`:
- Delete `import { cycles, formatCycleDateRange } from '@/data/cycles';`.
- Change `PaletteRoute` to `'root' | 'assign' | 'status' | 'priority' | 'labels' | 'project' | 'due-date'`.
- Delete the `CommandItem` whose label is `Move to cycle…` (it calls `setRoute('cycle')`).
- Delete the `CommandItem` whose label is `Add to release…`. It only toasts "Added to the next release", and no release exists.
- Delete the `{route === 'cycle' && issue && ( … )}` block in full.
- Delete the `CommandItem` with `go('/initiatives')`.
- Remove `Compass` and `PackagePlus` from the `lucide-react` import.

- [ ] **Step 4: Remove cycle rendering from issue surfaces**

`issue-line.tsx`: delete line 4 (`import { getCycleById } from '@/data/cycles';`), delete line 24 (`const cycle = …`), and delete the block:

```tsx
                  {cycle && (
                     <span className="text-muted-foreground border border-border rounded-md px-1.5 py-0.5 shrink-0 hidden lg:inline-block">
                        {cycle.name}
                     </span>
                  )}
```

`issue-properties-panel.tsx`: delete `import { CyclePlayIcon } from '@/components/common/cycles/cycle-icon';`, `import { getCycleById } from '@/data/cycles';`, the line `const cycle = issue.cycleId ? getCycleById(issue.cycleId) : undefined;`, and the block:

```tsx
                     {cycle && (
                        <div className="flex items-center gap-2 mt-0.5">
                           <CyclePlayIcon className="size-4" />
                           <span>{cycle.name}</span>
                        </div>
                     )}
```

`headers/issue/header-nav.tsx`: delete the two cycle imports and `const cycle = …`. Delete the `{cycle && ( <> … </> )}` fragment at the top of the left `div`. Change the doc comment to `Issue page header: identifier + title, and previous / next navigation across the issue list.` Then remove `ChevronRight` from the `lucide-react` import if nothing else in the file uses it.

- [ ] **Step 5: Remove cycle breakdowns and filters**

`project-properties-panel.tsx`: delete `import { getCycleById } from '@/data/cycles';`. Delete the whole `const cycleRows = useMemo(…, [issues]);` declaration, from `const cycleRows = useMemo(` to its closing `);`. Delete these two JSX elements:

```tsx
                  <TabsTrigger value="cycles" className="px-2.5 rounded-full">
                     Cycles
                  </TabsTrigger>
```

```tsx
               <TabsContent value="cycles">
                  <BreakdownList rows={cycleRows} panelFilter={panelFilter} />
               </TabsContent>
```

`issue-filter-columns.tsx`: delete `import { cycles, cycleStatusLabel } from '@/data/cycles';`, the whole `const cycleOptions: ColumnOption[] = [ … ];`, and the column:

```ts
      dtf
         .option()
         .id('cycle')
         .accessor((issue: Issue) => (issue.cycleId === '' ? 'no-cycle' : issue.cycleId))
         .displayName('Cycle')
         .icon(RefreshCcw)
         .options(cycleOptions)
         .build(),
```

Then remove `RefreshCcw,` from its `lucide-react` import.

`use-panel-filter.ts`: change line 9 to `   columnId: 'status' | 'assignee' | 'priority' | 'labels' | 'project';`.

`display-settings-store.ts`: remove `| 'cycle'` from `DisplayPropertyKey`, remove `{ key: 'cycle', label: 'Cycle' },` from `DISPLAY_PROPERTIES` and `cycle: false,` from `DEFAULT_DISPLAY_PROPERTIES`. A stale `cycle` key in a browser's persisted state is ignored because nothing reads it.

- [ ] **Step 6: Lint and build**

Run: `cd /Users/secret/Code/berry-circle/frontend && pnpm lint && pnpm build:check`
Expected: both exit 0. `next build` type-checking catches any leftover `cycle` reference.

- [ ] **Step 7: Manual check**

Open a task page, a task list with Display → properties, and a project's properties panel and peek panel. Expected: no Cycle property, filter, breakdown tab or breadcrumb anywhere; no Initiatives or Slack row on a project; and ⌘K shows no "Move to cycle…", "Add to release…" or "Initiatives". `/{orgId}/initiatives` shows not-found.

- [ ] **Step 8: Commit**

```bash
cd /Users/secret/Code/berry-circle
git add -A frontend
git commit -m "feat(frontend): remove initiatives and cycles, which have no backend"
```

---

### Task 6: Stop seeding stores and pages from fixture collections

**Files:**
- Modify: `frontend/store/issues-store.ts` (line 1, lines 116–117)
- Modify: `frontend/store/projects-store.ts` (line 2, line 51)
- Modify: `frontend/store/notifications-store.ts` (line 1, line 71)
- Modify: `frontend/app/[orgId]/profiles/[memberId]/page.tsx`
- Modify: `frontend/app/[orgId]/@drawer/(.)profiles/[memberId]/page.tsx`
- Modify: `frontend/components/layout/headers/members/header-nav.tsx`
- Modify: `frontend/components/layout/headers/profile/header.tsx` (lines ~115–130)
- Modify: `frontend/components/layout/sidebar/create-new-issue/assignee-selector.tsx` (lines 13, 32)
- Modify: `frontend/components/common/members/member-profile.tsx` (lines 11–14, 113–196)
- Modify: `frontend/components/layout/headers/view/header.tsx`
- Modify: `frontend/data/users.ts`, `frontend/data/labels.ts`, `frontend/data/projects.ts`, `frontend/data/issues.ts`, `frontend/data/inbox.ts`, `frontend/data/views.ts`
- Modify: `frontend/eslint.config.mjs`, `frontend/ARCHITECTURE.md`

**Interfaces:**
- Consumes: `FIXTURE_IMPORT_PATHS` (Task 4). `useMembersStore` → `{ members: User[]; getMemberById(id): User | undefined }`. `useLabelsStore((s) => s.labels)`. `useProjectsStore((s) => s.projects)`.
- Produces:
  - `data/users.ts` exports `User`, `statusUserColors`, `currentUser` (kept; see Open Questions) and no `users`.
  - `data/labels.ts` exports only `LabelInterface`.
  - `data/projects.ts` keeps its types and the `health` vocabulary, and drops `projects`, `getProjectById` and `getProjectsByTeam`.
  - `data/issues.ts` drops `issues`.
  - `data/inbox.ts` drops `inboxItems`.
  - `data/views.ts` keeps `ViewType`, `ViewFilter`, `View`, `filterIssuesForView(view, source)` and `filterProjectsForView(view, source)`, and drops `views`, `issueViews`, `projectViews`, `getViewsByTeam` and `getViewById`. Views are read from `useViewsStore((s) => s.getViewById(id))`.
  - The stores start empty and are filled by their existing hydrate actions.

- [ ] **Step 1: Extend the guard and see it fail**

Append to `FIXTURE_IMPORT_PATHS`:

```js
   {
      name: '@/data/users',
      importNames: ['users'],
      message: 'Members come from useMembersStore, hydrated from the API.',
   },
   {
      name: '@/data/labels',
      importNames: ['labels'],
      message: 'Labels come from useLabelsStore, hydrated from the API.',
   },
   {
      name: '@/data/projects',
      importNames: ['projects', 'getProjectById', 'getProjectsByTeam'],
      message: 'Projects come from useProjectsStore, hydrated from the API.',
   },
   {
      name: '@/data/issues',
      importNames: ['issues'],
      message: 'Issues come from useIssuesStore, hydrated from the API.',
   },
   {
      name: '@/data/inbox',
      importNames: ['inboxItems'],
      message: 'Notifications come from the inbox API.',
   },
   {
      name: '@/data/views',
      importNames: ['views', 'issueViews', 'projectViews', 'getViewsByTeam', 'getViewById'],
      message: 'Saved views come from useViewsStore, hydrated from the API.',
   },
```

Run: `cd /Users/secret/Code/berry-circle/frontend && pnpm lint`
Expected: FAIL. It flags the stores (`issues as mockIssues`, `projects as seedProjects`, `inboxItems as mockNotifications`), both profiles pages, `members/header-nav.tsx`, `profile/header.tsx`, `assignee-selector.tsx`, `member-profile.tsx` and `headers/view/header.tsx` (`getViewById`).

- [ ] **Step 2: Stores start empty**

`issues-store.ts` line 1 → `import { Issue } from '@/data/issues';`. Keep `groupIssuesByStatus` in the import if the file uses it elsewhere; run `grep -n groupIssuesByStatus store/issues-store.ts` to check. Lines 116–117 →

```ts
   issues: [],
   issuesByStatus: {},
```

`projects-store.ts` line 2 → `import { health, Project } from '@/data/projects';`; line 51 → `   projects: [],`.

`notifications-store.ts` line 1 → `import { InboxItem, NotificationType } from '@/data/inbox';`; line 71 → `   notifications: [],`.

- [ ] **Step 3: Profiles read members from the store**

Replace `frontend/app/[orgId]/profiles/[memberId]/page.tsx` with:

```tsx
'use client';

import { notFound, useParams } from 'next/navigation';

import MemberProfile from '@/components/common/members/member-profile';
import Header from '@/components/layout/headers/profile/header';
import MainLayout from '@/components/layout/main-layout';
import { useMembersStore } from '@/store/members-store';

export default function MemberProfilePage() {
   const { memberId } = useParams<{ orgId: string; memberId: string }>();
   const members = useMembersStore((state) => state.members);
   const member = members.find((candidate) => candidate.id === memberId);

   if (!member) {
      // Members hydrate after the session loads; only an answered list that
      // lacks the id is a real miss.
      if (members.length > 0) notFound();
      return null;
   }

   return (
      <MainLayout header={<Header member={member} />}>
         <MemberProfile member={member} />
      </MainLayout>
   );
}
```

In `app/[orgId]/@drawer/(.)profiles/[memberId]/page.tsx`, replace `import { users } from '@/data/users';` with `import { useMembersStore } from '@/store/members-store';`, and replace `const member = users.find((user) => user.id === memberId);` with:

```ts
   const member = useMembersStore((state) => state.getMemberById(memberId));
```

`headers/members/header-nav.tsx`: replace `import { users } from '@/data/users';` with `import { useMembersStore } from '@/store/members-store';`. Add as the first line of the component body:

```ts
   const memberCount = useMembersStore((state) => state.members.length);
```

Then replace `{users.length}` with `{memberCount}`.

- [ ] **Step 4: Profile header, member profile and assignee selector use stores**

`headers/profile/header.tsx`: change the `@/data/users` import to drop `users`, and add `import { useMembersStore } from '@/store/members-store';`. At the top of `Header`, add `const members = useMembersStore((state) => state.members);`, then replace the two `users.` references in the `memberIndex` / `count` block:

```ts
   const memberIndex = Math.max(
      0,
      members.findIndex((candidate) => candidate.id === member.id)
   );
   const count =
      activeTab === 'created'
         ? issues.filter((issue) => issueCreatorIndex(issue, members.length) === memberIndex).length
         : issues.filter((issue) => issue.assignee?.id === member.id).length;
```

`member-profile.tsx`: delete `import { labels } from '@/data/labels';` and `import { projects } from '@/data/projects';`. Change `import { statusUserColors, User, users } from '@/data/users';` to `import { statusUserColors, User } from '@/data/users';`. Add:

```ts
import { useLabelsStore } from '@/store/labels-store';
import { useMembersStore } from '@/store/members-store';
import { useProjectsStore } from '@/store/projects-store';
```

At the top of `MemberProfile`, after `const { issues } = useIssuesStore();`, add:

```ts
   const members = useMembersStore((state) => state.members);
   const workspaceLabels = useLabelsStore((state) => state.labels);
   const workspaceProjects = useProjectsStore((state) => state.projects);
```

Then:
- In `memberIndex` and `scopedIssues`, replace `users.findIndex` with `members.findIndex`, and `users.length` with `members.length`. Add `members.length` to the `scopedIssues` dependency array: `[issues, activeTab, member.id, memberIndex, members.length]`.
- In `memberProjects`, replace `projects.filter(` with `workspaceProjects.filter(`, and change its deps to `[displayedIssues, member.id, workspaceProjects]`.
- In `labelRows`, replace `return labels` with `return workspaceLabels`, and its deps with `[displayedIssues, workspaceLabels]`.
- In `projectRows`, replace `return projects` with `return workspaceProjects`, and its deps with `[displayedIssues, workspaceProjects]`.

`assignee-selector.tsx`: line 13 → `import { User } from '@/data/users';`. Add `import { useMembersStore } from '@/store/members-store';`. Before `const agents = …`, add `const members = useMembersStore((state) => state.members);`. On line 32, replace `[...users,` with `[...members,`.

`headers/view/header.tsx` reads the empty `views` fixture through `getViewById`, so the header of a real saved view renders nothing. Replace the file with:

```tsx
'use client';

import { Button } from '@/components/ui/button';
import { filterIssuesForView, filterProjectsForView } from '@/data/views';
import { useIssuesStore } from '@/store/issues-store';
import { useProjectsStore } from '@/store/projects-store';
import { useRightPanelStore } from '@/store/right-panel-store';
import { useViewsStore } from '@/store/views-store';
import { BarChart3, MoreHorizontal, Star } from 'lucide-react';
import { useParams } from 'next/navigation';

export default function Header() {
   const { viewId } = useParams<{ orgId: string; viewId: string }>();
   const view = useViewsStore((state) => state.getViewById(viewId));
   const issues = useIssuesStore((state) => state.issues);
   const projects = useProjectsStore((state) => state.projects);
   const { openPanel, togglePanel } = useRightPanelStore();

   if (!view) return null;

   const count =
      view.type === 'issue'
         ? filterIssuesForView(view, issues).length
         : filterProjectsForView(view, projects).length;

   return (
      <div className="w-full flex flex-col">
         <div className="w-full flex justify-between items-center border-b py-1.5 px-6 h-10">
            <div className="flex items-center gap-2 min-w-0">
               <span className="inline-flex size-5 items-center justify-center rounded bg-muted/50 shrink-0">
                  {view.icon}
               </span>
               <span className="font-medium truncate">{view.name}</span>
               <Star className="size-3.5 text-muted-foreground shrink-0 ml-1" />
               <MoreHorizontal className="size-3.5 text-muted-foreground shrink-0" />
            </div>
         </div>
         <div className="w-full flex justify-between items-center border-b py-1.5 px-6 h-10">
            <span className="text-muted-foreground">
               {count} {view.type === 'issue' ? 'issues' : 'projects'}
            </span>
            {view.type === 'issue' && (
               <Button
                  size="xs"
                  variant={openPanel === 'insights' ? 'secondary' : 'ghost'}
                  onClick={() => togglePanel('insights')}
               >
                  <BarChart3 className="size-4" />
               </Button>
            )}
         </div>
      </div>
   );
}
```

- [ ] **Step 5: Delete the fixture collections from `data/`**

- `data/users.ts`: delete the `users` doc comment and `export const users: User[] = [];`.
- `data/labels.ts`: delete the doc comment and `export const labels: LabelInterface[] = [];`.
- `data/projects.ts`: delete `export const projects: Project[] = [];`, its doc comment, `getProjectById` and `getProjectsByTeam`.
- `data/issues.ts`: delete the `Issues` section banner and `export const issues: Issue[] = [];`.
- `data/inbox.ts`: delete the doc comment and `export const inboxItems: InboxItem[] = [];`.
- `data/views.ts`: delete `/** Saved views of the workspace. … */`, `export const views`, `issueViews`, `projectViews`, `getViewsByTeam` and `getViewById`. Keep the types and the two `filter…ForView` helpers, which already take their source as a parameter.

Run: `cd /Users/secret/Code/berry-circle/frontend && grep -rnE "\b(mockIssues|seedProjects|mockNotifications)\b" app components hooks lib store; grep -rnE "export const (users|labels|projects|issues|inboxItems|views|issueViews|projectViews)\b|export function (getProjectById|getProjectsByTeam|getViewsByTeam|getViewById)\b" data`
Expected: no output from either. Then `pnpm lint` (next step) proves no importer is left, because the guard names every removed export.

- [ ] **Step 6: Document the rule**

In `frontend/ARCHITECTURE.md`:
- In the diagram, change `Zustand store (store/…)  ← seeded from data/…` to `Zustand store (store/…)  ← typed by data/…`.
- In the first paragraph, change `seeded from the domain types in \`data/\`` to `typed by the domain types in \`data/\` and filled from the API`.
- Replace the `data/` table row with:

```
| `data/` | Domain **types** and fixed vocabularies (statuses, priorities, project health). No collections: stores start empty and fill from the API. `currentUser` is a pre-auth placeholder pending removal. `eslint.config.mjs` (`FIXTURE_IMPORT_PATHS`) refuses imports of removed fixtures and of surfaces with no backend. |
```

- [ ] **Step 7: Lint, build, manual check**

Run: `cd /Users/secret/Code/berry-circle/frontend && pnpm lint && pnpm build:check`
Expected: both exit 0.
Manual check: reload `/{orgId}/my-issues`. Tasks appear after hydration, with no flash of fake rows. Open a member profile from an assignee avatar; the profile renders. The Members header count matches the workspace. The new-task assignee picker lists members and agents.

- [ ] **Step 8: Commit**

```bash
cd /Users/secret/Code/berry-circle
git add -A frontend
git commit -m "refactor(frontend): start stores empty and read members, labels and projects from the API"
```

---

### Task 7: Whole-workstream verification

**Files:** none changed unless a check fails.

**Interfaces:**
- Consumes: everything above.
- Produces: a green branch.

- [ ] **Step 1: Server gates**

Run: `cd /Users/secret/Code/berry-circle && pnpm typecheck:server && pnpm test:server`
Expected: exit 0 (DB suites skipped offline).
With the test DB: `BERRY_TEST_DATABASE_URL='postgres://berry:berry@127.0.0.1:15432/berry_test?sslmode=disable' pnpm test:server`
Expected: exit 0, including `workspace-reads.search.test.ts` and `cross-tenant-leakage.test.ts`.

- [ ] **Step 2: Frontend gates**

Run: `cd /Users/secret/Code/berry-circle/frontend && pnpm lint && pnpm build:check`
Expected: exit 0.

- [ ] **Step 3: No rail page reads a fixture collection**

Run: `cd /Users/secret/Code/berry-circle/frontend && grep -rnE "from '@/data/(cycles|initiatives|documents|side-bar-nav)'" app components hooks lib store; grep -rnE "\b(mockIssues|seedProjects|mockNotifications)\b" app components hooks lib store`
Expected: no output from either.

- [ ] **Step 4: Navigation shows no hidden surface**

Run (quoted identifiers and route paths only; a bare `asks` would match every "tasks", so it would never be clean): `cd /Users/secret/Code/berry-circle/frontend && grep -rnE "'(initiatives?|cycles?|documents|analytics)'|'/(initiatives|cycles|documents|analytics)'|settings/(agent-personalization|code-and-reviews|issue-templates|slas|project-labels|project-templates|project-updates|initiatives|documents|customer-requests|releases|pulse|asks|emojis)|Move to cycle|Add to release" components/layout/shell/shell-routes.ts components/layout/shell/shell-tab-model.ts components/layout/sidebar/nav-settings.tsx components/layout/sidebar/customize-sidebar-dialog.tsx components/layout/command-palette.tsx store/sidebar-prefs-store.ts; grep -nE "label=\"(Slack|Initiatives)\"" components/common/projects/project-peek-panel.tsx components/common/projects/details/project-properties-panel.tsx`
Expected: no output from either.

- [ ] **Step 5: Manual end-to-end**

Walk the rail top to bottom and open each item; every one renders real data or its real empty state. Open settings mode and open each of the 9 items. Use ⌘K to search a task key (`XXX-1`), a project, an agent and a chat thread; each opens its page.

- [ ] **Step 6: Commit only if a fix was needed**

```bash
cd /Users/secret/Code/berry-circle
git status --short
# only if files changed:
git add -A && git commit -m "fix(frontend): address workstream I verification findings"
```

---

## Self-review

- **Spec §10 coverage:**
  - "No page in the shipped rail imports `frontend/data/*`" → Tasks 4–6 plus the ESLint guard, under the interpretation stated in Global Constraints.
  - "initiatives, cycles, documents, and the 14 placeholder settings … hidden from navigation, not faked" → Task 4 (documents, 14 placeholders, analytics placeholder) and Task 5 (initiatives, including the project-panel rows; cycles; and the dead Slack button, per §7).
  - Fixture getters in pages (`getViewById`) → Task 6.
  - "chat (linked from the rail)" → Task 4.
  - "Global search is extended to projects, skills, agents and chat" → Tasks 1–3.
  - "Realtime … no WebSocket" → nothing added.
  - Pages for other areas → explicitly other workstreams (seams table).
- **§11:** every new query is scoped through the confirmed workspace; leakage and chat privacy are tested (Tasks 1–2); `node --test` coverage is added; the frontend gates are lint + `next build`.
- **Names:** `SEARCH_TYPES`, `SearchType` and `parseSearchTypes` (server) mirror `SEARCH_TYPES`, `SearchType`, `PALETTE_SEARCH_TYPES`, `searchResultHref` and `searchWorkspace` (frontend). The node field `agentId` is used by Task 1 (null for issue/board/project, the agent id for agent), Task 2 (chat) and Task 3 (href). `FIXTURE_IMPORT_PATHS` is introduced in Task 4 and appended to in Tasks 5–6.

## Open Questions

1. **Types in `data/`.** Is keeping domain types and fixed vocabularies (`status`, `priorities`, `health`) in `frontend/data/*` acceptable under "no page imports `frontend/data/*`"? The alternative is moving every type into `lib/` (about 150 import sites), which this plan does not do.
2. **`currentUser` placeholder** (`data/users.ts`) is still used by `lib/issues.ts`, three hooks, `project-updates-store` and the palette's branch-name copy. Should it be replaced with the session user in this workstream, or tracked separately?
3. **Member "created" tab.** `issueCreatorIndex` fabricates a creator from a hash because the issue has no author field. It survives Task 6 unchanged. Remove the tab, or wait for B's timeline to supply a real creator?
4. **Rail label "runtimes".** The rail labels the runs page (`/runs`) "runtimes", and workstream A adds a real Runtimes page. Which should own that label?
5. **Skill route. Resolved against D's plan:** D creates `frontend/app/[orgId]/skills/[skillId]/page.tsx` and the `skills` table (migration 085) with no soft delete. D's Task 12 adds the W1/W2 skill leakage assertion to `workspace-reads.search.test.ts`. Until D merges, the `skill` test here is a shape check only and cannot fail. That is expected and not a coverage claim.
6. **Where a chat result opens.** The chat search matches every open conversation the caller is in, including `group` and `brief` kinds. `/chat?agent=` opens the caller's direct thread with that agent through `openAgentThread`, which is not necessarily the matched conversation, and a thread with no agent opens bare `/chat`. Should the chat branch be restricted to `conversation.kind = 'direct'` so the result is always the thread that opens? Or should the chat page take `?conversation=`?
7. **Chat message text.** Spec §10 says search covers "chat". This plan matches thread topic and agent name, not message bodies. Confirm that is enough, or add a message-body branch in a follow-up.
8. **Empty detail stubs.** `getIssueDetail` (`data/issue-details.ts`) and `getProjectDetail` (`data/project-details.ts`) are not collections. They return empty skeletons, so the project overview, activity and milestones render empty whatever the server holds. This plan leaves them alone. Should they be wired to real endpoints in this workstream, or by B (timeline) and the project owners?
