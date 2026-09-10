# Parity workstream D — agent product layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the agent product layer on top of workstream A's runtime. That means a skills catalogue, MCP servers, the rest of agent CRUD, an AI agent builder, a seeded guide agent, squads, runs triggered by mentions and replies, chat that runs as agent tasks, and per-agent access scopes. Each ships as a backend endpoint and a real frontend page.

**Architecture:** Every capability is a Postgres-backed repository plus a Hono mount, and each mount is scoped to the caller's confirmed workspace. D never calls a model or the runtime directly. It reaches A through two local structural types, `EnqueueTask` and `CompleteFn` in `server-ts/src/agents/seams.ts`, whose shapes match A's `enqueueTask` and `runCompletion`. Tests inject fakes for both, so Tasks 1–12 can be built and tested before A merges, and Task 13 then wires in A's real functions. What an agent carries into a task (enabled skills, MCP servers, opened env, squad briefing) is assembled server-side by `loadAgentExtensions`. It is consumed in the container by two shared modules under `src/agents/runtime/`, which the image copies (spec §2.1). Run-terminal side effects (chat replies, squad re-triggers) hang off a small hook registry, `runs/terminal-hooks.ts`, which the ledger calls after commit.

**Tech Stack:** Node 22, Hono, postgres.js and Zod v4 on the server (`node --test --experimental-strip-types`), with `@strands-agents/sdk` `McpClient` in the runtime modules. Next.js 15 App Router, Zustand and Zod v3 on the frontend (`pnpm lint`, `pnpm build:check`).

**Spec:** `docs/superpowers/specs/2026-09-10-multica-parity-design.md` §5 (plus §2.2–2.3 envelope/tools, §11 cross-cutting). Read both before starting.

## Global Constraints

- Scope is spec §5 only. Out of scope: runtimes and profiles (A), usage (C), autopilots (E), work tracking and sub-issues (B), plugins (G), locales (H), and rail structure, fixture removal and global search (I).
- Migrations use D's block **085–099**, forward-only, `NNN_description.up.sql`, `CREATE … IF NOT EXISTS`, and never edit an applied file. This plan uses 085–092.
- Every new table carries `workspace_id`. Every mount goes through the workspace guard (`resolveScoped`, or `AgentRepository.authorizeWorkspace` inside the agents mount), and is covered by `src/mounts/agent-layer.cross-tenant.test.ts`.
- Secrets (MCP headers, agent env) are stored only through `integrations/sealing.ts` (`Sealer.seal`/`open`). They are never serialized to the browser, only header and env **names**, and never logged. The envelope is the only place decrypted values travel.
- Server code has no emitted TS syntax (no enums, namespaces or parameter properties). It uses relative imports with `.ts`, `import type` for types, 3-space indent, single quotes, `import { z } from 'zod'` (v4), no `any`, and no `!` where narrowing works.
- Error codes are stable `SCREAMING_SNAKE_CASE`. Errors are thrown as `ApiError`, and validation goes through `assertValid`/`fieldError`.
- Server tests use `node --test`. DB tests self-skip without `BERRY_TEST_DATABASE_URL`. Mount tests drive `createApp(registry)` with `app.request`.
- Frontend uses Prettier (3-space, single quotes, width 100) and Zod v3. All calls go through `lib/api.ts` `apiFetch`. The gates are `pnpm lint` and `pnpm build:check`.
- Realtime: new events go through `outbox_events` and the SSE hub. No WebSocket.
- Clean-room: never copy multica source, schema text, copy or UI. Web only. No new integrations. Skill import from GitHub uses public GitHub REST contents URLs only; there is no new provider.
- Shared cross-plan names are **consumed, never redefined**. From A: `enqueueTask` (`server-ts/src/runs/queue.ts`), `runCompletion` (`server-ts/src/runtime/completion.ts`), `registerAgentTool` (`server-ts/src/runtime/agent-tools/registry.ts`), `TaskEnvelope`/`taskEnvelopeSchema` (`server-ts/src/runtime/envelope.ts`) and `LifecycleEvent`. `seams.ts` holds only *structural* mirrors of the first two, so tests compile before A lands.
- Chat session = existing `conversations` row. The spec's `chat_sessions.active_run_id` is realized as `conversations.active_run_id` (added idempotently in 090). `enqueueTask`'s `chatSessionId` is the conversation id.
- Commits are `type(scope): imperative summary`, with scope `server-ts` or `frontend`, ending with the session's `Co-Authored-By` line. Do not push.

## Assumptions about A (verify in Task 13)

| Needed from A | Used by |
|---|---|
| `runs.chat_session_id uuid NULL`, `runs.priority int`, `runs.issue_id` nullable for chat tasks | Task 11 queries, Task 13 |
| A's claim order honours `priority DESC` | chat "prioritise" (Task 11) |
| Envelope `agent.skills[]` is A's `skillRefSchema` `{ name, files: { path, content }[] }` and `agent.mcpServers[]` is A's `mcpServerRefSchema` `{ name, url, transport: 'http' \| 'sse', headers }` (A plan, Task 2). D's `EnvelopeSkill`/`EnvelopeMcpServer` (Task 9) are defined **identically**, with `SKILL.md` carried as one of the files | Tasks 9, 13 |
| `enqueueTask` throws `ActiveRunExists` when the issue already has a queued or running run (A plan, Task 5) | Task 8 (a trigger on a busy issue is reported, and its claim is released) |
| A leaves a marked "Chat guard (workstream D)" block in `enqueueTask`, and D fills it in | Task 13, Step 5a |
| A's ledger stays the only writer of terminal state (`completeSuccess`, `fail`, `markCancelled`) | terminal hooks (Task 1) |
| `registerAgentTool<S extends z.ZodObject>(name, def: AgentToolDefinition<S>)`, where the handler gets `AgentToolContext { sql, storage, issues, task: TaskClaims }` | Task 13 (`delegate_to_member`) |

## File Structure

**Server — create**
- `server-ts/src/agents/seams.ts`: `EnqueueInput`, `EnqueueTask`, `CompletionRequest`, `CompleteFn` (structural mirrors of A).
- `server-ts/src/mounts/zod-body.ts`: `readJson(context, schema)`, the Zod v4 body boundary.
- `server-ts/src/runs/terminal-hooks.ts` (+ test): `onRunTerminal`, `notifyRunTerminal`.
- `server-ts/src/mounts/agent-layer.fixture.ts`: the shared DB world, plus a `call()` helper for D's tests. It is not a test file.
- `server-ts/migrations/085_skills.up.sql` … `092_comment_triggers.up.sql`.
- `server-ts/src/skills/{frontmatter,repository,github-import,zip}.ts` (+ tests); `server-ts/src/mounts/skills.ts` (+ test).
- `server-ts/src/mcp/repository.ts`; `server-ts/src/mounts/mcp-servers.ts` (+ test).
- `server-ts/src/agents/{profile,access}.ts` (+ tests).
- `server-ts/src/squads/{repository,briefing,retrigger}.ts`; `server-ts/src/mounts/squads.ts` (+ test).
- `server-ts/src/agents/{mentions,triggers}.ts` (+ tests).
- `server-ts/src/agents/extensions.ts` (+ test); `server-ts/src/agents/runtime/{skill-files,mcp-clients}.ts` (+ tests).
- `server-ts/src/agents/builder.ts`; `server-ts/src/mounts/agent-builder.ts` (+ test).
- `server-ts/src/conversations/chat-tasks.ts` (+ test).
- `server-ts/src/mounts/agent-layer.cross-tenant.test.ts`.

**Server — modify**
- `src/mounts/shared.ts` (export `currentWorkspace`), `src/runs/ledger.ts` (notify hooks), `src/runs/repository.ts` (`listByAgent`), `src/agents/repository.ts` (new columns, `restore`, `copy`, archived list), `src/mounts/agents.ts` (new routes), `src/mounts/issues.ts` (`agentAccess` hook), `src/mounts/comments.ts` (trigger preview and fire), `src/conversations/repository.ts` (sessions), `src/mounts/conversations.ts` (task-backed chat), `src/index.ts` (wiring), `server-ts/SCOPE.md` (served prefixes).
- Delete: `src/conversations/responder.ts`, `src/conversations/responder.test.ts` (Task 11; chat no longer calls a model in-process).

**Frontend — create**
- `frontend/lib/{skills,mcp,squads,agent-builder}.ts`.
- `frontend/app/[orgId]/skills/page.tsx`, `frontend/app/[orgId]/skills/[skillId]/page.tsx`, `frontend/components/common/skills/{skills-list,skill-detail,skill-import-dialog}.tsx`.
- `frontend/components/common/agents/{agent-skills-tab,agent-tools-tab,agent-tasks-tab,agent-profile-settings}.tsx`.
- `frontend/app/[orgId]/settings/mcp/page.tsx`, `frontend/components/common/settings/mcp-servers.tsx`.
- `frontend/app/[orgId]/agents/new/page.tsx`, `frontend/components/common/agents/{new-agent-manual,new-agent-builder}.tsx`.
- `frontend/app/[orgId]/squads/page.tsx`, `frontend/app/[orgId]/squads/[squadId]/page.tsx`, `frontend/components/common/squads/{squads-list,squad-detail}.tsx`.
- `frontend/components/common/chat/{chat-sessions,chat-tasks-panel}.tsx`.
- `frontend/components/common/issues/details/mention-picker.tsx`.

**Frontend — modify**
- `frontend/lib/{agents,chat,comments}.ts`, `components/common/agents/agent-details.tsx`, `components/layout/headers/agents/header-options.tsx`, `components/common/chat/{chat,chat-sidebar}.tsx`, `components/common/issues/details/activity-feed.tsx`, `app/onboarding/page.tsx`.
- Rail seams owned by I: `components/layout/shell/shell-routes.ts`, `store/sidebar-prefs-store.ts`, `components/layout/sidebar/customize-sidebar-dialog.tsx`, `components/layout/sidebar/nav-settings.tsx`. Append one entry each; do not restructure.

## Task order and parallelism

- Task 1 comes first.
- These can then run in parallel: 2, 4, 7, 10 and 11.
- Task 3 follows 2. Task 5 follows 2 and 4 (copy duplicates bindings). Task 6 follows 5 (same files). Task 8 follows 6 and 7. Task 9 follows 2, 4, 6 and 7.
- Task 12 follows every backend task. Task 13 runs after A has merged.
- Frontend Tasks 14–19 can start as soon as the API shapes in this plan are fixed. Each one's final check needs its backend task merged.

---
### Task 1: Foundations — seams, Zod body boundary, terminal hooks, test world

**Files:**
- Create: `server-ts/src/agents/seams.ts`, `server-ts/src/mounts/zod-body.ts`, `server-ts/src/runs/terminal-hooks.ts`, `server-ts/src/runs/terminal-hooks.test.ts`, `server-ts/src/mounts/agent-layer.fixture.ts`
- Modify: `server-ts/src/mounts/shared.ts` (append `currentWorkspace`), `server-ts/src/runs/ledger.ts` (`completeSuccess` ~line 419, `fail` ~497, `markCancelled` ~543)

**Interfaces:**
- Consumes: `Run` from `runs/ledger.ts`; `ApiError`, `assertValid`, `fieldError`; `SessionService.issueForUser(userId): Promise<{ token: string }>`; `BerryApp`.
- Produces:
  - `type TaskSource = 'assignment' | 'mention' | 'chat' | 'autopilot' | 'squad' | 'quick_action' | 'builder' | 'completion'`
  - `interface EnqueueInput { workspaceId: string; agentId: string; issueId?: string; kind: 'agent' | 'completion'; source: TaskSource; prompt?: string; chatSessionId?: string; autopilotRunId?: string; priority?: number }`
  - `type EnqueueTask = (sql: Sql, input: EnqueueInput) => Promise<{ runId: string }>`
  - `interface CompletionRequest<T> { workspaceId: string; purpose: string; system: string; prompt: string; schema: z.ZodType<T> }`, `type CompleteFn = <T>(request: CompletionRequest<T>) => Promise<T>`
  - `readJson<T>(context: Context, schema: z.ZodType<T>): Promise<T>`: 400 `INVALID_BODY` on bad JSON, 413 over 1 MiB, the validation envelope on a schema failure.
  - `currentWorkspace(workspaceId: string | null): string`: 404 Workspace when null.
  - `onRunTerminal(hook: (run: Run) => Promise<void>): () => void`, `notifyRunTerminal(run: Run, report?: (error: unknown) => void): Promise<void>`
  - `seedAgentLayerWorld(sql): Promise<AgentLayerWorld>`, `dropAgentLayerWorld(sql, world)`, `call(app, token, method, path, body?)`

- [ ] **Step 1: Write the failing hook-registry test**

`server-ts/src/runs/terminal-hooks.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Run } from './ledger.ts';
import { notifyRunTerminal, onRunTerminal } from './terminal-hooks.ts';

const run = { id: 'r1', status: 'succeeded' } as unknown as Run;

test('every registered hook sees a finished run, in registration order', async () => {
   const seen: string[] = [];
   const offA = onRunTerminal(async (r) => void seen.push(`a:${r.id}`));
   const offB = onRunTerminal(async (r) => void seen.push(`b:${r.id}`));
   await notifyRunTerminal(run);
   offA();
   offB();
   assert.deepEqual(seen, ['a:r1', 'b:r1']);
});

test('a failing hook is reported and does not stop the next one', async () => {
   const seen: string[] = [];
   const errors: unknown[] = [];
   const offA = onRunTerminal(async () => {
      throw new Error('boom');
   });
   const offB = onRunTerminal(async () => void seen.push('b'));
   await notifyRunTerminal(run, (error) => errors.push(error));
   offA();
   offB();
   assert.deepEqual(seen, ['b']);
   assert.equal(errors.length, 1);
});

test('an unsubscribed hook is not called', async () => {
   let called = false;
   const off = onRunTerminal(async () => {
      called = true;
   });
   off();
   await notifyRunTerminal(run);
   assert.equal(called, false);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/runs/terminal-hooks.test.ts`
Expected: FAIL, because the module `./terminal-hooks.ts` is not found.

- [ ] **Step 3: Implement the registry, seams, body boundary and helper**

`server-ts/src/runs/terminal-hooks.ts`:

```ts
import type { Run } from './ledger.ts';

/**
 * What happens after a run reaches a terminal state, outside the ledger.
 *
 * A chat reply and a squad leader's re-trigger both depend on a run having
 * finished, and neither belongs inside the ledger's transaction: a hook that
 * failed there would roll back the fact that the run ended. They run after the
 * commit instead, and must be idempotent — an idempotent cancel notifies again.
 */

export type TerminalHook = (run: Run) => Promise<void>;

const hooks: TerminalHook[] = [];

export function onRunTerminal(hook: TerminalHook): () => void {
   hooks.push(hook);
   return () => {
      const index = hooks.indexOf(hook);
      if (index >= 0) hooks.splice(index, 1);
   };
}

export async function notifyRunTerminal(
   run: Run,
   report: (error: unknown) => void = () => undefined
): Promise<void> {
   for (const hook of [...hooks]) {
      try {
         await hook(run);
      } catch (error) {
         report(error);
      }
   }
}
```

`server-ts/src/agents/seams.ts`:

```ts
import type { z } from 'zod';
import type { Sql } from '../db/pool.ts';

/**
 * The two things the agent layer needs from the runtime, as shapes.
 *
 * Workstream A owns `enqueueTask` (runs/queue.ts) and `runCompletion`
 * (runtime/completion.ts). These mirrors are structural, so A's real functions
 * are assignable to them and every test here can pass a fake without A merged.
 * Never widen them: a field A does not accept would be silently dropped.
 */

export type TaskSource =
   | 'assignment'
   | 'mention'
   | 'chat'
   | 'autopilot'
   | 'squad'
   | 'quick_action'
   | 'builder'
   | 'completion';

export interface EnqueueInput {
   workspaceId: string;
   agentId: string;
   issueId?: string;
   kind: 'agent' | 'completion';
   source: TaskSource;
   prompt?: string;
   chatSessionId?: string;
   autopilotRunId?: string;
   priority?: number;
}

export type EnqueueTask = (sql: Sql, input: EnqueueInput) => Promise<{ runId: string }>;

export interface CompletionRequest<T> {
   workspaceId: string;
   purpose: string;
   system: string;
   prompt: string;
   schema: z.ZodType<T>;
}

export type CompleteFn = <T>(request: CompletionRequest<T>) => Promise<T>;
```

`server-ts/src/mounts/zod-body.ts`:

```ts
import type { Context } from 'hono';
import type { z } from 'zod';
import { assertValid, fieldError } from '../http/body.ts';
import { ApiError } from '../http/errors.ts';

const MAX_BYTES = 1 << 20;

/**
 * One JSON body, parsed into a typed value at the boundary.
 *
 * Unknown fields are the schema's business: every schema here is
 * `z.strictObject`, so a typo is refused rather than silently ignored.
 */
export async function readJson<T>(context: Context, schema: z.ZodType<T>): Promise<T> {
   const raw = await context.req.text();
   if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
   }
   let parsed: unknown;
   try {
      parsed = JSON.parse(raw.trim() === '' ? '{}' : raw);
   } catch {
      throw new ApiError(400, 'INVALID_BODY', 'Request body is not valid JSON.');
   }
   const result = schema.safeParse(parsed);
   if (!result.success) {
      assertValid(
         result.error.issues.map((issue) =>
            fieldError(`/${issue.path.map(String).join('/')}`, issue.code, issue.message)
         )
      );
      throw new ApiError(400, 'INVALID_BODY', 'Request body is not valid JSON.');
   }
   return result.data;
}
```

Append to `server-ts/src/mounts/shared.ts`:

```ts
/**
 * The workspace the caller is currently in, or 404.
 *
 * Mounts that list "this workspace's" things (agents, skills, squads) scope to
 * it rather than to one named in the query, the way the agents mount always has.
 */
export function currentWorkspace(workspaceId: string | null): string {
   if (!workspaceId) throw ApiError.notFound('Workspace');
   return workspaceId;
}
```

In `server-ts/src/runs/ledger.ts` add `import { notifyRunTerminal } from './terminal-hooks.ts';`. In each of `completeSuccess`, `fail` and `markCancelled`, change `return this.sql.begin(async (transaction) => { … });` to:

```ts
      const finished = await this.sql.begin(async (transaction) => {
         // … unchanged body …
      });
      // After the commit: a hook must never be able to undo the fact that the
      // run ended.
      await notifyRunTerminal(finished as Run);
      return finished as Run;
```

`server-ts/src/mounts/agent-layer.fixture.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import type { BerryApp } from '../http/app.ts';

/**
 * The world every agent-layer DB test runs against: workspace W with an owner,
 * a plain member, a board, an issue and an agent; and a second workspace owned
 * by an outsider, with its own agent, for leakage checks. Not a test file.
 */

export interface AgentLayerWorld {
   workspaceId: string;
   boardId: string;
   issueId: string;
   agentId: string;
   ownerId: string;
   ownerToken: string;
   memberId: string;
   memberToken: string;
   outsiderId: string;
   outsiderToken: string;
   otherWorkspaceId: string;
   otherAgentId: string;
}

export async function seedAgentLayerWorld(sql: Sql): Promise<AgentLayerWorld> {
   const sessions = new SessionService({ sql, sessionTtlMs: 3_600_000 });
   const suffix = randomUUID().slice(0, 8);

   const user = async (handle: string): Promise<string> => {
      const [row] = await sql`
         INSERT INTO users (id, email, name)
         VALUES (${randomUUID()}, ${`${handle}-${suffix}@berry.test`}, ${handle})
         RETURNING id`;
      return row?.id as string;
   };
   const workspace = async (owner: string, label: string): Promise<string> => {
      const [row] = await sql`
         INSERT INTO workspaces (id, name, slug, settings, created_by)
         VALUES (${randomUUID()}, ${`${label} ${suffix}`}, ${`${label.toLowerCase()}-${suffix}`},
                 ${sql.json({ issuePrefix: 'AGL', defaultRole: 'member', allowMemberInvites: false } as never)},
                 ${owner})
         RETURNING id`;
      return row?.id as string;
   };
   const join = async (workspaceId: string, userId: string, role: string): Promise<void> => {
      await sql`
         INSERT INTO workspace_memberships (workspace_id, user_id, role)
         VALUES (${workspaceId}, ${userId}, ${role})`;
      await sql`UPDATE users SET last_workspace_id = ${workspaceId} WHERE id = ${userId}`;
   };
   const agent = async (workspaceId: string, name: string): Promise<string> => {
      const [row] = await sql`
         INSERT INTO agents (id, workspace_id, name, status)
         VALUES (${randomUUID()}, ${workspaceId}, ${name}, 'available')
         RETURNING id`;
      return row?.id as string;
   };

   const ownerId = await user('owner');
   const memberId = await user('member');
   const outsiderId = await user('outsider');
   const workspaceId = await workspace(ownerId, 'Agl');
   const otherWorkspaceId = await workspace(outsiderId, 'Other');
   await join(workspaceId, ownerId, 'owner');
   await join(workspaceId, memberId, 'member');
   await join(otherWorkspaceId, outsiderId, 'owner');

   const [board] = await sql`
      INSERT INTO boards (id, workspace_id, name, slug, created_by)
      VALUES (${randomUUID()}, ${workspaceId}, 'Agent layer', ${`agl-${suffix}`}, ${ownerId})
      RETURNING id`;
   const boardId = board?.id as string;
   const issueId = randomUUID();
   const [counter] = await sql`
      UPDATE boards SET issue_counter = issue_counter + 1 WHERE id = ${boardId}
      RETURNING issue_counter`;
   await sql`
      INSERT INTO issues (id, board_id, number, title, created_by)
      VALUES (${issueId}, ${boardId}, ${Number(counter?.issue_counter)}, 'Agent layer task', ${ownerId})`;

   return {
      workspaceId,
      boardId,
      issueId,
      agentId: await agent(workspaceId, `Coder ${suffix}`),
      ownerId,
      ownerToken: (await sessions.issueForUser(ownerId)).token,
      memberId,
      memberToken: (await sessions.issueForUser(memberId)).token,
      outsiderId,
      outsiderToken: (await sessions.issueForUser(outsiderId)).token,
      otherWorkspaceId,
      otherAgentId: await agent(otherWorkspaceId, `Foreign ${suffix}`),
   };
}

export async function dropAgentLayerWorld(sql: Sql, world: AgentLayerWorld): Promise<void> {
   const ids = [world.workspaceId, world.otherWorkspaceId];
   await sql`DELETE FROM outbox_events WHERE workspace_id IN ${sql(ids)}`;
   // Rows that hold an agent with ON DELETE RESTRICT go first, or the agent
   // delete below fails: squads (leader), quick actions (target agent), and
   // runs — including chat runs that have no board once A lands.
   await sql`DELETE FROM squads WHERE workspace_id IN ${sql(ids)}`.catch(() => undefined);
   await sql`DELETE FROM quick_action_definitions WHERE workspace_id IN ${sql(ids)}`;
   await sql`DELETE FROM runs WHERE agent_id IN (SELECT id FROM agents WHERE workspace_id IN ${sql(ids)})`;
   await sql`DELETE FROM runs WHERE board_id IN (SELECT id FROM boards WHERE workspace_id IN ${sql(ids)})`;
   await sql`DELETE FROM issues WHERE board_id IN (SELECT id FROM boards WHERE workspace_id IN ${sql(ids)})`;
   await sql`DELETE FROM conversations WHERE workspace_id IN ${sql(ids)}`;
   await sql`ALTER TABLE agents DISABLE TRIGGER berry_agents_block_protected_delete`;
   try {
      await sql`DELETE FROM agents WHERE workspace_id IN ${sql(ids)}`;
   } finally {
      await sql`ALTER TABLE agents ENABLE TRIGGER berry_agents_block_protected_delete`;
   }
   await sql`DELETE FROM boards WHERE workspace_id IN ${sql(ids)}`;
   await sql`DELETE FROM workspace_memberships WHERE workspace_id IN ${sql(ids)}`;
   await sql`DELETE FROM workspaces WHERE id IN ${sql(ids)}`;
   await sql`DELETE FROM users WHERE id IN ${sql([world.ownerId, world.memberId, world.outsiderId])}`;
}

/** One request through the real app, as a signed-in user. */
export async function call(
   app: BerryApp,
   token: string,
   method: string,
   path: string,
   body?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
   const headers: Record<string, string> = { authorization: `Bearer ${token}` };
   if (body !== undefined) headers['content-type'] = 'application/json';
   if (method === 'POST') headers['idempotency-key'] = `agent-layer-${randomUUID()}`;
   const response = await app.request(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
   });
   const text = await response.text();
   return {
      status: response.status,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
   };
}
```

- [ ] **Step 4: Run the new test and the existing ledger and dispatcher suites**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/runs/terminal-hooks.test.ts src/runs/ledger.test.ts src/runs/dispatcher.test.ts && pnpm typecheck`
Expected: PASS. The DB suites skip without `BERRY_TEST_DATABASE_URL`, and typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add server-ts/src/agents/seams.ts server-ts/src/mounts/zod-body.ts server-ts/src/mounts/shared.ts \
  server-ts/src/runs/terminal-hooks.ts server-ts/src/runs/terminal-hooks.test.ts server-ts/src/runs/ledger.ts \
  server-ts/src/mounts/agent-layer.fixture.ts
git commit -m "feat(server-ts): lay the agent-layer seams, body boundary and run-terminal hooks"
```

---
### Task 2: Skills catalogue — schema, repository, CRUD, search, agent binding

**Files:**
- Create: `server-ts/migrations/085_skills.up.sql`, `server-ts/src/skills/frontmatter.ts`, `server-ts/src/skills/frontmatter.test.ts`, `server-ts/src/skills/repository.ts`, `server-ts/src/mounts/skills.ts`, `server-ts/src/mounts/skills.test.ts`

**Interfaces:**
- Consumes: `readJson`, `currentWorkspace` (Task 1); `resolveScoped(sql, userId, workspaceId, permission)`, `pathId` from `mounts/shared.ts`; `requireSession`; `idempotent`.
- Produces:
  - Tables `skills(id, workspace_id, name, description, content, labels, source_kind, source_url, source_ref, imported_at, …)`, `skill_files(skill_id, workspace_id, path, content)` and `agent_skills(agent_id, skill_id, workspace_id, enabled)`. I's search reads `skills.workspace_id/name/description`.
  - `parseSkillMarkdown(text): { name: string | null; description: string | null; body: string }`
  - `class SkillRepository(sql)` with `list(workspaceId, { query?, label?, agentId? })`, `get(workspaceId, id)`, `create(workspaceId, input: SkillInput, userId)`, `update(workspaceId, id, patch: Partial<SkillInput>)`, `remove(workspaceId, id)`, `replaceFromImport(workspaceId, id | null, imported: ImportedSkill, userId): Promise<Skill>`, `setBinding(workspaceId, agentId, skillId, enabled)`, `removeBinding(workspaceId, agentId, skillId)`, `copyBindings(tx, fromAgentId, toAgentId)`, `enabledForAgent(workspaceId, agentId): Promise<SkillWithFiles[]>`
  - `interface SkillInput { name: string; description: string; content: string; labels: string[]; files: { path: string; content: string }[] }`
  - `interface ImportedSkill extends SkillInput { sourceKind: 'github' | 'zip'; sourceUrl: string | null; sourceRef: string | null }`
  - Wire `Skill`: `{ id, name, description, content, labels, source: { kind, url, ref, importedAt }, files: { path, size }[], agentEnabled: boolean | null, createdAt, updatedAt }`. `GET /:id` adds `files[].content`.
  - Routes on `/api/v1/skills`: `GET /` (`q`, `label`, `agentId`), `POST /` (product.write, idempotent), `GET /:skillId`, `PATCH /:skillId`, `DELETE /:skillId` (204), `PUT /:skillId/agents/:agentId` `{ enabled: boolean }`, `DELETE /:skillId/agents/:agentId` (204).
  - `skillMounts(options: { sessions; sql; skills: SkillRepository; idempotency?: IdempotencyStore; importer?: SkillImporter }): Mount[]`. `SkillImporter` is defined in Task 3; until then the option is typed `unknown` and unused.

- [ ] **Step 1: Write the migration**

`server-ts/migrations/085_skills.up.sql`:

```sql
-- Berry migration 085: the skills catalogue.
--
-- A skill is a named piece of instructions plus supporting files that an
-- agent carries into a task. The container writes enabled skills into the
-- task workspace as a directory per skill; the catalogue is Berry's record.

CREATE TABLE IF NOT EXISTS skills (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    content text NOT NULL DEFAULT '',
    labels text[] NOT NULL DEFAULT ARRAY[]::text[],
    source_kind text NOT NULL DEFAULT 'manual',
    source_url text,
    source_ref text,
    imported_at timestamptz,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT skills_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT skills_name_ck CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    CONSTRAINT skills_description_ck CHECK (char_length(description) <= 1024),
    CONSTRAINT skills_content_ck CHECK (octet_length(content) <= 262144),
    CONSTRAINT skills_labels_ck CHECK (coalesce(array_length(labels, 1), 0) <= 20),
    CONSTRAINT skills_source_kind_ck CHECK (source_kind IN ('manual', 'github', 'zip'))
);

CREATE UNIQUE INDEX IF NOT EXISTS skills_workspace_name_key ON skills (workspace_id, name);

CREATE TABLE IF NOT EXISTS skill_files (
    skill_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    path text NOT NULL,
    content text NOT NULL,
    PRIMARY KEY (skill_id, path),
    CONSTRAINT skill_files_skill_fk FOREIGN KEY (workspace_id, skill_id)
        REFERENCES skills (workspace_id, id) ON DELETE CASCADE,
    -- Relative, no dot-dot segment: the container writes these under the
    -- skill's directory and a path that climbs out would write elsewhere.
    CONSTRAINT skill_files_path_ck CHECK (
        char_length(path) <= 255
        AND path ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'
        AND path !~ '(^|/)\.\.(/|$)'
    ),
    CONSTRAINT skill_files_content_ck CHECK (octet_length(content) <= 262144)
);

CREATE TABLE IF NOT EXISTS agent_skills (
    agent_id uuid NOT NULL,
    skill_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, skill_id),
    CONSTRAINT agent_skills_agent_fk FOREIGN KEY (workspace_id, agent_id)
        REFERENCES agents (workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT agent_skills_skill_fk FOREIGN KEY (workspace_id, skill_id)
        REFERENCES skills (workspace_id, id) ON DELETE CASCADE
);
```

- [ ] **Step 2: Write the failing frontmatter test**

`server-ts/src/skills/frontmatter.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSkillMarkdown } from './frontmatter.ts';

test('frontmatter name and description are read, and the body is what follows', () => {
   const parsed = parseSkillMarkdown(
      '---\nname: pdf-tools\ndescription: "Work with PDFs"\n---\n# PDF\nUse pdftotext.\n'
   );
   assert.equal(parsed.name, 'pdf-tools');
   assert.equal(parsed.description, 'Work with PDFs');
   assert.equal(parsed.body, '# PDF\nUse pdftotext.\n');
});

test('a file with no frontmatter is all body', () => {
   const parsed = parseSkillMarkdown('# Just text\n');
   assert.equal(parsed.name, null);
   assert.equal(parsed.description, null);
   assert.equal(parsed.body, '# Just text\n');
});

test('an unterminated frontmatter block is treated as body, not half-parsed', () => {
   const parsed = parseSkillMarkdown('---\nname: x\nno end');
   assert.equal(parsed.name, null);
   assert.equal(parsed.body, '---\nname: x\nno end');
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/skills/frontmatter.test.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 4: Implement the parser**

`server-ts/src/skills/frontmatter.ts`:

```ts
/**
 * A skill's `SKILL.md`: an optional `---` block of `key: value` lines, then
 * the instructions. Only `name` and `description` are read; anything else in
 * the block is kept in the body untouched rather than interpreted.
 */
export function parseSkillMarkdown(text: string): {
   name: string | null;
   description: string | null;
   body: string;
} {
   const normalized = text.replace(/\r\n/g, '\n');
   if (!normalized.startsWith('---\n')) return { name: null, description: null, body: normalized };
   const end = normalized.indexOf('\n---\n', 4);
   if (end < 0) return { name: null, description: null, body: normalized };

   const fields = new Map<string, string>();
   for (const line of normalized.slice(4, end).split('\n')) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim().replace(/^["'](.*)["']$/, '$1');
      fields.set(key, value);
   }
   return {
      name: fields.get('name') || null,
      description: fields.get('description') || null,
      body: normalized.slice(end + 5),
   };
}
```

- [ ] **Step 5: Implement the repository**

`server-ts/src/skills/repository.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { toRFC3339, type Queryable, type Sql } from '../db/pool.ts';
import { Conflict, NotFound } from '../identity/errors.ts';

export interface SkillFile {
   path: string;
   content: string;
}

export interface SkillInput {
   name: string;
   description: string;
   content: string;
   labels: string[];
   files: SkillFile[];
}

export interface ImportedSkill extends SkillInput {
   sourceKind: 'github' | 'zip';
   sourceUrl: string | null;
   sourceRef: string | null;
}

export interface Skill {
   id: string;
   name: string;
   description: string;
   content: string;
   labels: string[];
   source: { kind: string; url: string | null; ref: string | null; importedAt: string | null };
   files: { path: string; size: number }[];
   agentEnabled: boolean | null;
   createdAt: string;
   updatedAt: string;
}

export interface SkillWithFiles extends Skill {
   fileContents: SkillFile[];
}

const COLUMNS = `s.id, s.name, s.description, s.content, s.labels, s.source_kind, s.source_url,
   s.source_ref, s.imported_at, s.created_at, s.updated_at,
   COALESCE((SELECT json_agg(json_build_object('path', f.path, 'size', octet_length(f.content))
               ORDER BY f.path)
               FROM skill_files f WHERE f.skill_id = s.id), '[]'::json) AS files`;

export class SkillRepository {
   readonly #sql: Sql;
   readonly #newId: () => string;

   constructor(sql: Sql, newId: () => string = randomUUID) {
      this.#sql = sql;
      this.#newId = newId;
   }

   async list(
      workspaceId: string,
      filter: { query?: string; label?: string; agentId?: string } = {}
   ): Promise<Skill[]> {
      const like = filter.query ? `%${filter.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const rows = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)},
                ${filter.agentId
                   ? this.#sql`(SELECT b.enabled FROM agent_skills b
                                 WHERE b.skill_id = s.id AND b.agent_id = ${filter.agentId})`
                   : this.#sql`NULL::boolean`} AS agent_enabled
           FROM skills s
          WHERE s.workspace_id = ${workspaceId}
            AND (${like}::text IS NULL OR s.name ILIKE ${like} OR s.description ILIKE ${like})
            AND (${filter.label ?? null}::text IS NULL OR ${filter.label ?? null} = ANY (s.labels))
          ORDER BY s.name ASC
          LIMIT 500`;
      return rows.map(toSkill);
   }

   async get(workspaceId: string, id: string): Promise<SkillWithFiles> {
      const [row] = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)}, NULL::boolean AS agent_enabled
           FROM skills s WHERE s.id = ${id} AND s.workspace_id = ${workspaceId}`;
      if (!row) throw new NotFound();
      const files = await this.#sql`
         SELECT path, content FROM skill_files WHERE skill_id = ${id} ORDER BY path`;
      return {
         ...toSkill(row),
         fileContents: files.map((f) => ({ path: f.path as string, content: f.content as string })),
      };
   }

   async create(workspaceId: string, input: SkillInput, userId: string): Promise<SkillWithFiles> {
      const id = this.#newId();
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         await tx`
            INSERT INTO skills (id, workspace_id, name, description, content, labels, created_by)
            VALUES (${id}, ${workspaceId}, ${input.name}, ${input.description}, ${input.content},
                    ${input.labels}, ${userId})`.catch(classify);
         await writeFiles(tx, workspaceId, id, input.files);
      });
      return this.get(workspaceId, id);
   }

   async update(workspaceId: string, id: string, patch: Partial<SkillInput>): Promise<SkillWithFiles> {
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const updated = await tx`
            UPDATE skills SET
               name = COALESCE(${patch.name ?? null}, name),
               description = COALESCE(${patch.description ?? null}, description),
               content = COALESCE(${patch.content ?? null}, content),
               labels = COALESCE(${patch.labels ?? null}::text[], labels),
               updated_at = now()
             WHERE id = ${id} AND workspace_id = ${workspaceId}`.catch(classify);
         if (updated.count !== 1) throw new NotFound();
         if (patch.files) {
            await tx`DELETE FROM skill_files WHERE skill_id = ${id}`;
            await writeFiles(tx, workspaceId, id, patch.files);
         }
      });
      return this.get(workspaceId, id);
   }

   async remove(workspaceId: string, id: string): Promise<void> {
      const deleted = await this.#sql`
         DELETE FROM skills WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      if (deleted.count !== 1) throw new NotFound();
   }

   /** An import creates the skill, or (refresh) replaces an existing one wholesale. */
   async replaceFromImport(
      workspaceId: string,
      id: string | null,
      imported: ImportedSkill,
      userId: string
   ): Promise<SkillWithFiles> {
      const target = id ?? this.#newId();
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         if (id === null) {
            await tx`
               INSERT INTO skills (id, workspace_id, name, description, content, labels,
                                   source_kind, source_url, source_ref, imported_at, created_by)
               VALUES (${target}, ${workspaceId}, ${imported.name}, ${imported.description},
                       ${imported.content}, ${imported.labels}, ${imported.sourceKind},
                       ${imported.sourceUrl}, ${imported.sourceRef}, now(), ${userId})`.catch(classify);
         } else {
            const updated = await tx`
               UPDATE skills SET description = ${imported.description}, content = ${imported.content},
                      source_ref = ${imported.sourceRef}, imported_at = now(), updated_at = now()
                WHERE id = ${id} AND workspace_id = ${workspaceId}`;
            if (updated.count !== 1) throw new NotFound();
            await tx`DELETE FROM skill_files WHERE skill_id = ${id}`;
         }
         await writeFiles(tx, workspaceId, target, imported.files);
      });
      return this.get(workspaceId, target);
   }

   async setBinding(workspaceId: string, agentId: string, skillId: string, enabled: boolean): Promise<void> {
      await this.#sql`
         INSERT INTO agent_skills (agent_id, skill_id, workspace_id, enabled)
         VALUES (${agentId}, ${skillId}, ${workspaceId}, ${enabled})
         ON CONFLICT (agent_id, skill_id) DO UPDATE SET enabled = EXCLUDED.enabled`.catch(classify);
   }

   async removeBinding(workspaceId: string, agentId: string, skillId: string): Promise<void> {
      // NotFound when nothing matched, so another workspace's binding answers
      // 404 like every other cross-tenant write, not a silent 204.
      const deleted = await this.#sql`
         DELETE FROM agent_skills
          WHERE agent_id = ${agentId} AND skill_id = ${skillId} AND workspace_id = ${workspaceId}`;
      if (deleted.count !== 1) throw new NotFound();
   }

   /** Used by agent copy (Task 5), inside the copy's transaction. */
   static async copyBindings(tx: Queryable, fromAgentId: string, toAgentId: string): Promise<void> {
      await tx`
         INSERT INTO agent_skills (agent_id, skill_id, workspace_id, enabled)
         SELECT ${toAgentId}, skill_id, workspace_id, enabled FROM agent_skills
          WHERE agent_id = ${fromAgentId}`;
   }

   async enabledForAgent(workspaceId: string, agentId: string): Promise<SkillWithFiles[]> {
      const rows = await this.#sql`
         SELECT s.id FROM skills s
           JOIN agent_skills b ON b.skill_id = s.id AND b.enabled
          WHERE b.agent_id = ${agentId} AND s.workspace_id = ${workspaceId}
          ORDER BY s.name`;
      return Promise.all(rows.map((row) => this.get(workspaceId, row.id as string)));
   }
}

async function writeFiles(tx: Sql, workspaceId: string, skillId: string, files: SkillFile[]): Promise<void> {
   for (const file of files) {
      await tx`
         INSERT INTO skill_files (skill_id, workspace_id, path, content)
         VALUES (${skillId}, ${workspaceId}, ${file.path}, ${file.content})`.catch(classify);
   }
}

function toSkill(row: Record<string, unknown>): Skill {
   return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string,
      content: row.content as string,
      labels: (row.labels as string[] | null) ?? [],
      source: {
         kind: row.source_kind as string,
         url: (row.source_url as string | null) ?? null,
         ref: (row.source_ref as string | null) ?? null,
         importedAt: toRFC3339(row.imported_at as string | null),
      },
      files: (row.files as { path: string; size: number }[] | null) ?? [],
      agentEnabled: (row.agent_enabled as boolean | null) ?? null,
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}

/** Unique name → Conflict; a foreign key into another workspace → NotFound. */
function classify(error: unknown): never {
   const code = (error as { code?: string }).code;
   if (code === '23505') throw new Conflict();
   if (code === '23503' || code === '23514') throw new NotFound();
   throw error;
}
```

(If `Conflict` has no zero-argument constructor, check `identity/errors.ts` and pass the message it expects. `agents/repository.ts` already throws it.)

- [ ] **Step 6: Write the failing mount test**

`server-ts/src/mounts/skills.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { SessionService } from '../auth/sessions.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { SkillRepository } from '../skills/repository.ts';
import { call, dropAgentLayerWorld, seedAgentLayerWorld, type AgentLayerWorld } from './agent-layer.fixture.ts';
import { skillMounts } from './skills.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('skills mount', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let world: AgentLayerWorld;

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
      const registry = new Registry();
      registry.registerAll(
         skillMounts({
            sessions: new SessionService({ sql, sessionTtlMs: 3_600_000 }),
            sql,
            skills: new SkillRepository(sql),
         })
      );
      app = createApp(registry);
   });

   after(async () => {
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });

   test('a skill is created with its files and found by search', async () => {
      const created = await call(app, world.ownerToken, 'POST', '/api/v1/skills', {
         name: 'pdf-tools',
         description: 'Work with PDF files',
         content: 'Use pdftotext.',
         labels: ['docs'],
         files: [{ path: 'scripts/extract.sh', content: 'pdftotext "$1"' }],
      });
      assert.equal(created.status, 201);
      assert.deepEqual(created.body.files, [{ path: 'scripts/extract.sh', size: 14 }]);

      const found = await call(app, world.ownerToken, 'GET', '/api/v1/skills?q=PDF');
      const names = (found.body.nodes as { name: string }[]).map((n) => n.name);
      assert.deepEqual(names, ['pdf-tools']);
   });

   test('a duplicate name is a conflict, and a bad name is a validation error', async () => {
      const dup = await call(app, world.ownerToken, 'POST', '/api/v1/skills', {
         name: 'pdf-tools', description: '', content: '', labels: [], files: [],
      });
      assert.equal(dup.status, 409);
      assert.equal((dup.body.error as { code: string }).code, 'SKILL_NAME_TAKEN');
      const bad = await call(app, world.ownerToken, 'POST', '/api/v1/skills', {
         name: 'PDF Tools', description: '', content: '', labels: [], files: [],
      });
      // assertValid throws ValidationFailed: 422 VALIDATION_FAILED (http/body.ts).
      assert.equal(bad.status, 422);
      assert.equal((bad.body.error as { code: string }).code, 'VALIDATION_FAILED');
   });

   test('a file path that climbs out of the skill is refused', async () => {
      const res = await call(app, world.ownerToken, 'POST', '/api/v1/skills', {
         name: 'escape', description: '', content: '', labels: [],
         files: [{ path: '../etc/passwd', content: 'x' }],
      });
      assert.equal(res.status, 422);
   });

   test('a member may read skills, and an outsider’s write to one is 404', async () => {
      assert.equal((await call(app, world.memberToken, 'GET', '/api/v1/skills')).status, 200);
      const list = await call(app, world.ownerToken, 'GET', '/api/v1/skills');
      const skillId = (list.body.nodes as { id: string }[])[0]?.id as string;
      const res = await call(app, world.outsiderToken, 'PATCH', `/api/v1/skills/${skillId}`, { description: 'x' });
      assert.equal(res.status, 404);
   });

   test('binding a skill to an agent shows up when listing for that agent', async () => {
      const list = await call(app, world.ownerToken, 'GET', '/api/v1/skills');
      const skillId = (list.body.nodes as { id: string }[])[0]?.id as string;
      const bound = await call(app, world.ownerToken, 'PUT', `/api/v1/skills/${skillId}/agents/${world.agentId}`, {
         enabled: true,
      });
      assert.equal(bound.status, 204);
      const forAgent = await call(app, world.ownerToken, 'GET', `/api/v1/skills?agentId=${world.agentId}`);
      assert.equal((forAgent.body.nodes as { agentEnabled: boolean }[])[0]?.agentEnabled, true);
   });

   test('binding to an agent of another workspace is not found', async () => {
      const list = await call(app, world.ownerToken, 'GET', '/api/v1/skills');
      const skillId = (list.body.nodes as { id: string }[])[0]?.id as string;
      const res = await call(app, world.ownerToken, 'PUT', `/api/v1/skills/${skillId}/agents/${world.otherAgentId}`, {
         enabled: true,
      });
      assert.equal(res.status, 404);
   });

   test('an outsider sees none of this workspace’s skills', async () => {
      const res = await call(app, world.outsiderToken, 'GET', '/api/v1/skills');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.nodes, []);
   });
});
```

- [ ] **Step 7: Run it and confirm it fails**

Run: `cd /Users/secret/Code/berry-circle/server-ts && BERRY_TEST_DATABASE_URL=… node --test --experimental-strip-types src/mounts/skills.test.ts` (see `server-ts/ROUTING.md` "Running the database-backed tests"; run `pnpm migrate` against the test DB first).
Expected: FAIL, because `./skills.ts` is not found.

- [ ] **Step 8: Implement the mount**

`server-ts/src/mounts/skills.ts`:

```ts
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import { idempotent } from '../http/idempotent.ts';
import type { IdempotencyStore } from '../http/idempotency.ts';
import type { Mount } from '../http/registry.ts';
import { Conflict, NotFound } from '../identity/errors.ts';
import type { SkillRepository, SkillWithFiles } from '../skills/repository.ts';
import { currentWorkspace, pathId, resolveScoped } from './shared.ts';
import { readJson } from './zod-body.ts';

const fileSchema = z.strictObject({
   path: z
      .string()
      .max(255)
      .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/)
      .refine((p) => !p.split('/').includes('..'), 'path may not contain ..'),
   content: z.string().max(262_144),
});
export const skillInputSchema = z.strictObject({
   name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
   description: z.string().max(1024).default(''),
   content: z.string().max(262_144).default(''),
   labels: z.array(z.string().min(1).max(40)).max(20).default([]),
   files: z.array(fileSchema).max(100).default([]),
});
const patchSchema = skillInputSchema.partial();
const bindingSchema = z.strictObject({ enabled: z.boolean() });

export interface SkillMountOptions {
   sessions: SessionService;
   sql: Sql;
   skills: SkillRepository;
   idempotency?: IdempotencyStore;
   /** Task 3. */
   importer?: unknown;
}

export function skillMounts(options: SkillMountOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));
   const { skills, sql } = options;
   const creating: MiddlewareHandler[] = options.idempotency ? [idempotent(options.idempotency)] : [];

   const scope = async (user: { id: string; currentWorkspaceId: string | null }, write: boolean) =>
      resolveScoped(sql, user.id, currentWorkspace(user.currentWorkspaceId), write ? 'product.write' : 'product.read');

   route.get('/', async (context) => {
      const scoped = await scope(context.get('user'), false);
      const url = new URL(context.req.url);
      const agentId = url.searchParams.get('agentId');
      const nodes = await skills.list(scoped.ctx.workspaceId, {
         ...(url.searchParams.get('q') ? { query: url.searchParams.get('q') as string } : {}),
         ...(url.searchParams.get('label') ? { label: url.searchParams.get('label') as string } : {}),
         ...(agentId ? { agentId: pathId(agentId, 'Agent') } : {}),
      });
      return json({ nodes });
   });

   route.post('/', ...creating, async (context) => {
      const scoped = await scope(context.get('user'), true);
      const input = await readJson(context, skillInputSchema);
      const created = await skills
         .create(scoped.ctx.workspaceId, input, context.get('user').id)
         .catch(rethrow);
      // List and create answer `files: { path, size }[]`; only GET /:skillId adds content.
      return json({ ...serialize(created), files: created.files }, 201);
   });

   route.get('/:skillId', async (context) => {
      const scoped = await scope(context.get('user'), false);
      const found = await skills
         .get(scoped.ctx.workspaceId, pathId(context.req.param('skillId'), 'Skill'))
         .catch(rethrow);
      return json(serialize(found));
   });

   route.patch('/:skillId', async (context) => {
      const scoped = await scope(context.get('user'), true);
      const patch = await readJson(context, patchSchema);
      const updated = await skills
         .update(scoped.ctx.workspaceId, pathId(context.req.param('skillId'), 'Skill'), patch)
         .catch(rethrow);
      return json(serialize(updated));
   });

   route.delete('/:skillId', async (context) => {
      const scoped = await scope(context.get('user'), true);
      await skills.remove(scoped.ctx.workspaceId, pathId(context.req.param('skillId'), 'Skill')).catch(rethrow);
      return new Response(null, { status: 204 });
   });

   route.put('/:skillId/agents/:agentId', async (context) => {
      const scoped = await scope(context.get('user'), true);
      const { enabled } = await readJson(context, bindingSchema);
      await skills
         .setBinding(
            scoped.ctx.workspaceId,
            pathId(context.req.param('agentId'), 'Agent'),
            pathId(context.req.param('skillId'), 'Skill'),
            enabled
         )
         .catch(rethrow);
      return new Response(null, { status: 204 });
   });

   route.delete('/:skillId/agents/:agentId', async (context) => {
      const scoped = await scope(context.get('user'), true);
      await skills
         .removeBinding(
            scoped.ctx.workspaceId,
            pathId(context.req.param('agentId'), 'Agent'),
            pathId(context.req.param('skillId'), 'Skill')
         )
         .catch(rethrow);
      return new Response(null, { status: 204 });
   });

   return [{ prefix: '/api/v1/skills', handler: route }];
}

export function serialize(skill: SkillWithFiles): Record<string, unknown> {
   const { fileContents, ...rest } = skill;
   return { ...rest, files: fileContents.map((f) => ({ path: f.path, size: Buffer.byteLength(f.content), content: f.content })) };
}

function rethrow(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('Skill');
   if (error instanceof Conflict) throw new ApiError(409, 'SKILL_NAME_TAKEN', 'A skill with that name already exists.');
   throw error;
}
```

- [ ] **Step 8b: Cover the skill branch of global search (contract with workstream I)**

I's search reads `skills` only when the table exists, so its skill branch has no tenant coverage until this task. I's plan requires D to add it. In `server-ts/src/mounts/workspace-reads.search.test.ts` (created by I; if I has not merged yet, add this in Task 12 instead), seed one skill in W1 and one in W2 through `SkillRepository.create`, then assert:

```ts
   test('a skill search in W1 never returns W2’s skill', async () => {
      const res = await call(app, world.w1Token, 'GET', `/api/v1/search?q=${encodeURIComponent('xskill')}&types=skill`);
      assert.equal(res.status, 200);
      const ids = (res.body.nodes as { id: string }[]).map((n) => n.id);
      assert.ok(ids.includes(w1SkillId));
      assert.ok(!ids.includes(w2SkillId));
   });
```

Use that file's own world, token and request helper names. The names above stand in for them. The skills table has no soft delete, so the skill branch needs no `archived_at` predicate.

- [ ] **Step 9: Run the tests and confirm they pass**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/skills/frontmatter.test.ts && BERRY_TEST_DATABASE_URL=… node --test --experimental-strip-types src/mounts/skills.test.ts src/mounts/workspace-reads.search.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server-ts/migrations/085_skills.up.sql server-ts/src/skills server-ts/src/mounts/skills.ts server-ts/src/mounts/skills.test.ts \
  server-ts/src/mounts/workspace-reads.search.test.ts
git commit -m "feat(server-ts): add a skills catalogue agents can carry into tasks"
```

---
### Task 3: Skills import — GitHub URL, zip upload, refresh

**Files:**
- Create: `server-ts/src/skills/github-import.ts`, `server-ts/src/skills/github-import.test.ts`, `server-ts/src/skills/zip.ts`, `server-ts/src/skills/zip.test.ts`
- Modify: `server-ts/src/mounts/skills.ts` (the `importer` option type and three routes), `server-ts/src/mounts/skills.test.ts`

**Interfaces:**
- Consumes: `parseSkillMarkdown`, `ImportedSkill`, `SkillRepository.replaceFromImport` (Task 2).
- Produces:
  - `parseGitHubSkillUrl(url: string): { owner: string; repo: string; ref: string | null; path: string }`. Accepts `https://github.com/o/r`, `…/tree/<ref>/<path>` and `…/blob/<ref>/<path>/SKILL.md`, and throws `SkillImportError` otherwise.
  - `importFromGitHub(url: string, fetchImpl?: typeof fetch): Promise<ImportedSkill>`
  - `readZip(bytes: Buffer): { path: string; content: Buffer }[]` (stored and deflate entries only)
  - `skillFromArchive(entries): ImportedSkill` (`sourceKind: 'zip'`)
  - `class SkillImportError extends Error { code: 'SKILL_URL_INVALID' | 'SKILL_MANIFEST_MISSING' | 'SKILL_TOO_LARGE' | 'SKILL_SOURCE_UNAVAILABLE' | 'SKILL_ARCHIVE_INVALID' }`
  - `interface SkillImporter { fromGitHub(url: string): Promise<ImportedSkill> }`
  - Routes: `POST /api/v1/skills/import` `{ url }` → 201 skill; `POST /api/v1/skills/import/zip` (body `application/zip`, ≤ 2 MiB) → 201; `POST /api/v1/skills/:skillId/refresh` → 200. A zip or manual skill gets 409 `SKILL_NOT_REFRESHABLE`. Import errors map to 422 with the error's code; `SKILL_SOURCE_UNAVAILABLE` maps to 502.
  - Limits: ≤ 100 files, ≤ 1 MiB total, text files only (NUL byte → skipped).

- [ ] **Step 1: Write the failing tests**

`server-ts/src/skills/github-import.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importFromGitHub, parseGitHubSkillUrl, SkillImportError } from './github-import.ts';

test('tree and blob URLs resolve to owner, repo, ref and directory', () => {
   assert.deepEqual(parseGitHubSkillUrl('https://github.com/acme/skills/tree/main/pdf'), {
      owner: 'acme', repo: 'skills', ref: 'main', path: 'pdf',
   });
   assert.deepEqual(parseGitHubSkillUrl('https://github.com/acme/skills/blob/v2/pdf/SKILL.md'), {
      owner: 'acme', repo: 'skills', ref: 'v2', path: 'pdf',
   });
   assert.deepEqual(parseGitHubSkillUrl('https://github.com/acme/pdf-skill'), {
      owner: 'acme', repo: 'pdf-skill', ref: null, path: '',
   });
   assert.throws(() => parseGitHubSkillUrl('https://gitlab.com/a/b'), SkillImportError);
});

function fakeGitHub(tree: Record<string, string | string[]>): typeof fetch {
   return (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const path = decodeURIComponent(url.pathname.replace(/^\/repos\/acme\/skills\/contents\/?/, ''));
      const entry = tree[path];
      if (entry === undefined) return new Response('{}', { status: 404 });
      if (Array.isArray(entry)) {
         return Response.json(
            entry.map((name) => ({
               name, path: path ? `${path}/${name}` : name,
               type: Array.isArray(tree[path ? `${path}/${name}` : name]) ? 'dir' : 'file',
            }))
         );
      }
      return Response.json({ type: 'file', encoding: 'base64', content: Buffer.from(entry).toString('base64') });
   }) as typeof fetch;
}

test('a directory with SKILL.md becomes a skill with its supporting files', async () => {
   const skill = await importFromGitHub(
      'https://github.com/acme/skills/tree/main/pdf',
      fakeGitHub({
         pdf: ['SKILL.md', 'scripts'],
         'pdf/SKILL.md': '---\nname: pdf-tools\ndescription: PDFs\n---\nUse it.\n',
         'pdf/scripts': ['run.sh'],
         'pdf/scripts/run.sh': 'echo hi',
      })
   );
   assert.equal(skill.name, 'pdf-tools');
   assert.equal(skill.description, 'PDFs');
   assert.equal(skill.content, 'Use it.\n');
   assert.deepEqual(skill.files, [{ path: 'scripts/run.sh', content: 'echo hi' }]);
   assert.equal(skill.sourceKind, 'github');
   assert.equal(skill.sourceRef, 'main');
});

test('a directory without SKILL.md is refused by name', async () => {
   await assert.rejects(
      importFromGitHub('https://github.com/acme/skills/tree/main/pdf', fakeGitHub({ pdf: ['README.md'], 'pdf/README.md': 'x' })),
      (error: unknown) => error instanceof SkillImportError && error.code === 'SKILL_MANIFEST_MISSING'
   );
});
```

`server-ts/src/skills/zip.test.ts` (it builds a real zip in memory, so the reader is checked against the format rather than against itself):

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { readZip, skillFromArchive } from './zip.ts';

function zip(files: { name: string; data: string; deflate: boolean }[]): Buffer {
   const locals: Buffer[] = [];
   const centrals: Buffer[] = [];
   let offset = 0;
   for (const file of files) {
      const raw = Buffer.from(file.data);
      const body = file.deflate ? deflateRawSync(raw) : raw;
      const name = Buffer.from(file.name);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(file.deflate ? 8 : 0, 8);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(name.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(file.deflate ? 8 : 0, 10);
      central.writeUInt32LE(body.length, 20);
      central.writeUInt32LE(raw.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(offset, 42);
      locals.push(local, name, body);
      centrals.push(central, name);
      offset += 30 + name.length + body.length;
   }
   const cd = Buffer.concat(centrals);
   const end = Buffer.alloc(22);
   end.writeUInt32LE(0x06054b50, 0);
   end.writeUInt16LE(files.length, 8);
   end.writeUInt16LE(files.length, 10);
   end.writeUInt32LE(cd.length, 12);
   end.writeUInt32LE(offset, 16);
   return Buffer.concat([...locals, cd, end]);
}

test('stored and deflated entries both read back byte for byte', () => {
   const entries = readZip(zip([
      { name: 'a.txt', data: 'plain', deflate: false },
      { name: 'b/c.txt', data: 'squeezed '.repeat(50), deflate: true },
   ]));
   assert.deepEqual(entries.map((e) => [e.path, e.content.toString()]), [
      ['a.txt', 'plain'],
      ['b/c.txt', 'squeezed '.repeat(50)],
   ]);
});

test('an archive with one top folder is unwrapped around SKILL.md', () => {
   const skill = skillFromArchive(readZip(zip([
      { name: 'pdf/SKILL.md', data: '---\nname: pdf-tools\n---\nbody', deflate: true },
      { name: 'pdf/ref.md', data: 'ref', deflate: false },
   ])));
   assert.equal(skill.name, 'pdf-tools');
   assert.deepEqual(skill.files, [{ path: 'ref.md', content: 'ref' }]);
   assert.equal(skill.sourceKind, 'zip');
});

test('bytes that are not a zip are refused', () => {
   assert.throws(() => readZip(Buffer.from('not a zip')));
});

test('an entry that inflates past the limit is refused before it is inflated', () => {
   // 2 MiB of zeros deflates to a few KiB: the declared size, not the archive size, must be checked.
   assert.throws(
      () => readZip(zip([{ name: 'SKILL.md', data: '\0'.repeat(2 << 20), deflate: true }])),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'SKILL_TOO_LARGE'
   );
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/skills/github-import.test.ts src/skills/zip.test.ts`
Expected: FAIL, because the modules are not found.

- [ ] **Step 3: Implement**

`server-ts/src/skills/github-import.ts`:

```ts
import { parseSkillMarkdown } from './frontmatter.ts';
import type { ImportedSkill, SkillFile } from './repository.ts';

export type SkillImportCode =
   | 'SKILL_URL_INVALID'
   | 'SKILL_MANIFEST_MISSING'
   | 'SKILL_TOO_LARGE'
   | 'SKILL_SOURCE_UNAVAILABLE'
   | 'SKILL_ARCHIVE_INVALID';

export class SkillImportError extends Error {
   override readonly name = 'SkillImportError';
   readonly code: SkillImportCode;
   constructor(code: SkillImportCode, message: string) {
      super(message);
      this.code = code;
   }
}

export interface SkillImporter {
   fromGitHub(url: string): Promise<ImportedSkill>;
}

export const MAX_FILES = 100;
export const MAX_BYTES = 1 << 20;

export function parseGitHubSkillUrl(raw: string): { owner: string; repo: string; ref: string | null; path: string } {
   let url: URL;
   try {
      url = new URL(raw);
   } catch {
      throw new SkillImportError('SKILL_URL_INVALID', 'That is not a URL.');
   }
   if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
      throw new SkillImportError('SKILL_URL_INVALID', 'Skills import from github.com URLs only.');
   }
   const parts = url.pathname.split('/').filter(Boolean);
   const [owner, repo, mode, ref, ...rest] = parts;
   if (!owner || !repo) throw new SkillImportError('SKILL_URL_INVALID', 'The URL names no repository.');
   if (mode === undefined) return { owner, repo: repo.replace(/\.git$/, ''), ref: null, path: '' };
   if ((mode !== 'tree' && mode !== 'blob') || !ref) {
      throw new SkillImportError('SKILL_URL_INVALID', 'Use a repository, tree or blob URL.');
   }
   const path = rest.at(-1) === 'SKILL.md' ? rest.slice(0, -1) : rest;
   return { owner, repo, ref, path: path.join('/') };
}

export async function importFromGitHub(url: string, fetchImpl: typeof fetch = fetch): Promise<ImportedSkill> {
   const target = parseGitHubSkillUrl(url);
   const files: SkillFile[] = [];
   let total = 0;

   const get = async (path: string): Promise<unknown> => {
      const endpoint = new URL(`https://api.github.com/repos/${target.owner}/${target.repo}/contents/${path}`);
      if (target.ref) endpoint.searchParams.set('ref', target.ref);
      const response = await fetchImpl(endpoint, { headers: { accept: 'application/vnd.github+json' } });
      if (response.status === 404) throw new SkillImportError('SKILL_MANIFEST_MISSING', 'Nothing at that path.');
      if (!response.ok) throw new SkillImportError('SKILL_SOURCE_UNAVAILABLE', `GitHub answered ${response.status}.`);
      return response.json();
   };

   const walk = async (dir: string): Promise<void> => {
      const listing = await get(dir);
      if (!Array.isArray(listing)) throw new SkillImportError('SKILL_URL_INVALID', 'The URL does not name a directory.');
      for (const entry of listing as { name: string; path: string; type: string }[]) {
         if (entry.type === 'dir') {
            await walk(entry.path);
            continue;
         }
         if (entry.type !== 'file') continue;
         const file = (await get(entry.path)) as { content?: string; encoding?: string };
         const bytes = Buffer.from(file.content ?? '', file.encoding === 'base64' ? 'base64' : 'utf8');
         if (bytes.includes(0)) continue; // binary: a skill is text
         total += bytes.length;
         if (files.length >= MAX_FILES || total > MAX_BYTES) {
            throw new SkillImportError('SKILL_TOO_LARGE', 'A skill is at most 100 files and 1 MiB.');
         }
         const relative = target.path ? entry.path.slice(target.path.length + 1) : entry.path;
         files.push({ path: relative, content: bytes.toString('utf8') });
      }
   };

   await walk(target.path);
   return toImported(files, 'github', url, target.ref);
}

/** Shared by the zip path: SKILL.md becomes the skill, everything else its files. */
export function toImported(
   files: SkillFile[],
   kind: 'github' | 'zip',
   sourceUrl: string | null,
   sourceRef: string | null
): ImportedSkill {
   const manifest = files.find((f) => f.path === 'SKILL.md');
   if (!manifest) throw new SkillImportError('SKILL_MANIFEST_MISSING', 'A skill needs a SKILL.md at its root.');
   const parsed = parseSkillMarkdown(manifest.content);
   const fallback = (sourceUrl ?? 'skill').split('/').filter(Boolean).at(-1) ?? 'skill';
   const name = (parsed.name ?? fallback).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'skill';
   return {
      name,
      description: (parsed.description ?? '').slice(0, 1024),
      content: parsed.body,
      labels: [],
      files: files.filter((f) => f.path !== 'SKILL.md').sort((a, b) => a.path.localeCompare(b.path)),
      sourceKind: kind,
      sourceUrl,
      sourceRef,
   };
}
```

`server-ts/src/skills/zip.ts`:

```ts
import { inflateRawSync } from 'node:zlib';
import { MAX_BYTES, MAX_FILES, SkillImportError, toImported } from './github-import.ts';
import type { ImportedSkill } from './repository.ts';

/**
 * The central directory of a zip, read without a dependency.
 *
 * Only what a skill archive needs: stored (0) and deflate (8) entries, no
 * encryption, no zip64. Anything else is refused rather than half-read.
 */
export function readZip(bytes: Buffer): { path: string; content: Buffer }[] {
   const invalid = () => new SkillImportError('SKILL_ARCHIVE_INVALID', 'That is not a zip archive Berry can read.');
   let end = -1;
   for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i -= 1) {
      if (bytes.readUInt32LE(i) === 0x06054b50) {
         end = i;
         break;
      }
   }
   if (end < 0) throw invalid();
   const count = bytes.readUInt16LE(end + 10);
   let cursor = bytes.readUInt32LE(end + 16);
   const entries: { path: string; content: Buffer }[] = [];
   let total = 0;
   for (let n = 0; n < count; n += 1) {
      if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) throw invalid();
      const method = bytes.readUInt16LE(cursor + 10);
      const compressed = bytes.readUInt32LE(cursor + 20);
      const size = bytes.readUInt32LE(cursor + 24);
      const nameLength = bytes.readUInt16LE(cursor + 28);
      const extra = bytes.readUInt16LE(cursor + 30);
      const comment = bytes.readUInt16LE(cursor + 32);
      const local = bytes.readUInt32LE(cursor + 42);
      const path = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
      cursor += 46 + nameLength + extra + comment;
      if (path.endsWith('/')) continue;
      if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw invalid();
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const body = bytes.subarray(start, start + compressed);
      // The declared size is attacker-controlled, so it is checked before any
      // inflate, and the inflate itself is capped: a 2 MiB zip bomb must not
      // expand into gigabytes of memory before the total check below runs.
      if (size > MAX_BYTES || total + size > MAX_BYTES) {
         throw new SkillImportError('SKILL_TOO_LARGE', 'A skill is at most 100 files and 1 MiB.');
      }
      let content: Buffer | null = null;
      try {
         content = method === 0 ? Buffer.from(body) : method === 8 ? inflateRawSync(body, { maxOutputLength: Math.max(size, 1) }) : null;
      } catch {
         throw invalid();
      }
      if (!content || content.length !== size) throw invalid();
      total += size;
      if (entries.length >= MAX_FILES || total > MAX_BYTES) {
         throw new SkillImportError('SKILL_TOO_LARGE', 'A skill is at most 100 files and 1 MiB.');
      }
      entries.push({ path, content });
   }
   return entries;
}

export function skillFromArchive(entries: { path: string; content: Buffer }[]): ImportedSkill {
   const text = entries.filter((e) => !e.content.includes(0) && !e.path.startsWith('__MACOSX/'));
   const tops = new Set(text.map((e) => e.path.split('/')[0]));
   const [only] = [...tops];
   const strip = tops.size === 1 && only !== undefined && !text.some((e) => e.path === only) ? `${only}/` : '';
   const files = text
      .map((e) => ({ path: e.path.slice(strip.length), content: e.content.toString('utf8') }))
      .filter((f) => /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(f.path) && !f.path.split('/').includes('..'));
   return toImported(files, 'zip', null, null);
}
```

In `server-ts/src/mounts/skills.ts`, change `importer?: unknown` to `importer?: SkillImporter`, import `SkillImportError`, `SkillImporter` and `readZip`/`skillFromArchive`, and register these routes **before** `route.get('/:skillId', …)`:

```ts
   const importSchema = z.strictObject({ url: z.string().url().max(2000) });

   route.post('/import', ...creating, async (context) => {
      const scoped = await scope(context.get('user'), true);
      if (!options.importer) throw new ApiError(503, 'SKILL_IMPORT_UNAVAILABLE', 'Skill import is not configured.');
      const { url } = await readJson(context, importSchema);
      const imported = await options.importer.fromGitHub(url).catch(rethrowImport);
      const created = await skills
         .replaceFromImport(scoped.ctx.workspaceId, null, imported, context.get('user').id)
         .catch(rethrow);
      return json({ ...serialize(created), files: created.files }, 201);
   });

   // No idempotency middleware here: `idempotent()` fingerprints the body with
   // `fingerprintJSON`, which parses it as JSON and would refuse every zip.
   route.post('/import/zip', async (context) => {
      const scoped = await scope(context.get('user'), true);
      const type = (context.req.header('content-type') ?? '').split(';')[0]?.trim();
      if (type !== 'application/zip') {
         throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/zip.');
      }
      const bytes = Buffer.from(await context.req.arrayBuffer());
      if (bytes.length > 2 << 20) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
      const imported = (() => {
         try {
            return skillFromArchive(readZip(bytes));
         } catch (error) {
            return rethrowImport(error);
         }
      })();
      const created = await skills
         .replaceFromImport(scoped.ctx.workspaceId, null, imported, context.get('user').id)
         .catch(rethrow);
      return json({ ...serialize(created), files: created.files }, 201);
   });

   route.post('/:skillId/refresh', async (context) => {
      const scoped = await scope(context.get('user'), true);
      const id = pathId(context.req.param('skillId'), 'Skill');
      const current = await skills.get(scoped.ctx.workspaceId, id).catch(rethrow);
      if (current.source.kind !== 'github' || !current.source.url || !options.importer) {
         throw new ApiError(409, 'SKILL_NOT_REFRESHABLE', 'Only a skill imported from GitHub can be refreshed.');
      }
      const imported = await options.importer.fromGitHub(current.source.url).catch(rethrowImport);
      const updated = await skills
         .replaceFromImport(scoped.ctx.workspaceId, id, imported, context.get('user').id)
         .catch(rethrow);
      return json(serialize(updated));
   });
```

and, at the bottom of the file:

```ts
function rethrowImport(error: unknown): never {
   if (error instanceof SkillImportError) {
      const status = error.code === 'SKILL_SOURCE_UNAVAILABLE' ? 502 : 422;
      throw new ApiError(status, error.code, error.message);
   }
   throw error;
}
```

Append to `skills.test.ts` (and pass `importer` in the `before`):

```ts
   // in before(): importer: { fromGitHub: async (u) => ({ name: 'imported-skill', description: 'd',
   //    content: 'c', labels: [], files: [], sourceKind: 'github', sourceUrl: u, sourceRef: 'main' }) },

   test('a GitHub import creates a refreshable skill', async () => {
      const created = await call(app, world.ownerToken, 'POST', '/api/v1/skills/import', {
         url: 'https://github.com/acme/skills/tree/main/imported',
      });
      assert.equal(created.status, 201);
      assert.equal((created.body.source as { kind: string }).kind, 'github');
      const refreshed = await call(app, world.ownerToken, 'POST', `/api/v1/skills/${created.body.id as string}/refresh`);
      assert.equal(refreshed.status, 200);
   });

   test('a manual skill cannot be refreshed', async () => {
      const list = await call(app, world.ownerToken, 'GET', '/api/v1/skills?q=pdf-tools');
      const id = (list.body.nodes as { id: string }[])[0]?.id as string;
      const res = await call(app, world.ownerToken, 'POST', `/api/v1/skills/${id}/refresh`);
      assert.equal(res.status, 409);
   });
```

Write the `importer` line in `before` as real code (the comment above only shows its value).

- [ ] **Step 4: Run and confirm everything passes**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/skills/*.test.ts && BERRY_TEST_DATABASE_URL=… node --test --experimental-strip-types src/mounts/skills.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server-ts/src/skills server-ts/src/mounts/skills.ts server-ts/src/mounts/skills.test.ts
git commit -m "feat(server-ts): import skills from a GitHub folder or a zip, and refresh them"
```

---
### Task 4: MCP servers — per workspace and per agent, headers sealed

**Files:**
- Create: `server-ts/migrations/086_mcp_servers.up.sql`, `server-ts/src/mcp/repository.ts`, `server-ts/src/mcp/repository.test.ts`, `server-ts/src/mounts/mcp-servers.ts`, `server-ts/src/mounts/mcp-servers.test.ts`

**Interfaces:**
- Consumes: `Sealer` (`integrations/sealing.ts`), `SealingUnavailable`; `readJson`, `currentWorkspace`, `resolveScoped`, `pathId`.
- Produces:
  - Table `mcp_servers(id, workspace_id, agent_id NULL, name, url, transport, headers_sealed, header_names, via_gateway, enabled, …)`. A null `agent_id` means the server applies to every agent in the workspace.
  - `interface McpServer { id; agentId: string | null; name; url; transport: 'streamable_http' | 'sse'; headerNames: string[]; viaGateway: boolean; enabled: boolean; createdAt; updatedAt }`. This is the wire shape; header **values** are never included.
  - `interface McpServerInput { agentId: string | null; name: string; url: string; transport: 'streamable_http' | 'sse'; headers: Record<string, string>; viaGateway: boolean; enabled: boolean }`
  - `class McpServerRepository({ sql, sealer })` with `list(workspaceId, agentId: string | null | 'all')`, `create(workspaceId, input, userId)`, `update(workspaceId, id, patch: Partial<McpServerInput>)`, `remove(workspaceId, id)`, `static copyForAgent(tx, fromAgentId, toAgentId)`, and `forAgent(workspaceId, agentId): Promise<(McpServer & { headers: Record<string, string> })[]>`. `forAgent` returns the enabled servers (workspace-wide ones plus the agent's own) with headers **opened**, and is envelope-only.
  - Routes on `/api/v1/mcp-servers`: `GET /?agentId=<uuid>|workspace|all` (default `all`), `POST /`, `PATCH /:id`, `DELETE /:id`. All writes need `settings.write`. Sending headers when sealing is unavailable returns 412 `INTEGRATIONS_NOT_CONFIGURED`.

- [ ] **Step 1: Migration**

`server-ts/migrations/086_mcp_servers.up.sql`:

```sql
-- Berry migration 086: MCP servers an agent's loop connects to.
--
-- Workspace-wide when agent_id is NULL, otherwise one agent's. Headers are a
-- credential more often than not, so they are sealed with the integration key
-- and only their names are readable.

CREATE TABLE IF NOT EXISTS mcp_servers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id uuid,
    name text NOT NULL,
    url text NOT NULL,
    transport text NOT NULL DEFAULT 'streamable_http',
    headers_sealed bytea,
    header_names text[] NOT NULL DEFAULT ARRAY[]::text[],
    via_gateway boolean NOT NULL DEFAULT false,
    enabled boolean NOT NULL DEFAULT true,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mcp_servers_agent_fk FOREIGN KEY (workspace_id, agent_id)
        REFERENCES agents (workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT mcp_servers_name_ck CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
    CONSTRAINT mcp_servers_url_ck CHECK (url ~ '^https?://' AND char_length(url) <= 2000),
    CONSTRAINT mcp_servers_transport_ck CHECK (transport IN ('streamable_http', 'sse')),
    CONSTRAINT mcp_servers_headers_ck CHECK ((headers_sealed IS NULL) = (coalesce(array_length(header_names, 1), 0) = 0))
);

CREATE UNIQUE INDEX IF NOT EXISTS mcp_servers_name_key
    ON mcp_servers (workspace_id, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
```

- [ ] **Step 2: Write the failing tests**

`server-ts/src/mcp/repository.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { sealerFromKey } from '../integrations/sealing.ts';
import { dropAgentLayerWorld, seedAgentLayerWorld, type AgentLayerWorld } from '../mounts/agent-layer.fixture.ts';
import { McpServerRepository } from './repository.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('mcp servers', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: AgentLayerWorld;
   let repo: McpServerRepository;

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
      repo = new McpServerRepository({ sql, sealer: sealerFromKey(randomBytes(32).toString('base64')) });
   });
   after(async () => {
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });

   test('headers are sealed at rest and only their names are listed', async () => {
      const created = await repo.create(world.workspaceId, {
         agentId: null, name: 'docs', url: 'https://mcp.example.test/mcp', transport: 'streamable_http',
         headers: { Authorization: 'Bearer secret-token' }, viaGateway: false, enabled: true,
      }, world.ownerId);
      assert.deepEqual(created.headerNames, ['Authorization']);
      assert.equal(JSON.stringify(created).includes('secret-token'), false);
      const [raw] = await sql`SELECT headers_sealed FROM mcp_servers WHERE id = ${created.id}`;
      assert.equal(Buffer.from(raw?.headers_sealed as Buffer).toString('utf8').includes('secret-token'), false);
   });

   test('an agent gets workspace servers plus its own, enabled only, with headers opened', async () => {
      await repo.create(world.workspaceId, {
         agentId: world.agentId, name: 'own', url: 'https://own.example.test/mcp', transport: 'sse',
         headers: {}, viaGateway: false, enabled: true,
      }, world.ownerId);
      await repo.create(world.workspaceId, {
         agentId: null, name: 'off', url: 'https://off.example.test/mcp', transport: 'streamable_http',
         headers: {}, viaGateway: false, enabled: false,
      }, world.ownerId);
      const servers = await repo.forAgent(world.workspaceId, world.agentId);
      assert.deepEqual(servers.map((s) => s.name).sort(), ['docs', 'own']);
      assert.equal(servers.find((s) => s.name === 'docs')?.headers.Authorization, 'Bearer secret-token');
   });
});
```

`server-ts/src/mounts/mcp-servers.test.ts`: in the same style as `skills.test.ts`, register `mcpServerMounts({ sessions, sql, servers })` and assert:

```ts
   test('an owner adds a server and the response carries header names only', async () => {
      const res = await call(app, world.ownerToken, 'POST', '/api/v1/mcp-servers', {
         agentId: null, name: 'search', url: 'https://search.example.test/mcp',
         transport: 'streamable_http', headers: { 'X-Api-Key': 'k-123' }, viaGateway: false, enabled: true,
      });
      assert.equal(res.status, 201);
      assert.deepEqual(res.body.headerNames, ['X-Api-Key']);
      assert.equal(JSON.stringify(res.body).includes('k-123'), false);
   });

   test('a plain member may read but not add servers', async () => {
      assert.equal((await call(app, world.memberToken, 'GET', '/api/v1/mcp-servers')).status, 200);
      const res = await call(app, world.memberToken, 'POST', '/api/v1/mcp-servers', {
         agentId: null, name: 'nope', url: 'https://x.test/mcp', transport: 'sse', headers: {}, viaGateway: false, enabled: true,
      });
      assert.equal(res.status, 403);
   });

   test('a server for another workspace’s agent is not found', async () => {
      const res = await call(app, world.ownerToken, 'POST', '/api/v1/mcp-servers', {
         agentId: world.otherAgentId, name: 'cross', url: 'https://x.test/mcp', transport: 'sse', headers: {}, viaGateway: false, enabled: true,
      });
      assert.equal(res.status, 404);
   });

   test('an outsider lists nothing', async () => {
      const res = await call(app, world.outsiderToken, 'GET', '/api/v1/mcp-servers');
      assert.deepEqual(res.body.nodes, []);
   });
```

(Construct the repository with `sealerFromKey(randomBytes(32).toString('base64'))` in `before`.)

- [ ] **Step 3: Run them and confirm they fail**

Run: `cd /Users/secret/Code/berry-circle/server-ts && BERRY_TEST_DATABASE_URL=… node --test --experimental-strip-types src/mcp/repository.test.ts src/mounts/mcp-servers.test.ts`
Expected: FAIL, because the modules are not found.

- [ ] **Step 4: Implement the repository**

`server-ts/src/mcp/repository.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { toRFC3339, type Queryable, type Sql } from '../db/pool.ts';
import { Conflict, NotFound } from '../identity/errors.ts';
import type { Sealer } from '../integrations/sealing.ts';

export type McpTransport = 'streamable_http' | 'sse';

export interface McpServer {
   id: string;
   agentId: string | null;
   name: string;
   url: string;
   transport: McpTransport;
   headerNames: string[];
   viaGateway: boolean;
   enabled: boolean;
   createdAt: string;
   updatedAt: string;
}

export interface McpServerInput {
   agentId: string | null;
   name: string;
   url: string;
   transport: McpTransport;
   headers: Record<string, string>;
   viaGateway: boolean;
   enabled: boolean;
}

const COLUMNS = `id, agent_id, name, url, transport, header_names, via_gateway, enabled, created_at, updated_at`;

export class McpServerRepository {
   readonly #sql: Sql;
   readonly #sealer: Sealer;

   constructor(options: { sql: Sql; sealer: Sealer }) {
      this.#sql = options.sql;
      this.#sealer = options.sealer;
   }

   async list(workspaceId: string, agentId: string | null | 'all'): Promise<McpServer[]> {
      const rows = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)} FROM mcp_servers
          WHERE workspace_id = ${workspaceId}
            AND (${agentId === 'all'} OR agent_id IS NOT DISTINCT FROM ${agentId === 'all' ? null : agentId}::uuid)
          ORDER BY agent_id NULLS FIRST, name`;
      return rows.map(toServer);
   }

   async create(workspaceId: string, input: McpServerInput, userId: string): Promise<McpServer> {
      const sealed = this.#seal(input.headers);
      const [row] = await this.#sql`
         INSERT INTO mcp_servers (id, workspace_id, agent_id, name, url, transport, headers_sealed,
                                  header_names, via_gateway, enabled, created_by)
         VALUES (${randomUUID()}, ${workspaceId}, ${input.agentId}, ${input.name}, ${input.url},
                 ${input.transport}, ${sealed.bytes}, ${sealed.names}, ${input.viaGateway},
                 ${input.enabled}, ${userId})
         RETURNING ${this.#sql.unsafe(COLUMNS)}`.catch(classify);
      return toServer(row as Record<string, unknown>);
   }

   async update(workspaceId: string, id: string, patch: Partial<McpServerInput>): Promise<McpServer> {
      const sealed = patch.headers === undefined ? null : this.#seal(patch.headers);
      const [row] = await this.#sql`
         UPDATE mcp_servers SET
            name = COALESCE(${patch.name ?? null}, name),
            url = COALESCE(${patch.url ?? null}, url),
            transport = COALESCE(${patch.transport ?? null}, transport),
            via_gateway = COALESCE(${patch.viaGateway ?? null}::boolean, via_gateway),
            enabled = COALESCE(${patch.enabled ?? null}::boolean, enabled),
            headers_sealed = CASE WHEN ${sealed !== null} THEN ${sealed?.bytes ?? null}::bytea ELSE headers_sealed END,
            header_names = CASE WHEN ${sealed !== null} THEN ${sealed?.names ?? []}::text[] ELSE header_names END,
            updated_at = now()
          WHERE id = ${id} AND workspace_id = ${workspaceId}
          RETURNING ${this.#sql.unsafe(COLUMNS)}`.catch(classify);
      if (!row) throw new NotFound();
      return toServer(row);
   }

   async remove(workspaceId: string, id: string): Promise<void> {
      const deleted = await this.#sql`DELETE FROM mcp_servers WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      if (deleted.count !== 1) throw new NotFound();
   }

   static async copyForAgent(tx: Queryable, fromAgentId: string, toAgentId: string): Promise<void> {
      await tx`
         INSERT INTO mcp_servers (workspace_id, agent_id, name, url, transport, headers_sealed,
                                  header_names, via_gateway, enabled, created_by)
         SELECT workspace_id, ${toAgentId}, name, url, transport, headers_sealed, header_names,
                via_gateway, enabled, created_by
           FROM mcp_servers WHERE agent_id = ${fromAgentId}`;
   }

   /** Envelope-only: the one path where header values leave the database opened. */
   async forAgent(workspaceId: string, agentId: string): Promise<(McpServer & { headers: Record<string, string> })[]> {
      const rows = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)}, headers_sealed FROM mcp_servers
          WHERE workspace_id = ${workspaceId} AND enabled
            AND (agent_id IS NULL OR agent_id = ${agentId})
          ORDER BY agent_id NULLS FIRST, name`;
      return rows.map((row) => ({
         ...toServer(row),
         headers: row.headers_sealed
            ? (JSON.parse(this.#sealer.open(Buffer.from(row.headers_sealed as Buffer))) as Record<string, string>)
            : {},
      }));
   }

   #seal(headers: Record<string, string>): { bytes: Buffer | null; names: string[] } {
      const names = Object.keys(headers).sort();
      if (names.length === 0) return { bytes: null, names };
      return { bytes: this.#sealer.seal(JSON.stringify(headers)), names };
   }
}

function toServer(row: Record<string, unknown>): McpServer {
   return {
      id: row.id as string,
      agentId: (row.agent_id as string | null) ?? null,
      name: row.name as string,
      url: row.url as string,
      transport: row.transport as McpTransport,
      headerNames: (row.header_names as string[] | null) ?? [],
      viaGateway: row.via_gateway === true,
      enabled: row.enabled === true,
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}

function classify(error: unknown): never {
   const code = (error as { code?: string }).code;
   if (code === '23505') throw new Conflict();
   if (code === '23503') throw new NotFound();
   throw error;
}
```

- [ ] **Step 5: Implement the mount**

`server-ts/src/mounts/mcp-servers.ts`:

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { Conflict, NotFound } from '../identity/errors.ts';
import { SealingUnavailable } from '../integrations/sealing.ts';
import type { McpServerRepository } from '../mcp/repository.ts';
import { currentWorkspace, pathId, resolveScoped } from './shared.ts';
import { readJson } from './zod-body.ts';

const HEADER = /^[A-Za-z0-9-]{1,100}$/;
const inputSchema = z.strictObject({
   agentId: z.string().uuid().nullable().default(null),
   name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
   url: z.string().url().max(2000).refine((u) => /^https?:\/\//.test(u), 'url must be http(s)'),
   transport: z.enum(['streamable_http', 'sse']).default('streamable_http'),
   headers: z.record(z.string().regex(HEADER), z.string().max(4000)).default({}),
   viaGateway: z.boolean().default(false),
   enabled: z.boolean().default(true),
});
const patchSchema = inputSchema.omit({ agentId: true }).partial();

export function mcpServerMounts(options: { sessions: SessionService; sql: Sql; servers: McpServerRepository }): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));
   const { servers, sql } = options;
   const scope = (user: { id: string; currentWorkspaceId: string | null }, write: boolean) =>
      resolveScoped(sql, user.id, currentWorkspace(user.currentWorkspaceId), write ? 'settings.write' : 'product.read');

   route.get('/', async (context) => {
      const scoped = await scope(context.get('user'), false);
      const raw = new URL(context.req.url).searchParams.get('agentId') ?? 'all';
      const filter = raw === 'all' ? 'all' : raw === 'workspace' ? null : pathId(raw, 'Agent');
      return json({ nodes: await servers.list(scoped.ctx.workspaceId, filter) });
   });

   route.post('/', async (context) => {
      const scoped = await scope(context.get('user'), true);
      const input = await readJson(context, inputSchema);
      const created = await servers.create(scoped.ctx.workspaceId, input, context.get('user').id).catch(rethrow);
      return json(created, 201);
   });

   route.patch('/:id', async (context) => {
      const scoped = await scope(context.get('user'), true);
      const patch = await readJson(context, patchSchema);
      const updated = await servers
         .update(scoped.ctx.workspaceId, pathId(context.req.param('id'), 'MCP server'), patch)
         .catch(rethrow);
      return json(updated);
   });

   route.delete('/:id', async (context) => {
      const scoped = await scope(context.get('user'), true);
      await servers.remove(scoped.ctx.workspaceId, pathId(context.req.param('id'), 'MCP server')).catch(rethrow);
      return new Response(null, { status: 204 });
   });

   return [{ prefix: '/api/v1/mcp-servers', handler: route }];
}

function rethrow(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('MCP server');
   if (error instanceof Conflict) throw new ApiError(409, 'MCP_SERVER_NAME_TAKEN', 'An MCP server with that name already exists.');
   if (error instanceof SealingUnavailable) {
      throw new ApiError(412, 'INTEGRATIONS_NOT_CONFIGURED', 'This server cannot store credentials.');
   }
   throw error;
}
```

- [ ] **Step 6: Run and confirm everything passes**

Run: `cd /Users/secret/Code/berry-circle/server-ts && BERRY_TEST_DATABASE_URL=… node --test --experimental-strip-types src/mcp/repository.test.ts src/mounts/mcp-servers.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server-ts/migrations/086_mcp_servers.up.sql server-ts/src/mcp server-ts/src/mounts/mcp-servers.ts server-ts/src/mounts/mcp-servers.test.ts
git commit -m "feat(server-ts): let a workspace register MCP servers for its agents, headers sealed"
```

---
### Task 5: Agent lifecycle — archived list, restore, copy, cancel all tasks, task list, guide agent

**Files:**
- Create: `server-ts/migrations/091_guide_agent.up.sql`, `server-ts/src/mounts/agents.lifecycle.test.ts`
- Modify: `server-ts/src/agents/repository.ts` (`AGENT_COLUMNS` + `systemRole`, `list` gains `archived`, add `restore`, `copy`, `guide`), `server-ts/src/runs/repository.ts` (add `listByAgent`), `server-ts/src/mounts/agents.ts` (options + routes)

**Interfaces:**
- Consumes: `SkillRepository.copyBindings` (Task 2), `McpServerRepository.copyForAgent` (Task 4), `RunLedger.markCancelled`, `serializeRun` (exported from `mounts/runs.ts:243`).
- Produces:
  - Migration 091: `agents.system_role text NULL CHECK (system_role IN ('guide'))`, a unique partial index per workspace, and `berry_ensure_workspace_guide(uuid)`, called by a trigger on workspace insert and a backfill. The guide is **not** protected, so it can be archived.
  - `Agent` gains `systemRole: string | null`. Wire `serializeAgent` gains `systemRole` and `archivedAt: string | null`.
  - `AgentRepository.list(workspaceId, status, after, limit, archived = false)`, `restore(agentId, workspaceId): Promise<Agent>`, `copy(agentId, workspaceId): Promise<Agent>`, `guide(workspaceId): Promise<Agent | null>`
  - `RunRepository.listByAgent(agentId, after: RunCursor | null, limit, filter?: RunFilter): Promise<Run[]>`
  - `AgentOptions` gains `runs?: RunRepository` and `ledger?: Pick<RunLedger, 'markCancelled'>`.
  - Routes: `GET /api/v1/agents?archived=true`; `GET /api/v1/agents/guide` (404 when none); `POST /:agentId/restore` → 200 agent; `POST /:agentId/copy` → 201 agent; `POST /:agentId/cancel-tasks` → `{ cancelled: number }`; `GET /:agentId/tasks?first&after&status` → run connection.

- [ ] **Step 1: Migration**

`server-ts/migrations/091_guide_agent.up.sql`:

```sql
-- Berry migration 091: a guide agent in every workspace.
--
-- The onboarding chat talks to it. Unlike the orchestrator it is an ordinary
-- agent: it can be edited, archived and restored; the index only stops a
-- workspace from getting two.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS system_role text;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_system_role_ck;
ALTER TABLE agents ADD CONSTRAINT agents_system_role_ck
    CHECK (system_role IS NULL OR system_role IN ('guide')) NOT VALID;
CREATE UNIQUE INDEX IF NOT EXISTS agents_one_guide_per_workspace_key
    ON agents (workspace_id) WHERE system_role = 'guide';

CREATE OR REPLACE FUNCTION berry_ensure_workspace_guide(target_workspace uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF target_workspace IS NULL THEN
        RETURN;
    END IF;
    INSERT INTO agents (id, workspace_id, name, description, instructions, status, system_role)
    VALUES (
        gen_random_uuid(),
        target_workspace,
        'Guide',
        'Helps new members find their way around Berry.',
        'You are Guide, the Berry workspace helper. Explain how tasks, boards, agents, '
        || 'skills, squads and reviews work, suggest a first task, and point to the page '
        || 'where each thing is done. Be brief and concrete.',
        'available',
        'guide'
    )
    ON CONFLICT DO NOTHING;
END
$$;

CREATE OR REPLACE FUNCTION berry_workspace_guide_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM berry_ensure_workspace_guide(NEW.id);
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS berry_workspaces_ensure_guide ON workspaces;
CREATE TRIGGER berry_workspaces_ensure_guide
    AFTER INSERT ON workspaces
    FOR EACH ROW
    EXECUTE FUNCTION berry_workspace_guide_trigger();

DO $$
DECLARE
    workspace_row record;
BEGIN
    FOR workspace_row IN SELECT id FROM workspaces WHERE deleted_at IS NULL LOOP
        PERFORM berry_ensure_workspace_guide(workspace_row.id);
    END LOOP;
END
$$;
```

- [ ] **Step 2: Write the failing mount test**

`server-ts/src/mounts/agents.lifecycle.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { AgentRepository } from '../agents/repository.ts';
import { SessionService } from '../auth/sessions.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { IdempotencyStore } from '../http/idempotency.ts';
import { Registry } from '../http/registry.ts';
import { RunLedger } from '../runs/ledger.ts';
import { RunRepository } from '../runs/repository.ts';
import { call, dropAgentLayerWorld, seedAgentLayerWorld, type AgentLayerWorld } from './agent-layer.fixture.ts';
import { agentMounts } from './agents.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('agent lifecycle', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let world: AgentLayerWorld;

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
      const registry = new Registry();
      registry.registerAll(agentMounts({
         sessions: new SessionService({ sql, sessionTtlMs: 3_600_000 }),
         agents: new AgentRepository(sql),
         idempotency: new IdempotencyStore(sql),
         catalog: null,
         runs: new RunRepository(sql),
         ledger: new RunLedger({ sql }),
      }));
      app = createApp(registry);
   });
   after(async () => {
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });

   test('every workspace has a guide, and it is reachable by role', async () => {
      const res = await call(app, world.ownerToken, 'GET', '/api/v1/agents/guide');
      assert.equal(res.status, 200);
      assert.equal(res.body.systemRole, 'guide');
   });

   test('an archived agent leaves the list, appears under archived, and comes back on restore', async () => {
      assert.equal((await call(app, world.ownerToken, 'DELETE', `/api/v1/agents/${world.agentId}`)).status, 204);
      const live = await call(app, world.ownerToken, 'GET', '/api/v1/agents');
      assert.ok(!(live.body.nodes as { id: string }[]).some((a) => a.id === world.agentId));
      const archived = await call(app, world.ownerToken, 'GET', '/api/v1/agents?archived=true');
      assert.ok((archived.body.nodes as { id: string }[]).some((a) => a.id === world.agentId));
      const restored = await call(app, world.ownerToken, 'POST', `/api/v1/agents/${world.agentId}/restore`);
      assert.equal(restored.status, 200);
      assert.equal(restored.body.archivedAt, null);
   });

   test('a copy is a new agent with the same instructions and skills', async () => {
      await sql`UPDATE agents SET instructions = 'Be terse.' WHERE id = ${world.agentId}`;
      const copy = await call(app, world.ownerToken, 'POST', `/api/v1/agents/${world.agentId}/copy`);
      assert.equal(copy.status, 201);
      assert.notEqual(copy.body.id, world.agentId);
      assert.equal(copy.body.instructions, 'Be terse.');
      assert.match(copy.body.name as string, /\(copy\)$/);
   });

   test('cancel-tasks cancels every queued run of the agent and lists them as tasks', async () => {
      await sql`
         INSERT INTO runs (issue_id, board_id, agent_id, requested_by)
         VALUES (${world.issueId}, ${world.boardId}, ${world.agentId}, ${world.ownerId})`;
      const tasks = await call(app, world.ownerToken, 'GET', `/api/v1/agents/${world.agentId}/tasks`);
      assert.equal((tasks.body.nodes as unknown[]).length, 1);
      const res = await call(app, world.ownerToken, 'POST', `/api/v1/agents/${world.agentId}/cancel-tasks`);
      assert.deepEqual(res.body, { cancelled: 1 });
      const [row] = await sql`SELECT status FROM runs WHERE agent_id = ${world.agentId}`;
      assert.equal(row?.status, 'cancelled');
   });

   test('another workspace’s agent cannot be restored, copied or cancelled', async () => {
      for (const action of ['restore', 'copy', 'cancel-tasks']) {
         const res = await call(app, world.ownerToken, 'POST', `/api/v1/agents/${world.otherAgentId}/${action}`);
         assert.equal(res.status, 404, action);
      }
   });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd /Users/secret/Code/berry-circle/server-ts && BERRY_TEST_DATABASE_URL=… node --test --experimental-strip-types src/mounts/agents.lifecycle.test.ts`
Expected: FAIL with 404s. The guide route and the new routes do not exist yet.

- [ ] **Step 4: Implement the repository additions**

In `server-ts/src/agents/repository.ts`:
- Add `agent.system_role, agent.archived_at` to `AGENT_COLUMNS`. Add `systemRole: string | null;` and `archivedAt: string | null;` to `interface Agent`. Add to `toAgent`: `systemRole: (row.system_role as string | null) ?? null, archivedAt: toRFC3339(row.archived_at as string | null),`.
- Change the `list` signature to add `archived = false`, and replace `WHERE agent.archived_at IS NULL` with `WHERE (agent.archived_at IS NULL) = ${!archived}`.
- Add these methods and imports (`SkillRepository` from `../skills/repository.ts`, `McpServerRepository` from `../mcp/repository.ts`):

```ts
   async restore(agentId: string, workspaceId: string): Promise<Agent> {
      // Restoring a live agent is what the caller wanted, so no row updated is
      // not an error; `get` then answers NotFound only for a missing agent.
      await this.sql`
         UPDATE agents SET archived_at = NULL, updated_at = now()
          WHERE id = ${agentId} AND workspace_id = ${workspaceId} AND archived_at IS NOT NULL`;
      return this.get(agentId, workspaceId);
   }

   /**
    * A new agent with the same configuration, skills and MCP servers.
    *
    * Sealed env travels too (same workspace, same key); runs, labels of
    * history and the protected flag do not.
    */
   async copy(agentId: string, workspaceId: string): Promise<Agent> {
      const id = this.newId();
      await this.sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const inserted = await tx`
            INSERT INTO agents (id, workspace_id, board_id, name, description, avatar_url, status,
                                capabilities, skills, instructions, model_provider, model_name, permissions)
            SELECT ${id}, workspace_id, NULL, left(name, 93) || ' (copy)', description, avatar_url,
                   'available', capabilities, skills, instructions, model_provider, model_name, permissions
              FROM agents WHERE id = ${agentId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
         if (inserted.count !== 1) throw new NotFound();
         await SkillRepository.copyBindings(tx, agentId, id);
         await McpServerRepository.copyForAgent(tx, agentId, id);
      });
      return this.get(id, workspaceId);
   }

   async guide(workspaceId: string): Promise<Agent | null> {
      const [row] = await this.sql`
         SELECT ${this.sql.unsafe(AGENT_COLUMNS)} FROM agents AS agent
          WHERE agent.workspace_id = ${workspaceId} AND agent.system_role = 'guide'
            AND agent.archived_at IS NULL`;
      return row ? toAgent(row) : null;
   }
```

Task 6 extends `copy` to carry `labels`, `env_sealed`, `env_names`, `assign_scope` and `mention_scope`.

In `server-ts/src/runs/repository.ts`, add after `listByIssue`:

```ts
   /** One agent's runs across its workspace, newest first — the agent's task list. */
   async listByAgent(agentId: string, after: RunCursor | null, limit: number, filter: RunFilter = {}): Promise<Run[]> {
      const rows = await this.#sql`
         SELECT ${this.#sql.unsafe(RUN_COLUMNS)} ${this.#sql.unsafe(RUN_SOURCE)}
          WHERE r.agent_id = ${agentId}
            AND (${filter.status == null} OR r.status = ${filter.status ?? null}::run_status)
            AND (${after === null} OR (r.created_at, r.id) < (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT ${limit}`;
      return rows.map(toRun);
   }
```

Chat runs have no board after A lands, so Task 13 changes `RUN_SOURCE` to a `LEFT JOIN` if A made `board_id` nullable.

- [ ] **Step 5: Implement the routes**

In `server-ts/src/mounts/agents.ts`:
- `AgentOptions` gains `runs?: RunRepository;` and `ledger?: Pick<RunLedger, 'markCancelled'>;`.
- `serializeAgent` adds `systemRole: agent.systemRole, archivedAt: agent.archivedAt,`.
- `parseListQuery` accepts `archived` (`'true' | 'false'`). It returns `archived: boolean`; the `GET /` handler passes `query.archived` into `agents.list(...)` and prefixes the cursor scope with `archived.`.
- Register `route.get('/guide', …)` next to `/capabilities`, **before** `/:agentId`:

```ts
   route.get('/guide', async (context) => {
      const workspaceId = currentWorkspace(context.get('user').currentWorkspaceId);
      await agents.authorizeWorkspace(context.get('user').id, workspaceId, 'product.read').catch(rethrowWorkspace);
      const guide = await agents.guide(workspaceId);
      if (!guide) throw ApiError.notFound('Agent');
      return json(serializeAgent(guide));
   });
```

- Add after `route.delete('/:agentId', …)`:

```ts
   route.post('/:agentId/restore', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      const scope = await agents.authorizeAgent(context.get('user').id, agentId, 'product.write').catch(rethrowAgent);
      return json(serializeAgent(await agents.restore(agentId, scope.workspaceId).catch(rethrowAgent)));
   });

   route.post('/:agentId/copy', idempotent(options.idempotency), async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      const scope = await agents.authorizeAgent(context.get('user').id, agentId, 'product.write').catch(rethrowAgent);
      return json(serializeAgent(await agents.copy(agentId, scope.workspaceId).catch(rethrowAgent)), 201);
   });

   route.post('/:agentId/cancel-tasks', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      await agents.authorizeAgent(context.get('user').id, agentId, 'product.write').catch(rethrowAgent);
      if (!options.runs || !options.ledger) throw new ApiError(503, 'RUNS_UNAVAILABLE', 'Runs are not served here.');
      let cancelled = 0;
      for (const status of ['queued', 'running'] as const) {
         for (const run of await options.runs.listByAgent(agentId, null, 100, { status })) {
            // A run that finished meanwhile is not an error; it simply is not counted.
            const done = await options.ledger.markCancelled(run.id).then(() => true, () => false);
            if (done) cancelled += 1;
         }
      }
      return json({ cancelled });
   });

   route.get('/:agentId/tasks', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      await agents.authorizeAgent(context.get('user').id, agentId, 'product.read').catch(rethrowAgent);
      if (!options.runs) throw new ApiError(503, 'RUNS_UNAVAILABLE', 'Runs are not served here.');
      const url = new URL(context.req.url);
      const first = Math.min(Math.max(Number(url.searchParams.get('first') ?? '50') || 50, 1), 100);
      const status = url.searchParams.get('status') ?? undefined;
      const scope = `agents.tasks.${agentId}`;
      const rawAfter = url.searchParams.get('after');
      const after = rawAfter ? decodeTimeCursor(rawAfter, scope) : null;
      const rows = await options.runs.listByAgent(agentId, after, first + 1, { status });
      const nodes = rows.slice(0, first);
      const last = nodes.at(-1);
      return json({
         nodes: nodes.map(serializeRun),
         pageInfo: {
            hasNextPage: rows.length > first,
            endCursor: last ? encodeCursor(scope, { createdAt: last.createdAt, id: last.id }) : null,
         },
      });
   });
```

The imports are `decodeTimeCursor` from `../http/cursor.ts` (already used by `mounts/comments.ts`), `serializeRun` from `./runs.ts`, `type RunRepository` and `type RunLedger`. `authorizeAgent` does not filter archived agents, so `restore` reaches them. `rethrowAgent` maps `NotFound` → 404, which covers another workspace's agent.

- [ ] **Step 6: Run and confirm it passes**

Run: `cd /Users/secret/Code/berry-circle/server-ts && BERRY_TEST_DATABASE_URL=… node --test --experimental-strip-types src/mounts/agents.lifecycle.test.ts src/agents/repository.test.ts && pnpm typecheck && BERRY_TEST_DATABASE_URL=… pnpm test`
Expected: PASS. The **DB-backed** full suite is required here, not the offline one. Migration 091 adds a guide agent to every workspace, including those that existing tests create. Any existing test that counts a new workspace's agents (for example, one that expects only the orchestrator) must be updated to exclude `system_role = 'guide'` rows. Those failures only show up with the database.

- [ ] **Step 7: Commit**

```bash
git add server-ts/migrations/091_guide_agent.up.sql server-ts/src/agents/repository.ts server-ts/src/runs/repository.ts \
  server-ts/src/mounts/agents.ts server-ts/src/mounts/agents.lifecycle.test.ts
git commit -m "feat(server-ts): let agents be restored, copied and stopped, and seed a guide"
```

---
### Task 6: Agent profile — env vars (sealed), labels, avatar upload, access scopes

**Files:**
- Create: `server-ts/migrations/087_agent_profile.up.sql`, `server-ts/src/agents/profile.ts`, `server-ts/src/agents/access.ts`, `server-ts/src/agents/access.test.ts`, `server-ts/src/mounts/agents.profile.test.ts`
- Modify: `server-ts/src/agents/repository.ts` (columns and `copy`), `server-ts/src/mounts/agents.ts` (options, routes, the extended `PUT /permissions`), `server-ts/src/mounts/issues.ts` (the `agentAccess` option and two call sites next to `assertAssignee`, ~lines 173 and 221)

**Interfaces:**
- Consumes: `Sealer`; `AgentRepository.authorizeAgent`.
- Produces:
  - Migration 087 adds these columns to `agents`: `labels text[]`, `env_sealed bytea`, `env_names text[]`, `assign_scope text DEFAULT 'everyone'`, `mention_scope text DEFAULT 'everyone'`, both scopes checked against `('everyone','admins','listed')`. It also creates `agent_access_members(agent_id, user_id, workspace_id)` and `agent_avatars(agent_id, workspace_id, content_type, bytes, updated_at)`, and relaxes `avatar_url` to allow `/api/v1/agents/<id>/avatar?v=<n>`.
  - `type AgentAction = 'assign' | 'mention'`, `type AccessScope = 'everyone' | 'admins' | 'listed'`
  - `canUseAgent(sql: Queryable, input: { workspaceId: string; agentId: string; userId: string; action: AgentAction }): Promise<boolean>`. Owners and admins always may; `listed` means the user is in `agent_access_members`.
  - `interface AgentAccess { assertCanAssign(input: { workspaceId: string; agentId: string; userId: string }): Promise<void> }`. It throws `ApiError(403, 'AGENT_ACCESS_DENIED', …)`.
  - `agentAccessGuard(sql): AgentAccess`
  - `class AgentProfileRepository({ sql, sealer })` with `setLabels`, `setEnv(workspaceId, agentId, env: Record<string, string>)`, `envFor(workspaceId, agentId): Promise<Record<string, string>>` (opened, envelope-only), `getAccess`, `setAccess(workspaceId, agentId, access: AgentAccessSettings)`, `putAvatar`, `getAvatar`
  - `interface AgentAccessSettings { assign: AccessScope; mention: AccessScope; members: string[] }`
  - Wire `Agent` gains `labels: string[]`, `envNames: string[]` and `access: { assign, mention }`.
  - Routes: `PUT /:agentId/labels` `{ labels }`; `PUT /:agentId/env` `{ env }` returns `{ envNames }`, with 412 when sealing is unavailable; `PUT /:agentId/avatar` (body `image/png|jpeg|webp|gif`, ≤ 512 KiB) returns the agent; `GET /:agentId/avatar` returns the bytes; `GET /:agentId/access`; `PUT /:agentId/permissions` now accepts `{ permissions?, access? }`, with at least one required.

- [ ] **Step 1: Migration**

`server-ts/migrations/087_agent_profile.up.sql`:

```sql
-- Berry migration 087: what completes an agent's profile.
--
-- env is sealed like every other credential and only its names are readable.
-- Access scopes say which members may assign or mention the agent; owners and
-- admins always may, so a workspace can never lock itself out of an agent.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS labels text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE agents ADD COLUMN IF NOT EXISTS env_sealed bytea;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS env_names text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE agents ADD COLUMN IF NOT EXISTS assign_scope text NOT NULL DEFAULT 'everyone';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS mention_scope text NOT NULL DEFAULT 'everyone';

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_profile_ck;
ALTER TABLE agents ADD CONSTRAINT agents_profile_ck CHECK (
    coalesce(array_length(labels, 1), 0) <= 20
    AND coalesce(array_length(env_names, 1), 0) <= 50
    AND assign_scope IN ('everyone', 'admins', 'listed')
    AND mention_scope IN ('everyone', 'admins', 'listed')
) NOT VALID;

-- The avatar may be an upload served by Berry, not only an external URL.
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_avatar_url_check;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_avatar_url_ck;
ALTER TABLE agents ADD CONSTRAINT agents_avatar_url_ck CHECK (
    avatar_url IS NULL
    OR avatar_url ~ '^https?://'
    OR avatar_url ~ '^/api/v1/agents/[0-9a-f-]{36}/avatar\?v=[0-9]+$'
) NOT VALID;

CREATE TABLE IF NOT EXISTS agent_access_members (
    agent_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL,
    PRIMARY KEY (agent_id, user_id),
    CONSTRAINT agent_access_members_agent_fk FOREIGN KEY (workspace_id, agent_id)
        REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_avatars (
    agent_id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    content_type text NOT NULL,
    bytes bytea NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_avatars_agent_fk FOREIGN KEY (workspace_id, agent_id)
        REFERENCES agents (workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT agent_avatars_type_ck CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
    CONSTRAINT agent_avatars_size_ck CHECK (octet_length(bytes) <= 524288)
);
```

(If the unnamed inline check from 003 was named differently on an old database, `\d agents` shows the name. The `DROP … IF EXISTS` line is then adjusted in a **new** migration, never by editing this one after it has been applied.)

- [ ] **Step 2: Write the failing tests**

`server-ts/src/agents/access.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { dropAgentLayerWorld, seedAgentLayerWorld, type AgentLayerWorld } from '../mounts/agent-layer.fixture.ts';
import { canUseAgent } from './access.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('agent access scopes', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: AgentLayerWorld;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
   });
   after(async () => {
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });

   const can = (userId: string, action: 'assign' | 'mention') =>
      canUseAgent(sql, { workspaceId: world.workspaceId, agentId: world.agentId, userId, action });

   test('by default every member may assign and mention', async () => {
      assert.equal(await can(world.memberId, 'assign'), true);
      assert.equal(await can(world.memberId, 'mention'), true);
   });

   test('admins-only keeps members out and owners in', async () => {
      await sql`UPDATE agents SET assign_scope = 'admins' WHERE id = ${world.agentId}`;
      assert.equal(await can(world.memberId, 'assign'), false);
      assert.equal(await can(world.ownerId, 'assign'), true);
      assert.equal(await can(world.memberId, 'mention'), true);
   });

   test('listed lets exactly the listed members in', async () => {
      await sql`UPDATE agents SET mention_scope = 'listed' WHERE id = ${world.agentId}`;
      assert.equal(await can(world.memberId, 'mention'), false);
      await sql`INSERT INTO agent_access_members (agent_id, user_id, workspace_id)
                VALUES (${world.agentId}, ${world.memberId}, ${world.workspaceId})`;
      assert.equal(await can(world.memberId, 'mention'), true);
   });

   test('someone outside the workspace never may', async () => {
      assert.equal(await can(world.outsiderId, 'mention'), false);
   });
});
```

`server-ts/src/mounts/agents.profile.test.ts` uses the same `before` as Task 5, adding `profile: new AgentProfileRepository({ sql, sealer: sealerFromKey(randomBytes(32).toString('base64')) })`:

```ts
   test('env values are sealed and only names come back', async () => {
      const res = await call(app, world.ownerToken, 'PUT', `/api/v1/agents/${world.agentId}/env`, {
         env: { API_TOKEN: 'tok-999', REGION: 'eu' },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.envNames, ['API_TOKEN', 'REGION']);
      const agent = await call(app, world.ownerToken, 'GET', `/api/v1/agents/${world.agentId}`);
      assert.equal(JSON.stringify(agent.body).includes('tok-999'), false);
      assert.deepEqual(agent.body.envNames, ['API_TOKEN', 'REGION']);
   });

   test('a member cannot change env; an owner can', async () => {
      const res = await call(app, world.memberToken, 'PUT', `/api/v1/agents/${world.agentId}/env`, { env: {} });
      assert.equal(res.status, 403);
   });

   test('labels are stored as a set', async () => {
      const res = await call(app, world.ownerToken, 'PUT', `/api/v1/agents/${world.agentId}/labels`, {
         labels: ['backend', 'backend', 'infra'],
      });
      assert.deepEqual(res.body.labels, ['backend', 'infra']);
   });

   test('an uploaded avatar is served back and becomes the avatar url', async () => {
      const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
      const put = await app.request(`/api/v1/agents/${world.agentId}/avatar`, {
         method: 'PUT',
         headers: { authorization: `Bearer ${world.ownerToken}`, 'content-type': 'image/png' },
         body: png,
      });
      assert.equal(put.status, 200);
      const body = (await put.json()) as { avatarUrl: string };
      assert.match(body.avatarUrl, /^\/api\/v1\/agents\/[0-9a-f-]{36}\/avatar\?v=\d+$/);
      const get = await app.request(`/api/v1/agents/${world.agentId}/avatar`, {
         headers: { authorization: `Bearer ${world.ownerToken}` },
      });
      assert.equal(get.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await get.arrayBuffer()), png);
   });

   test('access scopes are set through permissions and read back', async () => {
      const res = await call(app, world.ownerToken, 'PUT', `/api/v1/agents/${world.agentId}/permissions`, {
         access: { assign: 'listed', mention: 'everyone', members: [world.memberId] },
      });
      assert.equal(res.status, 200);
      const access = await call(app, world.ownerToken, 'GET', `/api/v1/agents/${world.agentId}/access`);
      assert.deepEqual(access.body, { assign: 'listed', mention: 'everyone', members: [world.memberId] });
   });

   test('listing a user from another workspace is refused', async () => {
      const res = await call(app, world.ownerToken, 'PUT', `/api/v1/agents/${world.agentId}/permissions`, {
         access: { assign: 'listed', mention: 'everyone', members: [world.outsiderId] },
      });
      assert.equal(res.status, 422);
      assert.equal((res.body.error as { code: string }).code, 'VALIDATION_FAILED');
   });
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `cd /Users/secret/Code/berry-circle/server-ts && BERRY_TEST_DATABASE_URL=… node --test --experimental-strip-types src/agents/access.test.ts src/mounts/agents.profile.test.ts`
Expected: FAIL, because the modules and routes are missing.

- [ ] **Step 4: Implement access and profile**

`server-ts/src/agents/access.ts`:

```ts
import type { Queryable, Sql } from '../db/pool.ts';
import { ApiError } from '../http/errors.ts';

export type AgentAction = 'assign' | 'mention';
export type AccessScope = 'everyone' | 'admins' | 'listed';

/**
 * Whether this member may hand work to this agent.
 *
 * Owners and admins always may: a scope that could lock every administrator
 * out of an agent would make it unmanageable. A non-member never may.
 */
export async function canUseAgent(
   sql: Queryable,
   input: { workspaceId: string; agentId: string; userId: string; action: AgentAction }
): Promise<boolean> {
   const [row] = await sql`
      SELECT membership.role::text AS role,
             CASE WHEN ${input.action} = 'assign' THEN agent.assign_scope ELSE agent.mention_scope END AS scope,
             EXISTS (SELECT 1 FROM agent_access_members m
                      WHERE m.agent_id = agent.id AND m.user_id = ${input.userId}) AS listed
        FROM agents AS agent
        JOIN workspace_memberships AS membership
          ON membership.workspace_id = agent.workspace_id AND membership.user_id = ${input.userId}
       WHERE agent.id = ${input.agentId} AND agent.workspace_id = ${input.workspaceId}`;
   if (!row) return false;
   if (row.role === 'owner' || row.role === 'admin') return true;
   if (row.scope === 'everyone') return true;
   if (row.scope === 'listed') return row.listed === true;
   return false;
}

export interface AgentAccess {
   assertCanAssign(input: { workspaceId: string; agentId: string; userId: string }): Promise<void>;
}

export function agentAccessGuard(sql: Sql): AgentAccess {
   return {
      async assertCanAssign(input) {
         if (!(await canUseAgent(sql, { ...input, action: 'assign' }))) {
            throw new ApiError(403, 'AGENT_ACCESS_DENIED', 'You may not assign work to this agent.');
         }
      },
   };
}
```

`server-ts/src/agents/profile.ts`:

```ts
import type { Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import type { Sealer } from '../integrations/sealing.ts';
import type { AccessScope } from './access.ts';

export interface AgentAccessSettings {
   assign: AccessScope;
   mention: AccessScope;
   members: string[];
}

export class AgentProfileRepository {
   readonly #sql: Sql;
   readonly #sealer: Sealer;

   constructor(options: { sql: Sql; sealer: Sealer }) {
      this.#sql = options.sql;
      this.#sealer = options.sealer;
   }

   async setLabels(workspaceId: string, agentId: string, labels: string[]): Promise<void> {
      const set = [...new Set(labels.map((l) => l.trim()).filter(Boolean))].sort();
      await this.#touch(await this.#sql`
         UPDATE agents SET labels = ${set}, updated_at = now()
          WHERE id = ${agentId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`);
   }

   async setEnv(workspaceId: string, agentId: string, env: Record<string, string>): Promise<string[]> {
      const names = Object.keys(env).sort();
      // Sealed before the statement, so a missing key fails before anything is written.
      const sealed = names.length === 0 ? null : this.#sealer.seal(JSON.stringify(env));
      await this.#touch(await this.#sql`
         UPDATE agents SET env_sealed = ${sealed}, env_names = ${names}, updated_at = now()
          WHERE id = ${agentId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`);
      return names;
   }

   /** Envelope-only. */
   async envFor(workspaceId: string, agentId: string): Promise<Record<string, string>> {
      const [row] = await this.#sql`
         SELECT env_sealed FROM agents WHERE id = ${agentId} AND workspace_id = ${workspaceId}`;
      if (!row) throw new NotFound();
      if (!row.env_sealed) return {};
      return JSON.parse(this.#sealer.open(Buffer.from(row.env_sealed as Buffer))) as Record<string, string>;
   }

   async getAccess(workspaceId: string, agentId: string): Promise<AgentAccessSettings> {
      const [row] = await this.#sql`
         SELECT assign_scope, mention_scope,
                COALESCE((SELECT array_agg(user_id::text ORDER BY user_id) FROM agent_access_members
                           WHERE agent_id = ${agentId}), ARRAY[]::text[]) AS members
           FROM agents WHERE id = ${agentId} AND workspace_id = ${workspaceId}`;
      if (!row) throw new NotFound();
      return {
         assign: row.assign_scope as AccessScope,
         mention: row.mention_scope as AccessScope,
         members: row.members as string[],
      };
   }

   /** Members must belong to the workspace; the caller turns false into a 422 VALIDATION_FAILED. */
   async setAccess(workspaceId: string, agentId: string, access: AgentAccessSettings): Promise<boolean> {
      return (await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const members = [...new Set(access.members)];
         const [count] = await tx`
            SELECT count(*)::int AS n FROM workspace_memberships
             WHERE workspace_id = ${workspaceId} AND user_id IN ${tx(members.length ? members : ['00000000-0000-0000-0000-000000000000'])}`;
         if (Number(count?.n) !== members.length) return false;
         const updated = await tx`
            UPDATE agents SET assign_scope = ${access.assign}, mention_scope = ${access.mention}, updated_at = now()
             WHERE id = ${agentId} AND workspace_id = ${workspaceId}`;
         if (updated.count !== 1) throw new NotFound();
         await tx`DELETE FROM agent_access_members WHERE agent_id = ${agentId}`;
         for (const userId of members) {
            await tx`INSERT INTO agent_access_members (agent_id, user_id, workspace_id)
                     VALUES (${agentId}, ${userId}, ${workspaceId})`;
         }
         return true;
      })) as boolean;
   }

   async putAvatar(workspaceId: string, agentId: string, contentType: string, bytes: Buffer): Promise<string> {
      const version = Date.now();
      const avatarUrl = `/api/v1/agents/${agentId}/avatar?v=${version}`;
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const updated = await tx`
            UPDATE agents SET avatar_url = ${avatarUrl}, updated_at = now()
             WHERE id = ${agentId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
         if (updated.count !== 1) throw new NotFound();
         await tx`
            INSERT INTO agent_avatars (agent_id, workspace_id, content_type, bytes)
            VALUES (${agentId}, ${workspaceId}, ${contentType}, ${bytes})
            ON CONFLICT (agent_id) DO UPDATE
               SET content_type = EXCLUDED.content_type, bytes = EXCLUDED.bytes, updated_at = now()`;
      });
      return avatarUrl;
   }

   async getAvatar(workspaceId: string, agentId: string): Promise<{ contentType: string; bytes: Buffer }> {
      const [row] = await this.#sql`
         SELECT content_type, bytes FROM agent_avatars
          WHERE agent_id = ${agentId} AND workspace_id = ${workspaceId}`;
      if (!row) throw new NotFound();
      return { contentType: row.content_type as string, bytes: Buffer.from(row.bytes as Buffer) };
   }

   #touch(result: { count: number }): void {
      if (result.count !== 1) throw new NotFound();
   }
}
```

- [ ] **Step 5: Wire routes, repository columns and the issues hook**

- `agents/repository.ts`: add `agent.labels, agent.env_names, agent.assign_scope, agent.mention_scope` to `AGENT_COLUMNS`. Add `labels: string[]; envNames: string[]; access: { assign: string; mention: string }` to `Agent`, and map them in `toAgent`. In `copy`, add `labels, env_sealed, env_names, assign_scope, mention_scope` to both the column list and the `SELECT`.
- `mounts/agents.ts`: `serializeAgent` adds `labels`, `envNames` and `access`. `AgentOptions` gains `profile?: AgentProfileRepository`. Add the routes:

```ts
   const requireProfile = () => {
      if (!options.profile) throw new ApiError(503, 'AGENT_PROFILE_UNAVAILABLE', 'Agent profiles are not served here.');
      return options.profile;
   };

   route.put('/:agentId/labels', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      const scope = await agents.authorizeAgent(context.get('user').id, agentId, 'product.write').catch(rethrowAgent);
      const { labels } = await readJson(context, z.strictObject({ labels: z.array(z.string().min(1).max(40)).max(20) }));
      await requireProfile().setLabels(scope.workspaceId, agentId, labels).catch(rethrowAgent);
      return json(serializeAgent(await agents.get(agentId, scope.workspaceId)));
   });

   route.put('/:agentId/env', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      const scope = await agents.authorizeAgent(context.get('user').id, agentId, 'workspace.admin').catch(rethrowAgent);
      const { env } = await readJson(context, z.strictObject({
         env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/), z.string().max(8000)),
      }));
      const envNames = await requireProfile().setEnv(scope.workspaceId, agentId, env).catch((error: unknown) => {
         if (error instanceof SealingUnavailable) {
            throw new ApiError(412, 'INTEGRATIONS_NOT_CONFIGURED', 'This server cannot store credentials.');
         }
         return rethrowAgent(error);
      });
      return json({ envNames });
   });

   route.put('/:agentId/avatar', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      const scope = await agents.authorizeAgent(context.get('user').id, agentId, 'product.write').catch(rethrowAgent);
      const type = (context.req.header('content-type') ?? '').split(';')[0]?.trim() ?? '';
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) {
         throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload a PNG, JPEG, WebP or GIF image.');
      }
      const bytes = Buffer.from(await context.req.arrayBuffer());
      if (bytes.length === 0 || bytes.length > 524_288) {
         throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'An avatar is at most 512 KiB.');
      }
      await requireProfile().putAvatar(scope.workspaceId, agentId, type, bytes).catch(rethrowAgent);
      return json(serializeAgent(await agents.get(agentId, scope.workspaceId)));
   });

   route.get('/:agentId/avatar', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      const scope = await agents.authorizeAgent(context.get('user').id, agentId, 'product.read').catch(rethrowAgent);
      const avatar = await requireProfile().getAvatar(scope.workspaceId, agentId).catch(rethrowAgent);
      return new Response(avatar.bytes, {
         headers: { 'content-type': avatar.contentType, 'cache-control': 'private, max-age=31536000, immutable' },
      });
   });

   route.get('/:agentId/access', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      const scope = await agents.authorizeAgent(context.get('user').id, agentId, 'product.read').catch(rethrowAgent);
      return json(await requireProfile().getAccess(scope.workspaceId, agentId).catch(rethrowAgent));
   });
```

- In the existing `PUT /:agentId/permissions`, replace `readBody(…, new Set(['permissions']))` and what follows with a Zod body. The permission-name validation (unknown-name refusal) stays exactly as it is:

```ts
      const body = await readJson(context, z.strictObject({
         permissions: z.array(z.string()).optional(),
         access: z.strictObject({
            assign: z.enum(['everyone', 'admins', 'listed']),
            mention: z.enum(['everyone', 'admins', 'listed']),
            members: z.array(z.string().uuid()).max(200),
         }).optional(),
      }));
      if (!body.permissions && !body.access) throw new ApiError(400, 'NO_FIELDS', 'No permission fields were provided.');
      // … existing unknown-permission check on body.permissions, then setPermissions when present …
      if (body.access) {
         const ok = await requireProfile().setAccess(scope.workspaceId, agentId, body.access).catch(rethrowAgent);
         if (!ok) {
            assertValid([fieldError('/access/members', 'invalid_member', 'Every listed member must belong to this workspace.')]);
         }
      }
      return json(serializeAgent(await agents.get(agentId, scope.workspaceId)));
```

- `mounts/issues.ts`: add `agentAccess?: AgentAccess | undefined;` to `IssueOptions`. After each `assertAssignee(...)` call in create (~173) and patch (~221), add:

```ts
      if (options.agentAccess && input.assignee?.type === 'agent') {
         await options.agentAccess.assertCanAssign({
            workspaceId: scope.workspaceId,
            agentId: input.assignee.id,
            userId: user.id,
         });
      }
```

(In patch the variable is `patch.assignee`.)

- [ ] **Step 6: Run and confirm everything passes**

Run: `cd /Users/secret/Code/berry-circle/server-ts && BERRY_TEST_DATABASE_URL=… node --test --experimental-strip-types src/agents/access.test.ts src/mounts/agents.profile.test.ts src/mounts/agents.lifecycle.test.ts && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server-ts/migrations/087_agent_profile.up.sql server-ts/src/agents/profile.ts server-ts/src/agents/access.ts \
  server-ts/src/agents/access.test.ts server-ts/src/agents/repository.ts server-ts/src/mounts/agents.ts \
  server-ts/src/mounts/agents.profile.test.ts server-ts/src/mounts/issues.ts
git commit -m "feat(server-ts): give agents sealed env, labels, an avatar and access scopes"
```

---
### Task 7: Squads — roster, leader routing, briefing, delegation, re-trigger

**Files:**
- Create: `server-ts/migrations/088_squads.up.sql`, `server-ts/src/squads/repository.ts`, `server-ts/src/squads/briefing.ts`, `server-ts/src/squads/retrigger.ts`, `server-ts/src/squads/retrigger.test.ts`, `server-ts/src/mounts/squads.ts`, `server-ts/src/mounts/squads.test.ts`

**Interfaces:**
- Consumes: `EnqueueTask` (Task 1), `onRunTerminal` (Task 1), `IssueRepository.get/update/create`, `IssuePatch`, `Run`.
- Produces:
  - Tables `squads`, `squad_members(squad_id, workspace_id, member_type 'agent'|'user', member_id, role)`, `issue_squads(issue_id PK, squad_id, workspace_id, assigned_by, assigned_at)` and `squad_delegations(child_issue_id PK, parent_issue_id, squad_id, workspace_id, member_agent_id, last_notified_run_id)`.
  - `interface Squad { id; name; description; leaderAgentId; members: SquadMember[]; archivedAt: string | null; createdAt; updatedAt }`, `interface SquadMember { type: 'agent' | 'user'; id: string; name: string; role: string }`
  - `class SquadRepository(sql)` with `list(workspaceId)`, `get(workspaceId, id)`, `create(workspaceId, input, userId)`, `update(workspaceId, id, patch)`, `archive(workspaceId, id)`, `setMembers(workspaceId, id, members)`, `recordAssignment(workspaceId, squadId, issueId, userId)`, `squadForIssue(issueId): Promise<Squad | null>` and `recordDelegation(input)`
  - `squadBriefing(sql: Queryable, issueId: string): Promise<string | null>`
  - `delegateToMember(deps: { sql; issues: IssueRepository }, input: { workspaceId; parentIssueId; memberAgentId; title; description }): Promise<{ issueId: string; identifier: string }>`. The member must be an agent member of the parent's squad, otherwise it throws `NotFound`.
  - `registerSquadRetrigger(deps: { sql; enqueue: EnqueueTask; report?: (e: unknown) => void }): () => void`. When a delegated child's run ends, it enqueues the leader on the parent with `source: 'squad'`, once per child run.
  - Routes on `/api/v1/squads`: `GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id` (archive, 204), `PUT /:id/members` `{ members: { type, id, role }[] }`, and `POST /:id/assign` `{ issueRef }`. `assign` sets the issue's assignee to the leader agent, records `issue_squads`, and enqueues the leader when `enqueue` is configured, returning `{ issueId, leaderAgentId, runId: string | null }`.

- [ ] **Step 1: Migration**

`server-ts/migrations/088_squads.up.sql`:

```sql
-- Berry migration 088: squads — agents and people under one leader agent.
--
-- An issue given to a squad is assigned to its leader; the leader's run
-- decides who does what and delegates by creating sub-issues for members,
-- which squad_delegations records so a member finishing wakes the leader.

CREATE TABLE IF NOT EXISTS squads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    leader_agent_id uuid NOT NULL,
    archived_at timestamptz,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT squads_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT squads_leader_fk FOREIGN KEY (workspace_id, leader_agent_id)
        REFERENCES agents (workspace_id, id) ON DELETE RESTRICT,
    CONSTRAINT squads_name_ck CHECK (char_length(name) BETWEEN 1 AND 100),
    CONSTRAINT squads_description_ck CHECK (char_length(description) <= 2000)
);
CREATE UNIQUE INDEX IF NOT EXISTS squads_workspace_name_key
    ON squads (workspace_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS squad_members (
    squad_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    member_type text NOT NULL,
    member_id uuid NOT NULL,
    role text NOT NULL DEFAULT 'member',
    PRIMARY KEY (squad_id, member_type, member_id),
    CONSTRAINT squad_members_squad_fk FOREIGN KEY (workspace_id, squad_id)
        REFERENCES squads (workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT squad_members_type_ck CHECK (member_type IN ('agent', 'user')),
    CONSTRAINT squad_members_role_ck CHECK (char_length(role) BETWEEN 1 AND 50)
);

CREATE TABLE IF NOT EXISTS issue_squads (
    issue_id uuid PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
    squad_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
    assigned_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT issue_squads_squad_fk FOREIGN KEY (workspace_id, squad_id)
        REFERENCES squads (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS squad_delegations (
    child_issue_id uuid PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
    parent_issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    squad_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    member_agent_id uuid NOT NULL,
    last_notified_run_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT squad_delegations_squad_fk FOREIGN KEY (workspace_id, squad_id)
        REFERENCES squads (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS squad_delegations_parent_idx ON squad_delegations (parent_issue_id);
```

- [ ] **Step 2: Write the failing tests**

`server-ts/src/squads/retrigger.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { EnqueueInput } from '../agents/seams.ts';
import { IssueRepository } from '../core/issues.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { dropAgentLayerWorld, seedAgentLayerWorld, type AgentLayerWorld } from '../mounts/agent-layer.fixture.ts';
import type { Run } from '../runs/ledger.ts';
import { notifyRunTerminal } from '../runs/terminal-hooks.ts';
import { squadBriefing } from './briefing.ts';
import { SquadRepository } from './repository.ts';
import { delegateToMember, registerSquadRetrigger } from './retrigger.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('squad delegation', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: AgentLayerWorld;
   let memberAgentId: string;
   let squadId: string;
   const calls: EnqueueInput[] = [];
   let off: () => void;

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
      const [member] = await sql`
         INSERT INTO agents (workspace_id, name, status) VALUES (${world.workspaceId}, 'Tester', 'available')
         RETURNING id`;
      memberAgentId = member?.id as string;
      const squads = new SquadRepository(sql);
      const squad = await squads.create(world.workspaceId, { name: 'Core', description: '', leaderAgentId: world.agentId }, world.ownerId);
      squadId = squad.id;
      await squads.setMembers(world.workspaceId, squadId, [{ type: 'agent', id: memberAgentId, role: 'tester' }]);
      await squads.recordAssignment(world.workspaceId, squadId, world.issueId, world.ownerId);
      off = registerSquadRetrigger({ sql, enqueue: async (_s, input) => { calls.push(input); return { runId: 'r' }; } });
   });
   after(async () => {
      off();
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });

   test('the leader’s briefing names the squad and every member with a role', async () => {
      const briefing = await squadBriefing(sql, world.issueId);
      assert.match(briefing ?? '', /Core/);
      assert.match(briefing ?? '', /Tester \(agent, tester\)/);
      assert.match(briefing ?? '', new RegExp(memberAgentId));
   });

   test('delegating creates a sub-issue assigned to the member, and its finishing wakes the leader once', async () => {
      const child = await delegateToMember({ sql, issues: new IssueRepository(sql) }, {
         workspaceId: world.workspaceId, parentIssueId: world.issueId, memberAgentId,
         title: 'Write the tests', description: 'Cover the parser.',
      });
      const [row] = await sql`SELECT assignee_type, assignee_id FROM issues WHERE id = ${child.issueId}`;
      assert.equal(row?.assignee_id, memberAgentId);

      const run = { id: '11111111-1111-4111-8111-111111111111', issueId: child.issueId, status: 'succeeded', summary: 'done' } as unknown as Run;
      await notifyRunTerminal(run);
      await notifyRunTerminal(run);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.agentId, world.agentId);
      assert.equal(calls[0]?.issueId, world.issueId);
      assert.equal(calls[0]?.source, 'squad');
   });

   test('delegating to someone outside the squad is refused', async () => {
      await assert.rejects(delegateToMember({ sql, issues: new IssueRepository(sql) }, {
         workspaceId: world.workspaceId, parentIssueId: world.issueId, memberAgentId: world.otherAgentId,
         title: 'x', description: '',
      }));
   });

   test('a refused wake-up (busy parent) releases the claim so it can be retried', async () => {
      off();
      let fail = true;
      const seen: EnqueueInput[] = [];
      off = registerSquadRetrigger({
         sql,
         enqueue: async (_s, input) => {
            if (fail) throw new Error('active run');
            seen.push(input);
            return { runId: 'r2' };
         },
      });
      const child = await delegateToMember({ sql, issues: new IssueRepository(sql) }, {
         workspaceId: world.workspaceId, parentIssueId: world.issueId, memberAgentId, title: 'Second', description: '',
      });
      const run = { id: '44444444-4444-4444-8444-444444444444', issueId: child.issueId, status: 'succeeded', summary: null } as unknown as Run;
      await notifyRunTerminal(run); // the hook throws; notifyRunTerminal reports it
      const [row] = await sql`SELECT last_notified_run_id FROM squad_delegations WHERE child_issue_id = ${child.issueId}`;
      assert.equal(row?.last_notified_run_id, null);
      fail = false;
      await notifyRunTerminal(run);
      assert.equal(seen.length, 1);
   });
});
```

`server-ts/src/mounts/squads.test.ts` follows the `skills.test.ts` pattern. Register `squadMounts({ sessions, sql, squads: new SquadRepository(sql), issues: new IssueRepository(sql), enqueue: fake })` and assert:
- `POST /api/v1/squads { name: 'Core', description: '', leaderAgentId: world.agentId }` returns 201.
- `PUT /:id/members` with the agent and `world.memberId` (type user) returns 200, and `members.length === 2`.
- `PUT /:id/members` with `world.otherAgentId` returns 422, `code: 'VALIDATION_FAILED'` (the validation envelope from `assertValid`).
- `POST /:id/assign { issueRef: world.issueId }` returns 200 with `leaderAgentId === world.agentId`, and the issue's `assignee_id` is now the leader. The fake enqueue saw `source: 'squad'`.
- With the leader's `assign_scope = 'admins'` (set directly in SQL), a member's `POST /:id/assign` returns 403 `AGENT_ACCESS_DENIED`. Reset it afterwards.
- An owner of W who is also a member of W2 (insert a membership for `world.ownerId` in `world.otherWorkspaceId` plus one W2 issue) cannot assign W's squad to the W2 issue: 404 `Issue`, and the W2 issue's assignee is unchanged.
- An outsider's `GET /api/v1/squads/:id` returns 404.

- [ ] **Step 3: Run them and confirm they fail**

Run: `cd /Users/secret/Code/berry-circle/server-ts && BERRY_TEST_DATABASE_URL=… node --test --experimental-strip-types src/squads/retrigger.test.ts src/mounts/squads.test.ts`
Expected: FAIL, because the modules are not found.

- [ ] **Step 4: Implement the repository, briefing and retrigger**

`server-ts/src/squads/repository.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { toRFC3339, type Sql } from '../db/pool.ts';
import { Conflict, NotFound } from '../identity/errors.ts';

export interface SquadMember {
   type: 'agent' | 'user';
   id: string;
   name: string;
   role: string;
}

export interface Squad {
   id: string;
   name: string;
   description: string;
   leaderAgentId: string;
   members: SquadMember[];
   archivedAt: string | null;
   createdAt: string;
   updatedAt: string;
}

const COLUMNS = `s.id, s.name, s.description, s.leader_agent_id, s.archived_at, s.created_at, s.updated_at,
   COALESCE((SELECT json_agg(json_build_object('type', m.member_type, 'id', m.member_id,
               'name', COALESCE(a.name, u.name, ''), 'role', m.role) ORDER BY m.member_type, m.member_id)
               FROM squad_members m
               LEFT JOIN agents a ON m.member_type = 'agent' AND a.id = m.member_id
               LEFT JOIN users u ON m.member_type = 'user' AND u.id = m.member_id
              WHERE m.squad_id = s.id), '[]'::json) AS members`;

export class SquadRepository {
   readonly #sql: Sql;
   constructor(sql: Sql) {
      this.#sql = sql;
   }

   async list(workspaceId: string): Promise<Squad[]> {
      const rows = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)} FROM squads s
          WHERE s.workspace_id = ${workspaceId} AND s.archived_at IS NULL ORDER BY lower(s.name)`;
      return rows.map(toSquad);
   }

   async get(workspaceId: string, id: string): Promise<Squad> {
      const [row] = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)} FROM squads s WHERE s.id = ${id} AND s.workspace_id = ${workspaceId}`;
      if (!row) throw new NotFound();
      return toSquad(row);
   }

   async create(workspaceId: string, input: { name: string; description: string; leaderAgentId: string }, userId: string): Promise<Squad> {
      const id = randomUUID();
      await this.#sql`
         INSERT INTO squads (id, workspace_id, name, description, leader_agent_id, created_by)
         VALUES (${id}, ${workspaceId}, ${input.name}, ${input.description}, ${input.leaderAgentId}, ${userId})`.catch(classify);
      return this.get(workspaceId, id);
   }

   async update(workspaceId: string, id: string, patch: { name?: string; description?: string; leaderAgentId?: string }): Promise<Squad> {
      const updated = await this.#sql`
         UPDATE squads SET name = COALESCE(${patch.name ?? null}, name),
                description = COALESCE(${patch.description ?? null}, description),
                leader_agent_id = COALESCE(${patch.leaderAgentId ?? null}::uuid, leader_agent_id),
                updated_at = now()
          WHERE id = ${id} AND workspace_id = ${workspaceId} AND archived_at IS NULL`.catch(classify);
      if (updated.count !== 1) throw new NotFound();
      return this.get(workspaceId, id);
   }

   async archive(workspaceId: string, id: string): Promise<void> {
      const updated = await this.#sql`
         UPDATE squads SET archived_at = now(), updated_at = now()
          WHERE id = ${id} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
      if (updated.count !== 1) throw new NotFound();
   }

   /** Replaces the roster. Returns false when a member is not in this workspace. */
   async setMembers(workspaceId: string, id: string, members: { type: 'agent' | 'user'; id: string; role: string }[]): Promise<boolean> {
      return (await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         for (const member of members) {
            const [ok] = member.type === 'agent'
               ? await tx`SELECT 1 FROM agents WHERE id = ${member.id} AND workspace_id = ${workspaceId} AND archived_at IS NULL`
               : await tx`SELECT 1 FROM workspace_memberships WHERE user_id = ${member.id} AND workspace_id = ${workspaceId}`;
            if (!ok) return false;
         }
         const [squad] = await tx`SELECT 1 FROM squads WHERE id = ${id} AND workspace_id = ${workspaceId}`;
         if (!squad) throw new NotFound();
         await tx`DELETE FROM squad_members WHERE squad_id = ${id}`;
         for (const member of members) {
            await tx`
               INSERT INTO squad_members (squad_id, workspace_id, member_type, member_id, role)
               VALUES (${id}, ${workspaceId}, ${member.type}, ${member.id}, ${member.role})
               ON CONFLICT DO NOTHING`;
         }
         return true;
      })) as boolean;
   }

   async recordAssignment(workspaceId: string, squadId: string, issueId: string, userId: string): Promise<void> {
      await this.#sql`
         INSERT INTO issue_squads (issue_id, squad_id, workspace_id, assigned_by)
         VALUES (${issueId}, ${squadId}, ${workspaceId}, ${userId})
         ON CONFLICT (issue_id) DO UPDATE SET squad_id = EXCLUDED.squad_id, assigned_by = EXCLUDED.assigned_by,
                                             assigned_at = now()`;
   }

   async squadForIssue(issueId: string): Promise<Squad | null> {
      const [row] = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)} FROM squads s
           JOIN issue_squads i ON i.squad_id = s.id WHERE i.issue_id = ${issueId} AND s.archived_at IS NULL`;
      return row ? toSquad(row) : null;
   }
}

function toSquad(row: Record<string, unknown>): Squad {
   return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string,
      leaderAgentId: row.leader_agent_id as string,
      members: (row.members as SquadMember[] | null) ?? [],
      archivedAt: toRFC3339(row.archived_at as string | null),
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}

function classify(error: unknown): never {
   const code = (error as { code?: string }).code;
   if (code === '23505') throw new Conflict();
   if (code === '23503') throw new NotFound();
   throw error;
}
```

`server-ts/src/squads/briefing.ts`:

```ts
import type { Queryable } from '../db/pool.ts';

/**
 * What a squad leader is told on top of its task.
 *
 * Only on an issue the squad owns, and only for the leader: a member working
 * a delegated sub-issue is doing one task, not running the squad.
 */
export async function squadBriefing(sql: Queryable, issueId: string): Promise<string | null> {
   const [squad] = await sql`
      SELECT s.id, s.name, s.description FROM issue_squads i
        JOIN squads s ON s.id = i.squad_id AND s.archived_at IS NULL
       WHERE i.issue_id = ${issueId}`;
   if (!squad) return null;
   const members = await sql`
      SELECT m.member_type, m.member_id, m.role, COALESCE(a.name, u.name, '') AS name
        FROM squad_members m
        LEFT JOIN agents a ON m.member_type = 'agent' AND a.id = m.member_id
        LEFT JOIN users u ON m.member_type = 'user' AND u.id = m.member_id
       WHERE m.squad_id = ${squad.id as string}
       ORDER BY m.member_type, name`;
   const roster = members
      .map((m) => `- ${m.name as string} (${m.member_type as string}, ${m.role as string}) id=${m.member_id as string}`)
      .join('\n');
   return [
      `You lead the squad "${squad.name as string}".${squad.description ? ` ${squad.description as string}` : ''}`,
      'Members:',
      roster || '- (no members yet)',
      'Decide what each agent member should do. Delegate a piece of work by calling the ' +
         'delegate_to_member tool with the member id, a title and a description; it creates a ' +
         'sub-issue assigned to that member. You will be woken again when a member finishes. ' +
         'People are listed so you can mention them; do not delegate to them. When everything ' +
         'is done, report the combined result.',
   ].join('\n');
}
```

`server-ts/src/squads/retrigger.ts`:

```ts
import type { EnqueueTask } from '../agents/seams.ts';
import type { IssueRepository } from '../core/issues.ts';
import type { Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import type { Run } from '../runs/ledger.ts';
import { onRunTerminal } from '../runs/terminal-hooks.ts';

/** Berry's system actor (migration 009). A delegated sub-issue is created in its name. */
const SYSTEM_USER = '00000000-0000-4000-8000-000000000001';

export async function delegateToMember(
   deps: { sql: Sql; issues: IssueRepository },
   input: { workspaceId: string; parentIssueId: string; memberAgentId: string; title: string; description: string }
): Promise<{ issueId: string; identifier: string }> {
   const [parent] = await deps.sql`
      SELECT i.board_id, i.priority, sq.squad_id
        FROM issues i
        JOIN boards b ON b.id = i.board_id AND b.workspace_id = ${input.workspaceId}
        JOIN issue_squads sq ON sq.issue_id = i.id
        JOIN squad_members m ON m.squad_id = sq.squad_id AND m.member_type = 'agent'
                             AND m.member_id = ${input.memberAgentId}
       WHERE i.id = ${input.parentIssueId}`;
   if (!parent) throw new NotFound();
   const created = await deps.issues.create({
      boardId: parent.board_id as string,
      title: input.title.slice(0, 500),
      description: input.description || null,
      status: 'todo',
      priority: parent.priority as string,
      sortOrder: 0,
      dueDate: null,
      assignee: { type: 'agent', id: input.memberAgentId },
      project: null,
      createdBy: SYSTEM_USER,
   });
   await deps.sql`
      INSERT INTO squad_delegations (child_issue_id, parent_issue_id, squad_id, workspace_id, member_agent_id)
      VALUES (${created.issue.id}, ${input.parentIssueId}, ${parent.squad_id as string}, ${input.workspaceId},
              ${input.memberAgentId})`;
   return { issueId: created.issue.id, identifier: created.issue.identifier };
}

/**
 * A member finishing a delegated sub-issue wakes the leader on the parent.
 *
 * Idempotent per child run: `last_notified_run_id` is claimed with a
 * conditional update, so a hook firing twice (an idempotent cancel) enqueues
 * once.
 */
export function registerSquadRetrigger(deps: { sql: Sql; enqueue: EnqueueTask; report?: (error: unknown) => void }): () => void {
   return onRunTerminal(async (run: Run) => {
      if (!run.issueId) return;
      const [claimed] = await deps.sql`
         UPDATE squad_delegations d SET last_notified_run_id = ${run.id}
           FROM squads s
          WHERE d.child_issue_id = ${run.issueId} AND s.id = d.squad_id
            AND d.last_notified_run_id IS DISTINCT FROM ${run.id}
         RETURNING d.parent_issue_id, d.workspace_id, s.leader_agent_id,
                   (SELECT name FROM agents WHERE id = d.member_agent_id) AS member_name`;
      if (!claimed) return;
      try {
         await deps.enqueue(deps.sql, {
            workspaceId: claimed.workspace_id as string,
            agentId: claimed.leader_agent_id as string,
            issueId: claimed.parent_issue_id as string,
            kind: 'agent',
            source: 'squad',
            prompt:
               `${claimed.member_name as string} finished a delegated sub-issue with status ${run.status}.` +
               (run.summary ? `\n\n<member_result>\n${run.summary}\n</member_result>` : '') +
               '\n\nDecide whether more delegation is needed, or report the combined result.',
         });
      } catch (error) {
         // A refuses a second run on a busy parent (ActiveRunExists). Release the
         // claim so the wake-up is not recorded as delivered when it was not;
         // a later terminal notification for this child run can then retry.
         await deps.sql`
            UPDATE squad_delegations SET last_notified_run_id = NULL
             WHERE child_issue_id = ${run.issueId} AND last_notified_run_id = ${run.id}`;
         throw error;
      }
   });
}
```

(`created.issue.identifier`: `Issue` exposes the human identifier. If the field is named differently in `core/issues.ts`, use that name. Check with `grep -n "identifier" src/core/issues.ts | head -3`.)

- [ ] **Step 5: Implement the mount**

`server-ts/src/mounts/squads.ts`:

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import type { AgentAccess } from '../agents/access.ts';
import type { EnqueueTask } from '../agents/seams.ts';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import type { IssueRepository } from '../core/issues.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { assertValid, fieldError } from '../http/body.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { Conflict, NotFound } from '../identity/errors.ts';
import type { SquadRepository } from '../squads/repository.ts';
import { currentWorkspace, pathId, resolveScoped } from './shared.ts';
import { readJson } from './zod-body.ts';

export interface SquadMountOptions {
   sessions: SessionService;
   sql: Sql;
   squads: SquadRepository;
   issues: IssueRepository;
   enqueue?: EnqueueTask | null;
   agentAccess?: AgentAccess;
}
```

The schemas:

```ts
const squadSchema = z.strictObject({
   name: z.string().trim().min(1).max(100),
   description: z.string().max(2000).default(''),
   leaderAgentId: z.string().uuid(),
});
const membersSchema = z.strictObject({
   members: z.array(z.strictObject({
      type: z.enum(['agent', 'user']),
      id: z.string().uuid(),
      role: z.string().trim().min(1).max(50).default('member'),
   })).max(50),
});
const assignSchema = z.strictObject({ issueRef: z.string().min(1).max(100) });
```

The routes (the `assign` handler follows):

```ts
export function squadMounts(options: SquadMountOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));
   const { squads, sql } = options;
   const scope = (user: { id: string; currentWorkspaceId: string | null }, write: boolean) =>
      resolveScoped(sql, user.id, currentWorkspace(user.currentWorkspaceId), write ? 'product.write' : 'product.read');

   route.get('/', async (context) => {
      const scoped = await scope(context.get('user'), false);
      return json({ nodes: await squads.list(scoped.ctx.workspaceId) });
   });

   route.post('/', async (context) => {
      const scoped = await scope(context.get('user'), true);
      const input = await readJson(context, squadSchema);
      return json(await squads.create(scoped.ctx.workspaceId, input, context.get('user').id).catch(rethrowLeader), 201);
   });

   route.get('/:id', async (context) => {
      const scoped = await scope(context.get('user'), false);
      return json(await squads.get(scoped.ctx.workspaceId, pathId(context.req.param('id'), 'Squad')).catch(rethrow));
   });

   route.patch('/:id', async (context) => {
      const scoped = await scope(context.get('user'), true);
      const patch = await readJson(context, squadSchema.partial());
      return json(
         await squads.update(scoped.ctx.workspaceId, pathId(context.req.param('id'), 'Squad'), patch).catch(rethrowLeader)
      );
   });

   route.delete('/:id', async (context) => {
      const scoped = await scope(context.get('user'), true);
      await squads.archive(scoped.ctx.workspaceId, pathId(context.req.param('id'), 'Squad')).catch(rethrow);
      return new Response(null, { status: 204 });
   });

   route.put('/:id/members', async (context) => {
      const scoped = await scope(context.get('user'), true);
      const id = pathId(context.req.param('id'), 'Squad');
      const { members } = await readJson(context, membersSchema);
      const ok = await squads.setMembers(scoped.ctx.workspaceId, id, members).catch(rethrow);
      if (!ok) assertValid([fieldError('/members', 'invalid_member', 'Every member must belong to this workspace.')]);
      return json(await squads.get(scoped.ctx.workspaceId, id).catch(rethrow));
   });

   // … the assign handler below …

   return [{ prefix: '/api/v1/squads', handler: route }];
}

function rethrow(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('Squad');
   if (error instanceof Conflict) throw new ApiError(409, 'SQUAD_NAME_TAKEN', 'A squad with that name already exists.');
   throw error;
}

/** On create/update a foreign key miss means the leader is not an agent of this workspace. */
function rethrowLeader(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('Agent');
   return rethrow(error);
}
```

The `assign` handler:

```ts
   route.post('/:id/assign', async (context) => {
      const user = context.get('user');
      const scoped = await scope(user, true);
      const squad = await squads.get(scoped.ctx.workspaceId, pathId(context.req.param('id'), 'Squad')).catch(rethrow);
      if (squad.archivedAt) throw ApiError.notFound('Squad');
      const { issueRef } = await readJson(context, assignSchema);
      const issue = await options.issues.get(issueRef).catch(() => {
         throw ApiError.notFound('Issue');
      });
      const issueScope = await options.issues.authorize(user.id, issue.id, 'product.write').catch(() => {
         throw ApiError.notFound('Issue');
      });
      // The caller may belong to two workspaces: the issue must be in the squad's,
      // or a W squad leader would be assigned to a W2 issue.
      if (issueScope.workspaceId !== scoped.ctx.workspaceId) throw ApiError.notFound('Issue');
      // Assigning to a squad is assigning to its leader, so the leader's assign scope applies.
      if (options.agentAccess) {
         await options.agentAccess.assertCanAssign({
            workspaceId: scoped.ctx.workspaceId,
            agentId: squad.leaderAgentId,
            userId: user.id,
         });
      }
      await options.issues.update({
         issueId: issue.id,
         patch: {
            descriptionSet: false,
            dueDateSet: false,
            projectSet: false,
            assigneeSet: true,
            assignee: { type: 'agent', id: squad.leaderAgentId },
         },
         actorId: user.id,
      });
      await squads.recordAssignment(scoped.ctx.workspaceId, squad.id, issue.id, user.id);
      const queued = options.enqueue
         ? await options.enqueue(sql, {
              workspaceId: scoped.ctx.workspaceId,
              agentId: squad.leaderAgentId,
              issueId: issue.id,
              kind: 'agent',
              source: 'squad',
           })
         : null;
      return json({ issueId: issue.id, leaderAgentId: squad.leaderAgentId, runId: queued?.runId ?? null });
   });
```

Task 12 passes `agentAccess: agentAccessGuard(sql)` to `squadMounts`, and the mount test does the same.

The update above writes the issue's outbox row inside `issues.update`, so SSE picks it up on its next poll.

- [ ] **Step 6: Run and confirm everything passes**

Run: `cd /Users/secret/Code/berry-circle/server-ts && BERRY_TEST_DATABASE_URL=… node --test --experimental-strip-types src/squads/retrigger.test.ts src/mounts/squads.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server-ts/migrations/088_squads.up.sql server-ts/src/squads server-ts/src/mounts/squads.ts server-ts/src/mounts/squads.test.ts
git commit -m "feat(server-ts): add squads whose leader delegates and is woken by its members"
```

---
### Task 8: Mentions and replies trigger runs, with a preview before sending

**Files:**
- Create: `server-ts/migrations/092_comment_triggers.up.sql`, `server-ts/src/agents/mentions.ts`, `server-ts/src/agents/mentions.test.ts`, `server-ts/src/agents/triggers.ts`, `server-ts/src/agents/triggers.test.ts`
- Modify: `server-ts/src/mounts/comments.ts` (the `triggers` option, a preview route, and a fire call after create in `issueCommentRoutes`)

**Interfaces:**
- Consumes: `canUseAgent` (Task 6), `issue_squads`/`squads` (Task 7), `EnqueueTask` (Task 1).
- Produces:
  - Mention token (written by the frontend picker, Task 19): `@[Display Name](agent:<uuid>)` or `@[Display Name](squad:<uuid>)`.
  - `parseMentions(body: string): { agents: string[]; squads: string[] }` (deduplicated, lower-cased ids)
  - `type TriggerReason = 'mention' | 'squad_leader' | 'reply_to_assignee'`
  - `interface TriggerPlan { targets: { agentId: string; agentName: string; reason: TriggerReason }[]; refused: { agentId: string; agentName: string; reason: 'no_access' }[] }`
  - `planCommentTriggers(sql, input: { workspaceId; issueId; authorId; body }): Promise<TriggerPlan>`
  - `fireCommentTriggers(sql, enqueue, input: { workspaceId; issueId; commentId; body; plan }): Promise<string[]>` returns the run ids and records `comment_run_triggers`, so a retried call cannot double-enqueue.
  - `interface CommentTriggers { preview(input: { workspaceId; issueId; authorId; body }): Promise<TriggerPlan>; fire(input: { workspaceId; issueId; authorId; commentId; body }): Promise<void> }`
  - `commentTriggers(deps: { sql; enqueue: EnqueueTask; report: (e: unknown) => void }): CommentTriggers`
  - Route: `POST /api/v1/issues/:issueRef/comments/trigger-preview` `{ body }` → `TriggerPlan` (`comments.write`).

Rules:
1. Only comments authored by a person trigger. Agent comments never do, so an agent's result comment cannot loop.
2. A mentioned live agent in the same workspace becomes a target for `mention`, unless its mention scope refuses the author, in which case it goes to `refused`.
3. A mentioned squad targets its leader, for `squad_leader`, subject to the leader's mention scope.
4. A comment with no mentions, on an issue assigned to an agent, targets that assignee for `reply_to_assignee`. On a squad issue the assignee is the leader already.
5. Each agent is targeted at most once per comment.

- [ ] **Step 1: Migration**

`server-ts/migrations/092_comment_triggers.up.sql`:

```sql
-- Berry migration 092: which runs a comment started.
--
-- The primary key is the idempotency guard: a retried request, or a hook that
-- runs twice, finds the row and does not enqueue a second run for the same
-- comment and agent.

CREATE TABLE IF NOT EXISTS comment_run_triggers (
    comment_id uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    agent_id uuid NOT NULL,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id uuid,
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (comment_id, agent_id),
    CONSTRAINT comment_run_triggers_reason_ck CHECK (reason IN ('mention', 'squad_leader', 'reply_to_assignee'))
);
```

- [ ] **Step 2: Write the failing tests**

`server-ts/src/agents/mentions.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMentions } from './mentions.ts';

const A = '0a1b2c3d-0000-4000-8000-00000000000a';
const S = '0a1b2c3d-0000-4000-8000-00000000000b';

test('agent and squad tokens are found, once each', () => {
   const parsed = parseMentions(`@[Coder](agent:${A}) please, and @[Core](squad:${S}); again @[Coder](agent:${A.toUpperCase()})`);
   assert.deepEqual(parsed, { agents: [A], squads: [S] });
});

test('a bare @name, an email and a malformed token are not mentions', () => {
   assert.deepEqual(parseMentions('@Coder mail me@x.test @[Coder](agent:nope)'), { agents: [], squads: [] });
});
```

`server-ts/src/agents/triggers.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { dropAgentLayerWorld, seedAgentLayerWorld, type AgentLayerWorld } from '../mounts/agent-layer.fixture.ts';
import type { EnqueueInput } from './seams.ts';
import { fireCommentTriggers, planCommentTriggers } from './triggers.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('comment triggers', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: AgentLayerWorld;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
   });
   after(async () => {
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });
   const plan = (body: string, authorId = world.memberId) =>
      planCommentTriggers(sql, { workspaceId: world.workspaceId, issueId: world.issueId, authorId, body });

   test('a mention of an agent in this workspace targets it', async () => {
      const result = await plan(`@[Coder](agent:${world.agentId}) look`);
      assert.deepEqual(result.targets.map((t) => [t.agentId, t.reason]), [[world.agentId, 'mention']]);
   });

   test('a mention of another workspace’s agent does nothing', async () => {
      const result = await plan(`@[X](agent:${world.otherAgentId}) look`);
      assert.deepEqual(result, { targets: [], refused: [] });
   });

   test('a mention refused by the agent’s scope is reported, not fired', async () => {
      await sql`UPDATE agents SET mention_scope = 'admins' WHERE id = ${world.agentId}`;
      const result = await plan(`@[Coder](agent:${world.agentId})`);
      assert.deepEqual(result.targets, []);
      assert.equal(result.refused[0]?.reason, 'no_access');
      await sql`UPDATE agents SET mention_scope = 'everyone' WHERE id = ${world.agentId}`;
   });

   test('a plain reply on an agent-assigned issue goes to the assignee', async () => {
      await sql`UPDATE issues SET assignee_type = 'agent', assignee_id = ${world.agentId} WHERE id = ${world.issueId}`;
      const result = await plan('Thanks, now add tests.');
      assert.deepEqual(result.targets.map((t) => t.reason), ['reply_to_assignee']);
   });

   test('firing twice for one comment enqueues once', async () => {
      const [comment] = await sql`
         INSERT INTO comments (issue_id, author_type, author_id, body)
         VALUES (${world.issueId}, 'user', ${world.memberId}, 'again') RETURNING id`;
      const calls: EnqueueInput[] = [];
      const enqueue = async (_s: Sql, input: EnqueueInput) => {
         calls.push(input);
         return { runId: '22222222-2222-4222-8222-222222222222' };
      };
      const p = await plan('again');
      const input = { workspaceId: world.workspaceId, issueId: world.issueId, commentId: comment?.id as string, body: 'again', plan: p };
      await fireCommentTriggers(sql, enqueue, input);
      await fireCommentTriggers(sql, enqueue, input);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.source, 'mention');
   });

   test('a refused enqueue releases the claim so the comment can fire later', async () => {
      const [comment] = await sql`
         INSERT INTO comments (issue_id, author_type, author_id, body)
         VALUES (${world.issueId}, 'user', ${world.memberId}, 'busy') RETURNING id`;
      const p = await plan('busy');
      const input = { workspaceId: world.workspaceId, issueId: world.issueId, commentId: comment?.id as string, body: 'busy', plan: p };
      await assert.rejects(fireCommentTriggers(sql, async () => { throw new Error('active run'); }, input));
      const [row] = await sql`SELECT count(*)::int AS n FROM comment_run_triggers WHERE comment_id = ${comment?.id as string}`;
      assert.equal(row?.n, 0);
   });
});
```

(`reply_to_assignee` is enqueued with `source: 'mention'`, because A's `source` vocabulary has no reply value. The reason is kept in `comment_run_triggers.reason`.)

- [ ] **Step 3: Run them and confirm they fail**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/agents/mentions.test.ts && BERRY_TEST_DATABASE_URL=… node --test --experimental-strip-types src/agents/triggers.test.ts`
Expected: FAIL, because the modules are not found.

- [ ] **Step 4: Implement**

`server-ts/src/agents/mentions.ts`:

```ts
/**
 * Mentions are explicit tokens the composer writes, never guessed from text.
 *
 * A bare "@Coder" could be a name, a handle or an email fragment; guessing
 * would start runs nobody asked for. The picker inserts
 * `@[Name](agent:<uuid>)`, which is unambiguous and survives a rename.
 */
const TOKEN = /@\[[^\]\n]{1,100}\]\((agent|squad):([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/g;

export function parseMentions(body: string): { agents: string[]; squads: string[] } {
   const agents = new Set<string>();
   const squads = new Set<string>();
   for (const match of body.matchAll(TOKEN)) {
      const id = (match[2] ?? '').toLowerCase();
      if (match[1] === 'agent') agents.add(id);
      else squads.add(id);
   }
   return { agents: [...agents], squads: [...squads] };
}
```

`server-ts/src/agents/triggers.ts`:

```ts
import type { Sql } from '../db/pool.ts';
import { canUseAgent } from './access.ts';
import { parseMentions } from './mentions.ts';
import type { EnqueueTask } from './seams.ts';

export type TriggerReason = 'mention' | 'squad_leader' | 'reply_to_assignee';

export interface TriggerPlan {
   targets: { agentId: string; agentName: string; reason: TriggerReason }[];
   refused: { agentId: string; agentName: string; reason: 'no_access' }[];
}

export async function planCommentTriggers(
   sql: Sql,
   input: { workspaceId: string; issueId: string; authorId: string; body: string }
): Promise<TriggerPlan> {
   const mentions = parseMentions(input.body);
   const candidates: { agentId: string; reason: TriggerReason }[] = [];
   for (const agentId of mentions.agents) candidates.push({ agentId, reason: 'mention' });
   if (mentions.squads.length > 0) {
      const leaders = await sql`
         SELECT leader_agent_id FROM squads
          WHERE id IN ${sql(mentions.squads)} AND workspace_id = ${input.workspaceId} AND archived_at IS NULL`;
      for (const row of leaders) candidates.push({ agentId: row.leader_agent_id as string, reason: 'squad_leader' });
   }
   if (candidates.length === 0) {
      const [issue] = await sql`
         SELECT i.assignee_id FROM issues i JOIN boards b ON b.id = i.board_id
          WHERE i.id = ${input.issueId} AND b.workspace_id = ${input.workspaceId} AND i.assignee_type = 'agent'`;
      if (issue?.assignee_id) candidates.push({ agentId: issue.assignee_id as string, reason: 'reply_to_assignee' });
   }

   const plan: TriggerPlan = { targets: [], refused: [] };
   const seen = new Set<string>();
   for (const candidate of candidates) {
      if (seen.has(candidate.agentId)) continue;
      seen.add(candidate.agentId);
      const [agent] = await sql`
         SELECT name FROM agents
          WHERE id = ${candidate.agentId} AND workspace_id = ${input.workspaceId} AND archived_at IS NULL`;
      if (!agent) continue; // not in this workspace: say nothing about it
      const allowed = await canUseAgent(sql, {
         workspaceId: input.workspaceId, agentId: candidate.agentId, userId: input.authorId, action: 'mention',
      });
      if (allowed) plan.targets.push({ agentId: candidate.agentId, agentName: agent.name as string, reason: candidate.reason });
      else plan.refused.push({ agentId: candidate.agentId, agentName: agent.name as string, reason: 'no_access' });
   }
   return plan;
}

export async function fireCommentTriggers(
   sql: Sql,
   enqueue: EnqueueTask,
   input: { workspaceId: string; issueId: string; commentId: string; body: string; plan: TriggerPlan }
): Promise<string[]> {
   const runs: string[] = [];
   for (const target of input.plan.targets) {
      const [claimed] = await sql`
         INSERT INTO comment_run_triggers (comment_id, agent_id, workspace_id, reason)
         VALUES (${input.commentId}, ${target.agentId}, ${input.workspaceId}, ${target.reason})
         ON CONFLICT DO NOTHING RETURNING agent_id`;
      if (!claimed) continue;
      // A refuses a second task on an issue that already has one (ActiveRunExists).
      // Release the claim on any failure, so the claim never records a run that
      // was not queued and a later retry of this comment can still fire.
      const release = async (error: unknown): Promise<never> => {
         await sql`DELETE FROM comment_run_triggers WHERE comment_id = ${input.commentId} AND agent_id = ${target.agentId}`;
         throw error;
      };
      const { runId } = await enqueue(sql, {
         workspaceId: input.workspaceId,
         agentId: target.agentId,
         issueId: input.issueId,
         kind: 'agent',
         source: target.reason === 'squad_leader' ? 'squad' : 'mention',
         prompt:
            (target.reason === 'reply_to_assignee'
               ? 'A person replied on the issue you are assigned:'
               : 'You were mentioned in a comment on this issue:') +
            `\n\n<comment>\n${input.body.replaceAll('</comment>', '</ comment>')}\n</comment>`,
      }).catch(release);
      await sql`
         UPDATE comment_run_triggers SET run_id = ${runId}
          WHERE comment_id = ${input.commentId} AND agent_id = ${target.agentId}`;
      runs.push(runId);
   }
   return runs;
}

export interface CommentTriggers {
   preview(input: { workspaceId: string; issueId: string; authorId: string; body: string }): Promise<TriggerPlan>;
   fire(input: { workspaceId: string; issueId: string; authorId: string; commentId: string; body: string }): Promise<void>;
}

export function commentTriggers(deps: { sql: Sql; enqueue: EnqueueTask; report: (error: unknown) => void }): CommentTriggers {
   return {
      preview: (input) => planCommentTriggers(deps.sql, input),
      async fire(input) {
         try {
            const plan = await planCommentTriggers(deps.sql, input);
            await fireCommentTriggers(deps.sql, deps.enqueue, { ...input, plan });
         } catch (error) {
            // The comment is already saved; a failed trigger is logged, not a failed comment.
            deps.report(error);
         }
      },
   };
}
```

In `server-ts/src/mounts/comments.ts`:
- `CommentOptions` gains `triggers?: CommentTriggers | undefined;` (a type import from `../agents/triggers.ts`).
- In `issueCommentRoutes`, after `await publish(options, [result.event]);` in the POST handler, add:

```ts
      if (options.triggers) {
         const scope = await issues.authorize(context.get('user').id, issue.id, 'product.read');
         await options.triggers.fire({
            workspaceId: scope.workspaceId,
            issueId: issue.id,
            authorId: context.get('user').id,
            commentId: result.comment.id,
            body: text,
         });
      }
```

- Register before `nested.post('/:issueRef/comments', …)`:

```ts
   nested.post('/:issueRef/comments/trigger-preview', async (context) => {
      const issue = await issues.get(context.req.param('issueRef') ?? '').catch(rethrowIssue);
      const scope = await issues.authorize(context.get('user').id, issue.id, 'comments.write').catch(rethrowIssue);
      const body = await readBody(context.req.raw, ['body']);
      const text = requireBody(body.body);
      if (!options.triggers) return json({ targets: [], refused: [] });
      return json(await options.triggers.preview({
         workspaceId: scope.workspaceId, issueId: issue.id, authorId: context.get('user').id, body: text,
      }));
   });
```

(`issues.authorize` returns a scope carrying `workspaceId`. If its return type is named differently, read the create handler's use of `issues.authorize` for the field.)

- [ ] **Step 5: Run and confirm everything passes**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/agents/mentions.test.ts && BERRY_TEST_DATABASE_URL=… node --test --experimental-strip-types src/agents/triggers.test.ts src/core/comments.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server-ts/migrations/092_comment_triggers.up.sql server-ts/src/agents/mentions.ts server-ts/src/agents/mentions.test.ts \
  server-ts/src/agents/triggers.ts server-ts/src/agents/triggers.test.ts server-ts/src/mounts/comments.ts
git commit -m "feat(server-ts): start agent runs from mentions and replies, with a preview"
```

---
### Task 9: What an agent carries — envelope extensions, skill files, MCP clients, Gateway routing

**Files:**
- Create: `server-ts/src/agents/extensions.ts`, `server-ts/src/agents/extensions.test.ts`, `server-ts/src/agents/runtime/skill-files.ts`, `server-ts/src/agents/runtime/skill-files.test.ts`, `server-ts/src/agents/runtime/mcp-clients.ts`, `server-ts/src/agents/runtime/mcp-clients.test.ts`

**Interfaces:**
- Consumes: `SkillRepository.enabledForAgent` (Task 2), `McpServerRepository.forAgent` (Task 4), `AgentProfileRepository.envFor` (Task 6), `squadBriefing` (Task 7), `McpClient` and `McpServerConfig` from `@strands-agents/sdk`, and optionally `AgentCoreIdentity.gatewayHeaders()` (`agentcore/identity.ts`).
- Produces:
  - `interface EnvelopeSkill { name: string; files: { path: string; content: string }[] }`. This is exactly A's `skillRefSchema`, with the catalogue's description and content rendered into a `SKILL.md` entry of `files` by `skillManifest(skill)`.
  - `interface EnvelopeMcpServer { name: string; url: string; transport: 'http' | 'sse'; headers: Record<string, string> }`. This is exactly A's `mcpServerRefSchema`: the catalogue's `streamable_http` travels as `http`.
  - `skillManifest(skill: { name; description; content }): string` returns `---\nname: …\ndescription: "…"\n---\n<content>`.
  - `interface AgentExtensions { skills: EnvelopeSkill[]; mcpServers: EnvelopeMcpServer[]; env: Record<string, string>; squadBriefing: string | null; skipped: string[] }`
  - `interface GatewayRoute { url: string; headers: () => Promise<Record<string, string>> }`
  - `loadAgentExtensions(deps: { sql; skills; mcp; profile; gateway: GatewayRoute | null }, input: { workspaceId; agentId; issueId: string | null }): Promise<AgentExtensions>`
  - Container-side (under `agents/runtime/`, copied into the image by A): `skillFileTree(skills: EnvelopeSkillLike[]): { path: string; content: string }[]`, `writeSkills(root: string, skills): Promise<string[]>`, `mcpServerConfigs(servers: EnvelopeMcpServerLike[]): Record<string, McpServerConfig>` and `loadMcpClients(servers): Promise<McpClient[]>`. Runtime modules import nothing from outside `agents/runtime/`, so they declare local `…Like` types structurally identical to the envelope ones.

Gateway rule: a server with `viaGateway` is sent as `{ url: gateway.url, transport: 'http', headers: await gateway.headers() }` when `AWS_AGENTCORE_GATEWAY_URL` is configured. With no gateway it is left out and its name added to `skipped`, never sent directly, because the admin asked for it to go through the gateway's policy.

- [ ] **Step 1: Write the failing tests**

`server-ts/src/agents/runtime/skill-files.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { skillFileTree, writeSkills } from './skill-files.ts';

const manifest = '---\nname: pdf-tools\ndescription: "Work with PDFs"\n---\nUse pdftotext.\n';
const skill = {
   name: 'pdf-tools',
   files: [
      { path: 'SKILL.md', content: manifest },
      { path: 'scripts/run.sh', content: 'echo hi' },
   ],
};

test('each skill becomes a directory holding its files, SKILL.md included', () => {
   assert.deepEqual(skillFileTree([skill]), [
      { path: '.claude/skills/pdf-tools/SKILL.md', content: manifest },
      { path: '.claude/skills/pdf-tools/scripts/run.sh', content: 'echo hi' },
   ]);
});

test('a skill without a SKILL.md is refused rather than written half-formed', () => {
   assert.throws(() => skillFileTree([{ name: 'bare', files: [{ path: 'a.txt', content: '' }] }]));
});

test('a path that would escape its directory is refused', () => {
   assert.throws(() => skillFileTree([{ ...skill, files: [{ path: '../../x', content: '' }] }]));
   assert.throws(() => skillFileTree([{ ...skill, name: '../evil' }]));
});

test('writing puts the files on disk under the root', async () => {
   const root = await mkdtemp(join(tmpdir(), 'berry-skills-'));
   try {
      const written = await writeSkills(root, [skill]);
      assert.equal(written.length, 2);
      assert.equal(await readFile(join(root, '.claude/skills/pdf-tools/scripts/run.sh'), 'utf8'), 'echo hi');
   } finally {
      await rm(root, { recursive: true, force: true });
   }
});
```

`server-ts/src/agents/runtime/mcp-clients.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mcpServerConfigs } from './mcp-clients.ts';

test('each server becomes a prefixed, fail-soft MCP config with its transport', () => {
   assert.deepEqual(
      mcpServerConfigs([
         { name: 'docs', url: 'https://d.test/mcp', transport: 'http', headers: { A: '1' } },
         { name: 'old', url: 'https://o.test/sse', transport: 'sse', headers: {} },
      ]),
      {
         docs: { url: 'https://d.test/mcp', transport: 'streamable-http', headers: { A: '1' }, prefix: 'docs', continueOnError: true },
         old: { url: 'https://o.test/sse', transport: 'sse', headers: {}, prefix: 'old', continueOnError: true },
      }
   );
});
```

`server-ts/src/agents/extensions.test.ts` is a DB test using the fixture world, a real `SkillRepository`, `McpServerRepository` and `AgentProfileRepository` with a random sealer, and a squad from `SquadRepository`:

```ts
   test('an agent carries enabled skills, its MCP servers, opened env and its squad briefing', async () => {
      const skill = await skills.create(world.workspaceId, { name: 'ext-skill', description: 'd', content: 'c', labels: [], files: [] }, world.ownerId);
      await skills.setBinding(world.workspaceId, world.agentId, skill.id, true);
      const off = await skills.create(world.workspaceId, { name: 'off-skill', description: '', content: '', labels: [], files: [] }, world.ownerId);
      await skills.setBinding(world.workspaceId, world.agentId, off.id, false);
      await mcp.create(world.workspaceId, { agentId: null, name: 'direct', url: 'https://d.test/mcp', transport: 'streamable_http', headers: { K: 'v' }, viaGateway: false, enabled: true }, world.ownerId);
      await mcp.create(world.workspaceId, { agentId: null, name: 'gated', url: 'https://g.test/mcp', transport: 'streamable_http', headers: {}, viaGateway: true, enabled: true }, world.ownerId);
      await profile.setEnv(world.workspaceId, world.agentId, { TOKEN: 't' });

      const withoutGateway = await loadAgentExtensions({ sql, skills, mcp, profile, gateway: null }, {
         workspaceId: world.workspaceId, agentId: world.agentId, issueId: world.issueId,
      });
      assert.deepEqual(withoutGateway.skills.map((s) => s.name), ['ext-skill']);
      assert.deepEqual(withoutGateway.skills[0]?.files.map((f) => f.path), ['SKILL.md']);
      assert.match(withoutGateway.skills[0]?.files[0]?.content ?? '', /^---\nname: ext-skill\n/);
      assert.deepEqual(withoutGateway.mcpServers.map((s) => s.name), ['direct']);
      assert.equal(withoutGateway.mcpServers[0]?.transport, 'http');
      assert.deepEqual(withoutGateway.mcpServers[0]?.headers, { K: 'v' });
      assert.deepEqual(withoutGateway.skipped, ['gated']);
      assert.deepEqual(withoutGateway.env, { TOKEN: 't' });

      const withGateway = await loadAgentExtensions(
         { sql, skills, mcp, profile, gateway: { url: 'https://gw.test/mcp', headers: async () => ({ authorization: 'Bearer gw' }) } },
         { workspaceId: world.workspaceId, agentId: world.agentId, issueId: null }
      );
      assert.deepEqual(withGateway.mcpServers.find((s) => s.name === 'gated'), {
         name: 'gated', url: 'https://gw.test/mcp', transport: 'http', headers: { authorization: 'Bearer gw' },
      });
      assert.equal(withGateway.squadBriefing, null);
   });

   test('another workspace’s id yields nothing of this agent', async () => {
      const foreign = await loadAgentExtensions({ sql, skills, mcp, profile, gateway: null }, {
         workspaceId: world.otherWorkspaceId, agentId: world.agentId, issueId: null,
      }).catch(() => null);
      assert.ok(foreign === null || (foreign.skills.length === 0 && foreign.mcpServers.length === 0));
   });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/agents/runtime/skill-files.test.ts src/agents/runtime/mcp-clients.test.ts && BERRY_TEST_DATABASE_URL=… node --test --experimental-strip-types src/agents/extensions.test.ts`
Expected: FAIL, because the modules are not found.

- [ ] **Step 3: Implement the runtime modules**

`server-ts/src/agents/runtime/skill-files.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/**
 * Enabled skills, laid out in the task workspace.
 *
 * Runs inside the container. One directory per skill under `.claude/skills/`,
 * with a SKILL.md whose frontmatter names it, so tools that discover skills by
 * that convention find them, and the agent's instructions can point there.
 */

/** Structurally A's `SkillRef`: the server already rendered SKILL.md into `files`. */
export interface EnvelopeSkillLike {
   name: string;
   files: { path: string; content: string }[];
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export function skillFileTree(skills: EnvelopeSkillLike[]): { path: string; content: string }[] {
   const out: { path: string; content: string }[] = [];
   for (const skill of skills) {
      if (!NAME.test(skill.name)) throw new Error(`skill name ${JSON.stringify(skill.name)} is not a directory name`);
      if (!skill.files.some((file) => file.path === 'SKILL.md')) {
         throw new Error(`skill ${JSON.stringify(skill.name)} has no SKILL.md`);
      }
      const base = `.claude/skills/${skill.name}`;
      for (const file of skill.files) {
         if (!PATH.test(file.path) || file.path.split('/').includes('..')) {
            throw new Error(`skill file ${JSON.stringify(file.path)} would leave its directory`);
         }
         out.push({ path: `${base}/${file.path}`, content: file.content });
      }
   }
   return out;
}

export async function writeSkills(root: string, skills: EnvelopeSkillLike[]): Promise<string[]> {
   const base = resolve(root);
   const written: string[] = [];
   for (const file of skillFileTree(skills)) {
      const target = resolve(base, file.path);
      // Belt and braces over the regexes: resolved, it must still be inside root.
      if (!target.startsWith(base + sep)) throw new Error(`refusing to write outside ${base}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, 'utf8');
      written.push(file.path);
   }
   return written;
}
```

`server-ts/src/agents/runtime/mcp-clients.ts`:

```ts
import { McpClient, type McpServerConfig } from '@strands-agents/sdk';

/**
 * The agent's MCP servers, as Strands clients. Runs inside the container.
 *
 * Every server's tools are prefixed with its name, so two servers exposing
 * `search` cannot collide, and `continueOnError` keeps one unreachable server
 * from failing the whole task — its tools are simply missing.
 */

/** Structurally A's `McpServerRef`. */
export interface EnvelopeMcpServerLike {
   name: string;
   url: string;
   transport: 'http' | 'sse';
   headers: Record<string, string>;
}

export function mcpServerConfigs(servers: EnvelopeMcpServerLike[]): Record<string, McpServerConfig> {
   const configs: Record<string, McpServerConfig> = {};
   for (const server of servers) {
      configs[server.name] = {
         url: server.url,
         // Strands' McpServerConfig names the transports 'streamable-http' | 'sse' | 'stdio'.
         transport: server.transport === 'sse' ? 'sse' : 'streamable-http',
         headers: server.headers,
         prefix: server.name,
         continueOnError: true,
      };
   }
   return configs;
}

export async function loadMcpClients(servers: EnvelopeMcpServerLike[]): Promise<McpClient[]> {
   if (servers.length === 0) return [];
   return McpClient.loadServers(mcpServerConfigs(servers));
}
```

- [ ] **Step 4: Implement the server-side assembler**

`server-ts/src/agents/extensions.ts`:

```ts
import type { Sql } from '../db/pool.ts';
import type { McpServerRepository } from '../mcp/repository.ts';
import type { SkillRepository } from '../skills/repository.ts';
import { squadBriefing } from '../squads/briefing.ts';
import type { AgentProfileRepository } from './profile.ts';

/** Identical to A's `SkillRef` (runtime/envelope.ts), so it drops straight into `agent.skills`. */
export interface EnvelopeSkill {
   name: string;
   files: { path: string; content: string }[];
}

/** Identical to A's `McpServerRef`, so it drops straight into `agent.mcpServers`. */
export interface EnvelopeMcpServer {
   name: string;
   url: string;
   transport: 'http' | 'sse';
   headers: Record<string, string>;
}

export function skillManifest(skill: { name: string; description: string; content: string }): string {
   return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n${skill.content}`;
}

const wireTransport = (transport: 'streamable_http' | 'sse'): 'http' | 'sse' => (transport === 'sse' ? 'sse' : 'http');

export interface AgentExtensions {
   skills: EnvelopeSkill[];
   mcpServers: EnvelopeMcpServer[];
   env: Record<string, string>;
   squadBriefing: string | null;
   /** Servers left out, by name — gateway-routed with no gateway configured. */
   skipped: string[];
}

export interface GatewayRoute {
   url: string;
   headers: () => Promise<Record<string, string>>;
}

/**
 * Everything the agent carries into one task, beyond its instructions.
 *
 * The only place sealed env and MCP headers are opened, and the result goes
 * straight into the envelope (spec §11): never into a row, a log or a response.
 */
export async function loadAgentExtensions(
   deps: {
      sql: Sql;
      skills: SkillRepository;
      mcp: McpServerRepository;
      profile: AgentProfileRepository;
      gateway: GatewayRoute | null;
   },
   input: { workspaceId: string; agentId: string; issueId: string | null }
): Promise<AgentExtensions> {
   const [skills, servers, env, briefing] = await Promise.all([
      deps.skills.enabledForAgent(input.workspaceId, input.agentId),
      deps.mcp.forAgent(input.workspaceId, input.agentId),
      deps.profile.envFor(input.workspaceId, input.agentId),
      input.issueId ? leaderBriefing(deps.sql, input.issueId, input.agentId) : Promise.resolve(null),
   ]);

   const mcpServers: EnvelopeMcpServer[] = [];
   const skipped: string[] = [];
   for (const server of servers) {
      if (!server.viaGateway) {
         mcpServers.push({ name: server.name, url: server.url, transport: wireTransport(server.transport), headers: server.headers });
      } else if (deps.gateway) {
         mcpServers.push({ name: server.name, url: deps.gateway.url, transport: 'http', headers: await deps.gateway.headers() });
      } else {
         skipped.push(server.name);
      }
   }

   return {
      skills: skills.map((s) => ({
         name: s.name,
         files: [{ path: 'SKILL.md', content: skillManifest(s) }, ...s.fileContents.filter((f) => f.path !== 'SKILL.md')],
      })),
      mcpServers,
      env,
      squadBriefing: briefing,
      skipped,
   };
}

/** The briefing is for the squad's leader only. */
async function leaderBriefing(sql: Sql, issueId: string, agentId: string): Promise<string | null> {
   const [lead] = await sql`
      SELECT 1 FROM issue_squads i JOIN squads s ON s.id = i.squad_id
       WHERE i.issue_id = ${issueId} AND s.leader_agent_id = ${agentId}`;
   return lead ? squadBriefing(sql, issueId) : null;
}
```

(`envFor` throws `NotFound` for an agent outside `workspaceId`. That is the `.catch(() => null)` branch the foreign-workspace test accepts.)

- [ ] **Step 5: Run and confirm everything passes**

Run: `cd /Users/secret/Code/berry-circle/server-ts && node --test --experimental-strip-types src/agents/runtime/skill-files.test.ts src/agents/runtime/mcp-clients.test.ts && BERRY_TEST_DATABASE_URL=… node --test --experimental-strip-types src/agents/extensions.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server-ts/src/agents/extensions.ts server-ts/src/agents/extensions.test.ts server-ts/src/agents/runtime/skill-files.ts \
  server-ts/src/agents/runtime/skill-files.test.ts server-ts/src/agents/runtime/mcp-clients.ts server-ts/src/agents/runtime/mcp-clients.test.ts
git commit -m "feat(server-ts): assemble the skills, MCP servers and env an agent carries into a task"
```

---
### Task 10: AI agent builder — sessions, drafts from a completion task, preview, apply

**Files:**
- Create: `server-ts/migrations/089_agent_builder.up.sql`, `server-ts/src/agents/builder.ts`, `server-ts/src/mounts/agent-builder.ts`, `server-ts/src/mounts/agent-builder.test.ts`

**Interfaces:**
- Consumes: `CompleteFn` (Task 1), `AgentRepository.create`, `SkillRepository.setBinding`/`list` (Task 2), `McpServerRepository.create` (Task 4).
- Produces:
  - Tables `agent_builder_sessions(id, workspace_id, created_by, status 'drafting'|'applied'|'discarded', applied_agent_id, …)` and `agent_builder_drafts(id, session_id, workspace_id, turn, prompt, draft jsonb, created_at)`.
  - `agentDraftSchema` (Zod v4): `{ name: string(1..100); description: string(≤5000); instructions: string(≤20000); skills: string[] (names, ≤20); mcp: { name, url, transport }[] (≤10); model: string | null }`, with `type AgentDraft = z.infer<typeof agentDraftSchema>`.
  - `class AgentBuilder({ sql, complete: CompleteFn | null, skills, agents, mcp })` with `start(workspaceId, userId)`, `turn(workspaceId, sessionId, prompt): Promise<{ draftId: string; draft: AgentDraft; unknownSkills: string[] }>`, `get(workspaceId, sessionId)`, `apply(workspaceId, sessionId, draftId, userId, options: { allowMcp: boolean }): Promise<{ agentId: string }>` and `discard(workspaceId, sessionId)`. `class BuilderMcpForbidden extends Error` is thrown by `apply` when the draft has MCP servers and `allowMcp` is false.
  - `POST /sessions/:id/apply` returns 403 `MCP_SETTINGS_REQUIRED` when the draft names MCP servers and the caller lacks `settings.write`, the permission `/api/v1/mcp-servers` requires for writes. Without this check the builder would let a plain member create MCP servers.
  - Routes on `/api/v1/agent-builder`: `POST /sessions` → 201 `{ id, status, drafts: [] }`; `GET /sessions/:id`; `POST /sessions/:id/turns` `{ prompt }` → 201 `{ draftId, draft, unknownSkills }`, or 503 `AGENT_BUILDER_UNAVAILABLE` when `complete` is null; `POST /sessions/:id/apply` `{ draftId }` → 201 `{ agentId }`, or 409 `BUILDER_SESSION_CLOSED`; `DELETE /sessions/:id` → 204. Writes need `product.write`. A session is visible only to its workspace; turns are recorded per creator.

Behaviour:
- `turn` sends the last draft (if any) and the new prompt, so the person refines the draft rather than restarting. `system` lists the workspace's skill names and says to use only those. The purpose is `'agent_builder'`.
- `apply` creates the agent through `AgentRepository.create`, binds the draft's skills that exist (unknown names are ignored and were already reported as `unknownSkills`), creates the MCP servers as agent-scoped with no headers, and marks the session `applied`.

- [ ] **Step 1: Migration**

`server-ts/migrations/089_agent_builder.up.sql`:

```sql
-- Berry migration 089: agent builder sessions and their drafts.
--
-- A session is a short conversation that ends with an agent; each turn keeps
-- the draft it produced, so a person can go back to an earlier one and apply it.

CREATE TABLE IF NOT EXISTS agent_builder_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'drafting',
    applied_agent_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_builder_sessions_workspace_id_id_key UNIQUE (workspace_id, id),
    CONSTRAINT agent_builder_sessions_status_ck CHECK (status IN ('drafting', 'applied', 'discarded'))
);

CREATE TABLE IF NOT EXISTS agent_builder_drafts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    turn integer NOT NULL,
    prompt text NOT NULL,
    draft jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_builder_drafts_session_fk FOREIGN KEY (workspace_id, session_id)
        REFERENCES agent_builder_sessions (workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT agent_builder_drafts_turn_key UNIQUE (session_id, turn),
    CONSTRAINT agent_builder_drafts_prompt_ck CHECK (char_length(prompt) BETWEEN 1 AND 4000)
);
```

- [ ] **Step 2: Write the failing mount test**

`server-ts/src/mounts/agent-builder.test.ts` follows the `skills.test.ts` pattern. Register `agentBuilderMounts({ sessions, sql, builder })`, where the builder is `new AgentBuilder({ sql, complete: fake, skills: new SkillRepository(sql), agents: new AgentRepository(sql), mcp: new McpServerRepository({ sql, sealer }) })` and the fake is:

```ts
   const prompts: string[] = [];
   const complete: CompleteFn = async <T>(request: CompletionRequest<T>): Promise<T> => {
      prompts.push(request.prompt);
      return request.schema.parse({
         name: 'Release Notes Writer',
         description: 'Writes release notes.',
         instructions: 'Read merged PRs and write notes.',
         skills: ['notes-style', 'does-not-exist'],
         mcp: [{ name: 'changelog', url: 'https://c.test/mcp', transport: 'streamable_http' }],
         model: null,
      });
   };
```

Its tests:

```ts
   test('a turn returns a validated draft and names skills the workspace lacks', async () => {
      await skills.create(world.workspaceId, { name: 'notes-style', description: '', content: '', labels: [], files: [] }, world.ownerId);
      const session = await call(app, world.ownerToken, 'POST', '/api/v1/agent-builder/sessions');
      assert.equal(session.status, 201);
      const turn = await call(app, world.ownerToken, 'POST', `/api/v1/agent-builder/sessions/${session.body.id as string}/turns`, {
         prompt: 'An agent that writes release notes',
      });
      assert.equal(turn.status, 201);
      assert.equal((turn.body.draft as { name: string }).name, 'Release Notes Writer');
      assert.deepEqual(turn.body.unknownSkills, ['does-not-exist']);
      sessionId = session.body.id as string;
      draftId = turn.body.draftId as string;
   });

   test('a second turn carries the previous draft into the prompt', async () => {
      await call(app, world.ownerToken, 'POST', `/api/v1/agent-builder/sessions/${sessionId}/turns`, { prompt: 'Make it terse' });
      assert.match(prompts.at(-1) ?? '', /Release Notes Writer/);
      assert.match(prompts.at(-1) ?? '', /Make it terse/);
   });

   test('applying creates the agent with its skill and MCP server, once', async () => {
      const applied = await call(app, world.ownerToken, 'POST', `/api/v1/agent-builder/sessions/${sessionId}/apply`, { draftId });
      assert.equal(applied.status, 201);
      const agentId = applied.body.agentId as string;
      const [bound] = await sql`SELECT count(*)::int AS n FROM agent_skills WHERE agent_id = ${agentId}`;
      assert.equal(bound?.n, 1);
      const [server] = await sql`SELECT name FROM mcp_servers WHERE agent_id = ${agentId}`;
      assert.equal(server?.name, 'changelog');
      const again = await call(app, world.ownerToken, 'POST', `/api/v1/agent-builder/sessions/${sessionId}/apply`, { draftId });
      assert.equal(again.status, 409);
   });

   test('an outsider cannot read the session', async () => {
      const res = await call(app, world.outsiderToken, 'GET', `/api/v1/agent-builder/sessions/${sessionId}`);
      assert.equal(res.status, 404);
   });
```

`let sessionId = ''; let draftId = '';` are declared in the `describe`. Add a separate `describe` that builds with `complete: null` and asserts `POST …/turns` → 503 `AGENT_BUILDER_UNAVAILABLE`.

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd /Users/secret/Code/berry-circle/server-ts && BERRY_TEST_DATABASE_URL=… node --test --experimental-strip-types src/mounts/agent-builder.test.ts`
Expected: FAIL, because the modules are not found.

- [ ] **Step 4: Implement the builder**

`server-ts/src/agents/builder.ts`:

```ts
import { z } from 'zod';
import type { Sql } from '../db/pool.ts';
import { Conflict, NotFound } from '../identity/errors.ts';
import type { McpServerRepository } from '../mcp/repository.ts';
import type { SkillRepository } from '../skills/repository.ts';
import type { AgentRepository } from './repository.ts';
import type { CompleteFn } from './seams.ts';

export const agentDraftSchema = z.object({
   name: z.string().trim().min(1).max(100),
   description: z.string().max(5000).default(''),
   instructions: z.string().max(20_000).default(''),
   skills: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).max(20).default([]),
   mcp: z.array(z.object({
      name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
      url: z.string().url().refine((u) => /^https?:\/\//.test(u)),
      transport: z.enum(['streamable_http', 'sse']).default('streamable_http'),
   })).max(10).default([]),
   model: z.string().max(200).nullable().default(null),
});
export type AgentDraft = z.infer<typeof agentDraftSchema>;

export class BuilderUnavailable extends Error {
   override readonly name = 'BuilderUnavailable';
}

/** A draft with MCP servers, applied by someone who may not manage MCP servers. */
export class BuilderMcpForbidden extends Error {
   override readonly name = 'BuilderMcpForbidden';
}

const SYSTEM = (skillNames: string[]) =>
   'You design an agent for Berry, a workspace where people and AI agents work on tasks together. ' +
   'Return a JSON object for the agent: a short name, a one-line description, instructions written ' +
   'to the agent in the second person (how it should approach every task, what to produce, what to avoid), ' +
   'the skills it should use, MCP servers it needs (only if the person named one), and a model id or null. ' +
   `Use only these existing skills: ${skillNames.length ? skillNames.join(', ') : '(none)'}.`;

export class AgentBuilder {
   readonly #sql: Sql;
   readonly #complete: CompleteFn | null;
   readonly #skills: SkillRepository;
   readonly #agents: AgentRepository;
   readonly #mcp: McpServerRepository;

   constructor(options: { sql: Sql; complete: CompleteFn | null; skills: SkillRepository; agents: AgentRepository; mcp: McpServerRepository }) {
      this.#sql = options.sql;
      this.#complete = options.complete;
      this.#skills = options.skills;
      this.#agents = options.agents;
      this.#mcp = options.mcp;
   }

   async start(workspaceId: string, userId: string): Promise<{ id: string; status: string; drafts: [] }> {
      const [row] = await this.#sql`
         INSERT INTO agent_builder_sessions (workspace_id, created_by) VALUES (${workspaceId}, ${userId})
         RETURNING id, status`;
      return { id: row?.id as string, status: row?.status as string, drafts: [] };
   }

   async get(workspaceId: string, sessionId: string): Promise<{ id: string; status: string; appliedAgentId: string | null; drafts: { id: string; turn: number; prompt: string; draft: AgentDraft }[] }> {
      const [session] = await this.#sql`
         SELECT id, status, applied_agent_id FROM agent_builder_sessions
          WHERE id = ${sessionId} AND workspace_id = ${workspaceId}`;
      if (!session) throw new NotFound();
      const drafts = await this.#sql`
         SELECT id, turn, prompt, draft FROM agent_builder_drafts WHERE session_id = ${sessionId} ORDER BY turn`;
      return {
         id: session.id as string,
         status: session.status as string,
         appliedAgentId: (session.applied_agent_id as string | null) ?? null,
         drafts: drafts.map((d) => ({ id: d.id as string, turn: Number(d.turn), prompt: d.prompt as string, draft: d.draft as AgentDraft })),
      };
   }

   async turn(workspaceId: string, sessionId: string, prompt: string): Promise<{ draftId: string; draft: AgentDraft; unknownSkills: string[] }> {
      if (!this.#complete) throw new BuilderUnavailable('no completion runtime is configured');
      const session = await this.get(workspaceId, sessionId);
      if (session.status !== 'drafting') throw new Conflict();
      const known = (await this.#skills.list(workspaceId)).map((s) => s.name);
      const previous = session.drafts.at(-1);
      const draft = await this.#complete({
         workspaceId,
         purpose: 'agent_builder',
         system: SYSTEM(known),
         prompt: previous
            ? `The current draft is:\n${JSON.stringify(previous.draft, null, 2)}\n\nChange it as asked:\n${prompt}`
            : prompt,
         schema: agentDraftSchema,
      });
      const [row] = await this.#sql`
         INSERT INTO agent_builder_drafts (session_id, workspace_id, turn, prompt, draft)
         VALUES (${sessionId}, ${workspaceId}, ${session.drafts.length + 1}, ${prompt}, ${this.#sql.json(draft as never)})
         RETURNING id`;
      await this.#sql`UPDATE agent_builder_sessions SET updated_at = now() WHERE id = ${sessionId}`;
      return { draftId: row?.id as string, draft, unknownSkills: draft.skills.filter((name) => !known.includes(name)) };
   }

   async apply(
      workspaceId: string,
      sessionId: string,
      draftId: string,
      userId: string,
      options: { allowMcp: boolean }
   ): Promise<{ agentId: string }> {
      // The draft is checked before the session is claimed: a wrong draftId must
      // leave the session open, not close it with no agent.
      const [row] = await this.#sql`
         SELECT d.draft FROM agent_builder_drafts d
          WHERE d.id = ${draftId} AND d.session_id = ${sessionId} AND d.workspace_id = ${workspaceId}`;
      if (!row) {
         await this.get(workspaceId, sessionId); // NotFound for a missing session
         throw new NotFound();
      }
      const draft = agentDraftSchema.parse(row.draft);
      // Checked before the claim, so a refused apply leaves the session open.
      if (draft.mcp.length > 0 && !options.allowMcp) throw new BuilderMcpForbidden('settings.write is required');
      // The conditional update is the once-only guard against a double apply.
      const [claimed] = await this.#sql`
         UPDATE agent_builder_sessions SET status = 'applied', updated_at = now()
          WHERE id = ${sessionId} AND workspace_id = ${workspaceId} AND status = 'drafting'
          RETURNING id`;
      if (!claimed) throw new Conflict();
      try {
         const agent = await this.#agents.create({
            workspaceId,
            name: draft.name,
            description: draft.description,
            instructions: draft.instructions,
         });
         const skills = await this.#skills.list(workspaceId);
         for (const name of draft.skills) {
            const skill = skills.find((s) => s.name === name);
            if (skill) await this.#skills.setBinding(workspaceId, agent.id, skill.id, true);
         }
         for (const server of draft.mcp) {
            await this.#mcp.create(workspaceId, { agentId: agent.id, ...server, headers: {}, viaGateway: false, enabled: true }, userId);
         }
         await this.#sql`UPDATE agent_builder_sessions SET applied_agent_id = ${agent.id} WHERE id = ${sessionId}`;
         return { agentId: agent.id };
      } catch (error) {
         // Reopen the session, so a failed apply (a duplicate MCP name, say) can be retried.
         await this.#sql`
            UPDATE agent_builder_sessions SET status = 'drafting', updated_at = now()
             WHERE id = ${sessionId} AND applied_agent_id IS NULL`;
         throw error;
      }
   }

   async discard(workspaceId: string, sessionId: string): Promise<void> {
      const updated = await this.#sql`
         UPDATE agent_builder_sessions SET status = 'discarded', updated_at = now()
          WHERE id = ${sessionId} AND workspace_id = ${workspaceId} AND status = 'drafting'`;
      if (updated.count !== 1) await this.get(workspaceId, sessionId);
   }
}
```

(The draft's `model` is not applied here, because `AgentRepository.create` needs a catalogue-validated provider/model pair. The agent page's model tab sets it after apply. The builder UI shows the suggested model as a hint. See Task 16.)

- [ ] **Step 5: Implement the mount**

`server-ts/src/mounts/agent-builder.ts`:

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { AgentBuilder, BuilderMcpForbidden, BuilderUnavailable } from '../agents/builder.ts';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { Conflict, NotFound } from '../identity/errors.ts';
import { currentWorkspace, pathId, resolveScoped } from './shared.ts';
import { readJson } from './zod-body.ts';

const turnSchema = z.strictObject({ prompt: z.string().trim().min(1).max(4000) });
const applySchema = z.strictObject({ draftId: z.string().uuid() });

export function agentBuilderMounts(options: { sessions: SessionService; sql: Sql; builder: AgentBuilder }): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));
   const { builder, sql } = options;
   const scope = async (user: { id: string; currentWorkspaceId: string | null }) =>
      (await resolveScoped(sql, user.id, currentWorkspace(user.currentWorkspaceId), 'product.write')).ctx.workspaceId;
   const sessionId = (raw: string | undefined) => pathId(raw, 'Builder session');

   route.post('/sessions', async (context) => {
      const workspaceId = await scope(context.get('user'));
      return json(await builder.start(workspaceId, context.get('user').id), 201);
   });

   route.get('/sessions/:id', async (context) => {
      const workspaceId = await scope(context.get('user'));
      return json(await builder.get(workspaceId, sessionId(context.req.param('id'))).catch(rethrow));
   });

   route.post('/sessions/:id/turns', async (context) => {
      const workspaceId = await scope(context.get('user'));
      const { prompt } = await readJson(context, turnSchema);
      return json(await builder.turn(workspaceId, sessionId(context.req.param('id')), prompt).catch(rethrow), 201);
   });

   route.post('/sessions/:id/apply', async (context) => {
      const user = context.get('user');
      const workspaceId = await scope(user);
      const { draftId } = await readJson(context, applySchema);
      // MCP servers are a settings.write resource (Task 4); the builder must not widen that.
      const allowMcp = await resolveScoped(sql, user.id, workspaceId, 'settings.write').then(
         () => true,
         () => false
      );
      const applied = await builder
         .apply(workspaceId, sessionId(context.req.param('id')), draftId, user.id, { allowMcp })
         .catch(rethrow);
      return json(applied, 201);
   });

   route.delete('/sessions/:id', async (context) => {
      const workspaceId = await scope(context.get('user'));
      await builder.discard(workspaceId, sessionId(context.req.param('id'))).catch(rethrow);
      return new Response(null, { status: 204 });
   });

   return [{ prefix: '/api/v1/agent-builder', handler: route }];
}

function rethrow(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('Builder session');
   if (error instanceof Conflict) throw new ApiError(409, 'BUILDER_SESSION_CLOSED', 'This builder session is closed.');
   if (error instanceof BuilderUnavailable) {
      throw new ApiError(503, 'AGENT_BUILDER_UNAVAILABLE', 'The agent builder needs the agent runtime.');
   }
   if (error instanceof BuilderMcpForbidden) {
      throw new ApiError(403, 'MCP_SETTINGS_REQUIRED', 'Only workspace admins can add MCP servers to an agent.');
   }
   if (error instanceof z.ZodError) {
      throw new ApiError(502, 'AGENT_BUILDER_INVALID_DRAFT', 'The builder produced a draft Berry could not use.');
   }
   throw error;
}
```

The builder test also asserts that `POST …/apply` with a random `draftId` returns 404 and leaves the session `drafting` (so a later valid apply still returns 201). It also asserts that a plain member (`world.memberToken`, who has `product.write` but not `settings.write`) applying a draft whose `mcp` is non-empty gets 403 `MCP_SETTINGS_REQUIRED`, that no agent and no `mcp_servers` row were created, and that the session is still `drafting`. Run this assertion in its own session, before the owner's apply test.

- [ ] **Step 6: Run and confirm it passes**

Run: `cd /Users/secret/Code/berry-circle/server-ts && BERRY_TEST_DATABASE_URL=… node --test --experimental-strip-types src/mounts/agent-builder.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server-ts/migrations/089_agent_builder.up.sql server-ts/src/agents/builder.ts server-ts/src/mounts/agent-builder.ts \
  server-ts/src/mounts/agent-builder.test.ts
git commit -m "feat(server-ts): draft an agent from a conversation and apply the draft"
```

---
### Task 11: Chat on tasks — sessions, queued tasks, cancel and prioritise, titles, drafts, suggestions

**Files:**
- Create: `server-ts/migrations/090_chat_sessions.up.sql`, `server-ts/src/conversations/chat-tasks.ts`, `server-ts/src/conversations/chat-tasks.test.ts`, `server-ts/src/mounts/conversations.test.ts`
- Modify: `server-ts/src/conversations/repository.ts` (session methods), `server-ts/src/mounts/conversations.ts` (rewritten around tasks)
- Delete: `server-ts/src/conversations/responder.ts`, `server-ts/src/conversations/responder.test.ts`

**Interfaces:**
- Consumes: `EnqueueTask`, `CompleteFn`, `onRunTerminal` (Task 1), `Run`, `RunLedger.markCancelled`, `RunRepository.events`, `quick_action_definitions` (migration 005), `agent_skills` (Task 2).
- Produces:
  - Migration 090 adds `conversations.active_run_id uuid` and `conversations.title_source text DEFAULT 'agent'` (`'agent'|'generated'|'user'`). It adds `pinned_at`, `archived_at`, `last_read_at` and `draft` to `conversation_participants`, `run_id uuid` to `conversation_messages`, and creates the table `user_pinned_agents(user_id, workspace_id, agent_id, position)`.
  - `ConversationSummary` gains `pinned: boolean`, `archived: boolean`, `unread: number`, `activeRunId: string | null` and `draft: string`.
  - `ConversationRepository` gains `list(userId, { archived?: boolean })`, `createSession({ workspaceId, userId, agentId, title })`, `rename(id, userId, title)`, `setPinned(id, userId, pinned)`, `setArchived(id, userId, archived)`, `remove(id, userId)`, `markRead(id, userId)`, `saveDraft(id, userId, draft)`, `appendAgentReply({ conversationId, agentId, body, runId })`, `setActiveRun(id, runId | null)`, `pinnedAgents(userId, workspaceId)` and `setPinnedAgents(userId, workspaceId, agentIds)`.
  - `sendChatMessage(deps: { sql; conversations; enqueue: EnqueueTask }, input: { conversation: ConversationContext; userId; body }): Promise<{ messageId: string; runId: string }>`
  - `registerChatReplies(deps: { sql; conversations; report? }): () => void`. When a run with a `chat_session_id` ends, it appends the run's summary (or a failure line) as the agent's message, linked by `run_id`, and clears `active_run_id`.
  - `generateTitle(deps: { sql; complete: CompleteFn }, input: { workspaceId; conversationId; firstMessage }): Promise<string | null>`. It writes the title only while `title_source = 'agent'`.
  - `chatSuggestions(sql, { workspaceId, agentId }): Promise<{ label: string; prompt: string }[]>`, built from quick actions targeting the agent and its enabled skills.
  - Routes (prefix unchanged, `/api/v1/conversations`):
    - `GET /?archived=true`
    - `POST /` `{ agentId, title? }` → 201 `{ id }` (a new session, never deduplicated)
    - `POST /agents/:agentId` (kept: the caller's latest open session with that agent, or a new one)
    - `PATCH /:id` `{ title?, pinned?, archived? }`
    - `DELETE /:id` → 204
    - `POST /:id/read` → 204
    - `PUT /:id/draft` `{ draft }` → 204
    - `GET /:id/messages?before=<messageId>&first=<n>` (history paging)
    - `POST /:id/messages` `{ body }` → **202** `{ messageId, runId, queued: true }`, or 503 `AGENT_TASKS_UNAVAILABLE` without `enqueue`. The message is kept either way.
    - `GET /:id/tasks` (queued and running runs of this session)
    - `POST /:id/tasks/:runId/cancel`
    - `POST /:id/tasks/:runId/prioritize` (sets `runs.priority = 100`)
    - `GET /:id/tasks/:runId/events` (the thread view of one task)
    - `GET /suggestions?agentId=`
    - `GET /pinned-agents`, `PUT /pinned-agents` `{ agentIds }`

Chat task queries need A's `runs.chat_session_id` and `runs.priority`. Their DB tests check `information_schema.columns` and skip with the message `'runs.chat_session_id is not present (workstream A not merged)'` when the column is missing. Everything else in this task is tested unconditionally.

- [ ] **Step 1: Migration**

`server-ts/migrations/090_chat_sessions.up.sql`:

```sql
-- Berry migration 090: chat sessions that run agent tasks.
--
-- A conversation is a chat session. Per-person state (pinned, archived,
-- read position, unsent draft) lives on the participant row, because two
-- people in one thread pin and read it independently.

-- FK as A's handoff requires (A plan: "active_run_id uuid REFERENCES runs(id) ON DELETE SET NULL").
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS active_run_id uuid REFERENCES runs(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS title_source text NOT NULL DEFAULT 'agent';
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_title_source_ck;
ALTER TABLE conversations ADD CONSTRAINT conversations_title_source_ck
    CHECK (title_source IN ('agent', 'generated', 'user')) NOT VALID;

ALTER TABLE conversation_participants ADD COLUMN IF NOT EXISTS pinned_at timestamptz;
ALTER TABLE conversation_participants ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE conversation_participants ADD COLUMN IF NOT EXISTS last_read_at timestamptz;
ALTER TABLE conversation_participants ADD COLUMN IF NOT EXISTS draft text NOT NULL DEFAULT '';
ALTER TABLE conversation_participants DROP CONSTRAINT IF EXISTS conversation_participants_draft_ck;
ALTER TABLE conversation_participants ADD CONSTRAINT conversation_participants_draft_ck
    CHECK (char_length(draft) <= 20000) NOT VALID;

ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS conversation_messages_run_idx
    ON conversation_messages (run_id) WHERE run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_pinned_agents (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    position integer NOT NULL,
    PRIMARY KEY (user_id, agent_id),
    CONSTRAINT user_pinned_agents_agent_fk FOREIGN KEY (workspace_id, agent_id)
        REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);
```

- [ ] **Step 2: Write the failing tests**

`server-ts/src/conversations/chat-tasks.test.ts` (DB):

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { CompleteFn, CompletionRequest, EnqueueInput } from '../agents/seams.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { dropAgentLayerWorld, seedAgentLayerWorld, type AgentLayerWorld } from '../mounts/agent-layer.fixture.ts';
import { chatSuggestions, generateTitle, sendChatMessage } from './chat-tasks.ts';
import { ConversationRepository } from './repository.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('chat on tasks', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: AgentLayerWorld;
   let conversations: ConversationRepository;
   let conversationId: string;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
      conversations = new ConversationRepository(sql);
      conversationId = await conversations.createSession({ workspaceId: world.workspaceId, userId: world.ownerId, agentId: world.agentId, title: null });
   });
   after(async () => {
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });

   test('a message is stored and queues a chat task for the session’s agent', async () => {
      const calls: EnqueueInput[] = [];
      const context = await conversations.context(conversationId, world.ownerId);
      const sent = await sendChatMessage(
         { sql, conversations, enqueue: async (_s, input) => { calls.push(input); return { runId: '33333333-3333-4333-8333-333333333333' }; } },
         { conversation: context, userId: world.ownerId, body: 'Summarise the open tasks' }
      );
      assert.equal(calls[0]?.source, 'chat');
      assert.equal(calls[0]?.chatSessionId, conversationId);
      assert.equal(calls[0]?.agentId, world.agentId);
      assert.equal(calls[0]?.prompt, 'Summarise the open tasks');
      const messages = await conversations.messages(conversationId);
      assert.equal(messages.at(-1)?.id, sent.messageId);
   });

   test('a generated title replaces the default once, and never a title a person set', async () => {
      const complete: CompleteFn = async <T>(r: CompletionRequest<T>) => r.schema.parse({ title: 'Open task summary' });
      assert.equal(await generateTitle({ sql, complete }, { workspaceId: world.workspaceId, conversationId, firstMessage: 'x' }), 'Open task summary');
      await conversations.rename(conversationId, world.ownerId, 'Mine');
      assert.equal(await generateTitle({ sql, complete }, { workspaceId: world.workspaceId, conversationId, firstMessage: 'x' }), null);
   });

   test('pin, archive and draft are per person', async () => {
      await conversations.setPinned(conversationId, world.ownerId, true);
      await conversations.saveDraft(conversationId, world.ownerId, 'half a thought');
      const [summary] = await conversations.list(world.ownerId);
      assert.equal(summary?.pinned, true);
      assert.equal(summary?.draft, 'half a thought');
      await conversations.setArchived(conversationId, world.ownerId, true);
      assert.equal((await conversations.list(world.ownerId)).length, 0);
      assert.equal((await conversations.list(world.ownerId, { archived: true })).length, 1);
   });

   test('suggestions come from quick actions for the agent and its enabled skills', async () => {
      await sql`INSERT INTO quick_action_definitions (workspace_id, name, target_agent_id, prompt, created_by)
                VALUES (${world.workspaceId}, 'Triage', ${world.agentId}, 'Triage the inbox', ${world.ownerId})`;
      const suggestions = await chatSuggestions(sql, { workspaceId: world.workspaceId, agentId: world.agentId });
      assert.deepEqual(suggestions[0], { label: 'Triage', prompt: 'Triage the inbox' });
   });
});
```

`server-ts/src/mounts/conversations.test.ts` registers `conversationMounts({ sessions, conversations, boards: new BoardRepository(sql), sql, enqueue: fake, complete: null, ledger: new RunLedger({ sql }), runs: new RunRepository(sql) })` and asserts:
- `POST /api/v1/conversations { agentId }` twice returns two different ids (sessions are not deduplicated).
- `POST /:id/messages { body: 'hi' }` returns 202 with `queued: true`.
- With `enqueue: null`, it returns 503 `AGENT_TASKS_UNAVAILABLE`, and the message is still listed.
- `PATCH /:id { title: 'Renamed' }` changes `topic` in `GET /`.
- `DELETE /:id` returns 204, and a later `GET /:id/messages` returns 404.
- An outsider's `GET /:id/messages` returns 404.
- `POST /api/v1/conversations { agentId: world.otherAgentId }` returns 404.
- `PUT /pinned-agents { agentIds: [world.agentId] }` then `GET /pinned-agents` returns `[world.agentId]`, and pinning `world.otherAgentId` returns 404.
- Gated on the A column: after inserting a run row with `chat_session_id = id`, `GET /:id/tasks` lists it, `POST …/prioritize` returns 204 and sets `priority = 100`, and `POST …/cancel` returns 202.

- [ ] **Step 3: Run them and confirm they fail**

Run: `cd /Users/secret/Code/berry-circle/server-ts && BERRY_TEST_DATABASE_URL=… node --test --experimental-strip-types src/conversations/chat-tasks.test.ts src/mounts/conversations.test.ts`
Expected: FAIL, because the module and methods are missing.

- [ ] **Step 4: Implement the repository methods**

In `server-ts/src/conversations/repository.ts`:
- Extend `list(userId, options: { archived?: boolean } = {}, limit = 50)`. Select `me.pinned_at IS NOT NULL AS pinned`, `me.archived_at IS NOT NULL AS archived` and `me.draft`, plus `conversation.active_run_id` and an unread count:
  `(SELECT count(*) FROM conversation_messages m WHERE m.conversation_id = conversation.id AND m.created_at > COALESCE(me.last_read_at, 'epoch') AND m.author_type <> 'user') AS unread`.
  Filter with `(me.archived_at IS NOT NULL) = ${options.archived ?? false}`, and order by `me.pinned_at IS NULL, conversation.updated_at DESC, conversation.id DESC`. Map the new fields onto `ConversationSummary`.
- Add the methods:

```ts
   async createSession(input: { workspaceId: string; userId: string; agentId: string; title: string | null }): Promise<string> {
      const id = this.#newId();
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const [agent] = await tx`
            SELECT name FROM agents WHERE id = ${input.agentId} AND workspace_id = ${input.workspaceId} AND archived_at IS NULL`;
         if (!agent) throw new NotFound();
         await tx`
            INSERT INTO conversations (id, workspace_id, kind, topic, status, created_by, title_source)
            VALUES (${id}, ${input.workspaceId}, 'direct', ${input.title ?? (agent.name as string)}, 'open', ${input.userId},
                    ${input.title ? 'user' : 'agent'})`;
         await tx`
            INSERT INTO conversation_participants (conversation_id, participant_type, participant_id, role)
            VALUES (${id}, 'user', ${input.userId}, 'owner'), (${id}, 'agent', ${input.agentId}, 'member')`;
      });
      return id;
   }

   /** Every per-person mutation checks participation in the same statement. */
   async rename(id: string, userId: string, title: string): Promise<void> {
      const updated = await this.#sql`
         UPDATE conversations c SET topic = ${title}, title_source = 'user', updated_at = now()
          WHERE c.id = ${id} AND EXISTS (SELECT 1 FROM conversation_participants p
                WHERE p.conversation_id = c.id AND p.participant_type = 'user' AND p.participant_id = ${userId} AND p.left_at IS NULL)`;
      if (updated.count !== 1) throw new NotFound();
   }

   async setPinned(id: string, userId: string, pinned: boolean): Promise<void> {
      await this.#participant(id, userId, this.#sql`pinned_at = ${pinned ? this.#sql`now()` : null}`);
   }

   async setArchived(id: string, userId: string, archived: boolean): Promise<void> {
      await this.#participant(id, userId, this.#sql`archived_at = ${archived ? this.#sql`now()` : null}`);
   }

   async markRead(id: string, userId: string): Promise<void> {
      await this.#participant(id, userId, this.#sql`last_read_at = now()`);
   }

   async saveDraft(id: string, userId: string, draft: string): Promise<void> {
      await this.#participant(id, userId, this.#sql`draft = ${draft}`);
   }

   /** Leaving is deleting for a direct session: the thread and its messages go. */
   async remove(id: string, userId: string): Promise<void> {
      const deleted = await this.#sql`
         DELETE FROM conversations c WHERE c.id = ${id} AND c.kind = 'direct'
            AND EXISTS (SELECT 1 FROM conversation_participants p WHERE p.conversation_id = c.id
                        AND p.participant_type = 'user' AND p.participant_id = ${userId} AND p.role = 'owner')`;
      if (deleted.count !== 1) throw new NotFound();
   }

   async appendAgentReply(input: { conversationId: string; agentId: string; body: string; runId: string }): Promise<void> {
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const [existing] = await tx`SELECT 1 FROM conversation_messages WHERE run_id = ${input.runId}`;
         if (existing) return; // a hook that fires twice posts once
         await tx`
            INSERT INTO conversation_messages (id, conversation_id, author_type, author_id, body, run_id)
            VALUES (${this.#newId()}, ${input.conversationId}, 'agent', ${input.agentId}, ${input.body}, ${input.runId})`;
         // The session's active run advances to its next queued task, if any
         // (runs.chat_session_id is A's; this method is only called from the
         // run-terminal hook, which Task 13 registers after A has merged).
         const [conversation] = await tx`
            UPDATE conversations SET updated_at = now(),
                   active_run_id = CASE WHEN active_run_id = ${input.runId}
                      THEN (SELECT r.id FROM runs r
                             WHERE r.chat_session_id = ${input.conversationId} AND r.status = 'queued'
                               AND r.id <> ${input.runId}
                             ORDER BY r.priority DESC, r.created_at ASC LIMIT 1)
                      ELSE active_run_id END
             WHERE id = ${input.conversationId}
            RETURNING workspace_id`;
         // Realtime (spec §10): the reply reaches open chat views through the
         // existing outbox + SSE hub, not by polling alone.
         await tx`
            INSERT INTO outbox_events (topic, aggregate_type, aggregate_id, workspace_id, payload)
            VALUES ('conversation.message.created', 'conversation', ${input.conversationId},
                    ${conversation?.workspace_id as string},
                    ${tx.json({ conversationId: input.conversationId, runId: input.runId } as never)})`;
      });
   }

   async setActiveRun(id: string, runId: string | null): Promise<void> {
      await this.#sql`UPDATE conversations SET active_run_id = ${runId} WHERE id = ${id}`;
   }

   async pinnedAgents(userId: string, workspaceId: string): Promise<string[]> {
      const rows = await this.#sql`
         SELECT agent_id FROM user_pinned_agents WHERE user_id = ${userId} AND workspace_id = ${workspaceId} ORDER BY position`;
      return rows.map((r) => r.agent_id as string);
   }

   async setPinnedAgents(userId: string, workspaceId: string, agentIds: string[]): Promise<void> {
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         await tx`DELETE FROM user_pinned_agents WHERE user_id = ${userId} AND workspace_id = ${workspaceId}`;
         for (const [position, agentId] of agentIds.entries()) {
            await tx`INSERT INTO user_pinned_agents (user_id, workspace_id, agent_id, position)
                     VALUES (${userId}, ${workspaceId}, ${agentId}, ${position})`.catch((error: unknown) => {
               if ((error as { code?: string }).code === '23503') throw new NotFound();
               throw error;
            });
         }
      });
   }

   async #participant(id: string, userId: string, set: ReturnType<Sql>): Promise<void> {
      const updated = await this.#sql`
         UPDATE conversation_participants SET ${set}
          WHERE conversation_id = ${id} AND participant_type = 'user' AND participant_id = ${userId} AND left_at IS NULL`;
      if (updated.count !== 1) throw new NotFound();
   }
```

`messages` gains an optional `before?: string` (a message id): `AND (${before ?? null}::uuid IS NULL OR (message.created_at, message.id) < (SELECT created_at, id FROM conversation_messages WHERE id = ${before ?? null}::uuid))`, ordered descending with `LIMIT`, then reversed so the page reads oldest first. It also selects `message.run_id` into a new `runId: string | null` field on `ConversationMessage`.

(postgres.js fragments: `this.#sql\`pinned_at = ${…}\`` is embeddable inside `SET ${set}`. If typecheck objects to `ReturnType<Sql>`, type `set` as `postgres.PendingQuery<postgres.Row[]>`, which is the type `PendingScope` uses in `identity/workspace-context.ts`.)

- [ ] **Step 5: Implement chat-tasks**

`server-ts/src/conversations/chat-tasks.ts`:

```ts
import { z } from 'zod';
import type { CompleteFn, EnqueueTask } from '../agents/seams.ts';
import type { Sql } from '../db/pool.ts';
import type { Run } from '../runs/ledger.ts';
import { onRunTerminal } from '../runs/terminal-hooks.ts';
import type { ConversationContext, ConversationRepository } from './repository.ts';

/**
 * Chat is an agent task now.
 *
 * A message queues a run on the session's agent, with the session as its
 * runtime session (A's `(agent, chatSessionId)`), so chat has the same tools,
 * ledger and cancellation as any task. The reply is the run's final message,
 * appended when the run ends.
 */

export class ChatNotAnswerable extends Error {
   override readonly name = 'ChatNotAnswerable';
}

export async function sendChatMessage(
   deps: { sql: Sql; conversations: ConversationRepository; enqueue: EnqueueTask },
   input: { conversation: ConversationContext; userId: string; body: string }
): Promise<{ messageId: string; runId: string }> {
   if (!input.conversation.agentId) throw new ChatNotAnswerable('this conversation has no agent');
   const messageId = await deps.conversations.append({
      conversationId: input.conversation.id,
      authorType: 'user',
      authorId: input.userId,
      body: input.body,
   });
   const { runId } = await deps.enqueue(deps.sql, {
      workspaceId: input.conversation.workspaceId,
      agentId: input.conversation.agentId,
      kind: 'agent',
      source: 'chat',
      chatSessionId: input.conversation.id,
      prompt: input.body,
   });
   await deps.conversations.setActiveRun(input.conversation.id, runId);
   return { messageId, runId };
}

export function registerChatReplies(deps: { sql: Sql; conversations: ConversationRepository; report?: (e: unknown) => void }): () => void {
   return onRunTerminal(async (run: Run) => {
      const [row] = await deps.sql`SELECT chat_session_id, agent_id, summary FROM runs WHERE id = ${run.id}`;
      const conversationId = row?.chat_session_id as string | null | undefined;
      if (!conversationId) return;
      const body =
         run.status === 'succeeded'
            ? ((row?.summary as string | null) ?? '').trim() || '(The agent finished without a reply.)'
            : run.status === 'cancelled'
              ? '(This task was cancelled.)'
              : `(The task failed: ${run.failure?.message ?? 'unknown error'})`;
      await deps.conversations.appendAgentReply({ conversationId, agentId: row?.agent_id as string, body, runId: run.id });
   });
}

const titleSchema = z.object({ title: z.string().trim().min(1).max(80) });

export async function generateTitle(
   deps: { sql: Sql; complete: CompleteFn },
   input: { workspaceId: string; conversationId: string; firstMessage: string }
): Promise<string | null> {
   const [row] = await deps.sql`SELECT title_source FROM conversations WHERE id = ${input.conversationId}`;
   if (row?.title_source !== 'agent') return null;
   const { title } = await deps.complete({
      workspaceId: input.workspaceId,
      purpose: 'chat_title',
      system: 'Name this conversation in at most six words. Return JSON {"title": "…"}.',
      prompt: input.firstMessage.slice(0, 2000),
      schema: titleSchema,
   });
   const updated = await deps.sql`
      UPDATE conversations SET topic = ${title}, title_source = 'generated'
       WHERE id = ${input.conversationId} AND title_source = 'agent'`;
   return updated.count === 1 ? title : null;
}

export async function chatSuggestions(sql: Sql, input: { workspaceId: string; agentId: string }): Promise<{ label: string; prompt: string }[]> {
   const actions = await sql`
      SELECT name, prompt FROM quick_action_definitions
       WHERE workspace_id = ${input.workspaceId} AND target_agent_id = ${input.agentId} AND archived_at IS NULL
       ORDER BY name LIMIT 6`;
   const skills = await sql`
      SELECT s.name, s.description FROM agent_skills b JOIN skills s ON s.id = b.skill_id
       WHERE b.agent_id = ${input.agentId} AND b.enabled AND s.workspace_id = ${input.workspaceId}
       ORDER BY s.name LIMIT 4`;
   return [
      ...actions.map((a) => ({ label: a.name as string, prompt: a.prompt as string })),
      ...skills.map((s) => ({ label: `Use ${s.name as string}`, prompt: `Use the ${s.name as string} skill: ${s.description as string}` })),
   ];
}
```

- [ ] **Step 6: Rewrite the mount**

`server-ts/src/mounts/conversations.ts`:
- `ConversationOptions` drops `responder` and gains `enqueue: EnqueueTask | null`, `complete: CompleteFn | null`, `ledger: Pick<RunLedger, 'markCancelled'>`, `runs: RunRepository` and `logger?: Logger`.
- Keep `load(context)` (participation check → 404) and use it on every `/:conversationId/...` route.
- Scope new sessions and pinned agents through the agent's workspace, reusing the existing `POST /agents/:agentId` authorization (`boards.authorizeWorkspace(user.id, agent.workspace_id, 'product.write')` → 404).
- `POST /:id/messages`:

```ts
   route.post('/:conversationId/messages', async (context) => {
      const conversation = await load(context);
      const { body } = await readJson(context, z.strictObject({ body: z.string().trim().min(1).max(MAX_BODY) }));
      if (!options.enqueue) {
         // Kept, so what the person typed is not lost; nobody can run it here.
         await conversations.append({ conversationId: conversation.id, authorType: 'user', authorId: context.get('user').id, body });
         throw new ApiError(503, 'AGENT_TASKS_UNAVAILABLE', 'This server cannot run agent tasks.');
      }
      const first = (await conversations.messages(conversation.id)).length === 0;
      const sent = await sendChatMessage({ sql: options.sql, conversations, enqueue: options.enqueue }, {
         conversation, userId: context.get('user').id, body,
      }).catch((error: unknown) => {
         if (error instanceof ChatNotAnswerable) throw new ApiError(409, 'CONVERSATION_HAS_NO_AGENT', error.message);
         throw error;
      });
      await conversations.saveDraft(conversation.id, context.get('user').id, '');
      if (first && options.complete) {
         // Best effort, after the response: a title is a nicety, never a failed send.
         void generateTitle({ sql: options.sql, complete: options.complete }, {
            workspaceId: conversation.workspaceId, conversationId: conversation.id, firstMessage: body,
         }).catch((error: unknown) => options.logger?.error('chat title failed', { error: String(error) }));
      }
      return json({ messageId: sent.messageId, runId: sent.runId, queued: true }, 202);
   });
```

- `GET /:id/tasks`: `SELECT id, status, priority, created_at, started_at FROM runs WHERE chat_session_id = ${conversation.id} AND status IN ('queued','running') ORDER BY priority DESC, created_at`.
- `POST /:id/tasks/:runId/cancel`: check `runs.chat_session_id = conversation.id` (otherwise 404), then `ledger.markCancelled(runId)` → 202 `serializeRun`.
- `POST /:id/tasks/:runId/prioritize`: `UPDATE runs SET priority = 100 WHERE id = ${runId} AND chat_session_id = ${conversation.id} AND status = 'queued'`. A count of 0 returns 409 `TASK_NOT_QUEUED`; otherwise 204.
- `GET /:id/tasks/:runId/events`: the same chat-session check, then `runs.events(runId, null, 500)`.
- `GET /suggestions?agentId=` and `GET|PUT /pinned-agents` scope through `currentWorkspace(user.currentWorkspaceId)` and `resolveScoped` (`product.read`/`product.write`). Register them **before** `/:conversationId` routes.
- Delete `src/conversations/responder.ts` and `responder.test.ts`. Remove the `ConversationResponder` import and construction from `src/index.ts`, and pass `enqueue: null, complete: null, ledger: runOptions.ledger, runs: runOptions.runs, logger` for now. Task 13 replaces the nulls.

- [ ] **Step 7: Run and confirm everything passes**

Run: `cd /Users/secret/Code/berry-circle/server-ts && BERRY_TEST_DATABASE_URL=… node --test --experimental-strip-types src/conversations/chat-tasks.test.ts src/mounts/conversations.test.ts && pnpm typecheck && pnpm test`
Expected: PASS. The A-gated chat-task assertions skip until A is merged.

- [ ] **Step 8: Commit**

```bash
git add server-ts/migrations/090_chat_sessions.up.sql server-ts/src/conversations server-ts/src/mounts/conversations.ts \
  server-ts/src/mounts/conversations.test.ts server-ts/src/index.ts
git rm server-ts/src/conversations/responder.ts server-ts/src/conversations/responder.test.ts
git commit -m "feat(server-ts): run chat messages as agent tasks, with sessions, drafts and a task queue"
```

---
### Task 12: Wire the agent layer into the server, and prove tenant isolation

**Files:**
- Create: `server-ts/src/mounts/agent-layer.cross-tenant.test.ts`
- Modify: `server-ts/src/index.ts`, `server-ts/SCOPE.md`

**Interfaces:**
- Consumes: every mount and repository from Tasks 2–11.
- Produces: served prefixes `/api/v1/skills`, `/api/v1/mcp-servers`, `/api/v1/squads` and `/api/v1/agent-builder`; `agentMounts` receives `runs`, `ledger` and `profile`; `issueMounts` receives `agentAccess`; `commentOptions` gains `triggers` only once `enqueue` exists (Task 13).

- [ ] **Step 1: Write the failing cross-tenant test**

`server-ts/src/mounts/agent-layer.cross-tenant.test.ts`: one registry with `skillMounts`, `mcpServerMounts`, `squadMounts`, `agentBuilderMounts` (fake complete), `conversationMounts` (fake enqueue), `agentMounts` (with `runs`, `ledger` and `profile`) and `issueMounts` with `nested.comments: issueCommentRoutes(…)` for the trigger preview. The setup:

```ts
   const ids = { skill: '', mcp: '', squad: '', builder: '', conversation: '' };

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
      // … build `app` from the registry described above …
      const own = (method: string, path: string, body?: unknown) => call(app, world.ownerToken, method, path, body);
      ids.skill = (await own('POST', '/api/v1/skills', { name: 'ct-skill' })).body.id as string;
      ids.mcp = (await own('POST', '/api/v1/mcp-servers', {
         agentId: null, name: 'ct-mcp', url: 'https://ct.test/mcp', headers: {},
      })).body.id as string;
      ids.squad = (await own('POST', '/api/v1/squads', { name: 'CT', leaderAgentId: world.agentId })).body.id as string;
      ids.builder = (await own('POST', '/api/v1/agent-builder/sessions')).body.id as string;
      ids.conversation = (await own('POST', '/api/v1/conversations', { agentId: world.agentId })).body.id as string;
      for (const id of Object.values(ids)) assert.match(id, /^[0-9a-f-]{36}$/);
   });
```

Then, as the outsider of W2:

```ts
   const probes = (): [string, string, unknown?][] => [
      ['GET', `/api/v1/skills/${ids.skill}`],
      ['PATCH', `/api/v1/skills/${ids.skill}`, { description: 'x' }],
      ['DELETE', `/api/v1/skills/${ids.skill}`],
      ['POST', `/api/v1/skills/${ids.skill}/refresh`],
      ['PUT', `/api/v1/skills/${ids.skill}/agents/${world.agentId}`, { enabled: true }],
      ['PATCH', `/api/v1/mcp-servers/${ids.mcp}`, { enabled: false }],
      ['DELETE', `/api/v1/mcp-servers/${ids.mcp}`],
      ['GET', `/api/v1/squads/${ids.squad}`],
      ['PUT', `/api/v1/squads/${ids.squad}/members`, { members: [] }],
      ['POST', `/api/v1/squads/${ids.squad}/assign`, { issueRef: world.issueId }],
      ['GET', `/api/v1/agent-builder/sessions/${ids.builder}`],
      ['POST', `/api/v1/agent-builder/sessions/${ids.builder}/turns`, { prompt: 'x' }],
      ['GET', `/api/v1/conversations/${ids.conversation}/messages`],
      ['POST', `/api/v1/conversations/${ids.conversation}/messages`, { body: 'x' }],
      ['PUT', `/api/v1/conversations/${ids.conversation}/draft`, { draft: 'x' }],
      ['GET', `/api/v1/conversations/${ids.conversation}/tasks`],
      ['POST', `/api/v1/issues/${world.issueId}/comments/trigger-preview`, { body: 'x' }],
      ['GET', `/api/v1/agents/${world.agentId}/access`],
      ['GET', `/api/v1/agents/${world.agentId}/tasks`],
      ['PUT', `/api/v1/agents/${world.agentId}/env`, { env: { A: 'b' } }],
      ['PUT', `/api/v1/agents/${world.agentId}/labels`, { labels: ['x'] }],
      ['PUT', `/api/v1/agents/${world.agentId}/permissions`, { access: { assign: 'everyone', mention: 'everyone', members: [] } }],
      ['POST', `/api/v1/agents/${world.agentId}/copy`],
      ['POST', `/api/v1/agents/${world.agentId}/restore`],
      ['POST', `/api/v1/agents/${world.agentId}/cancel-tasks`],
      ['GET', `/api/v1/agents/${world.agentId}/avatar`],
      ['PUT', `/api/v1/agents/${world.agentId}/avatar`],
      ['DELETE', `/api/v1/agents/${world.agentId}`],
      ['DELETE', `/api/v1/skills/${ids.skill}/agents/${world.agentId}`],
      ['PATCH', `/api/v1/squads/${ids.squad}`, { name: 'x' }],
      ['DELETE', `/api/v1/squads/${ids.squad}`],
      ['DELETE', `/api/v1/agent-builder/sessions/${ids.builder}`],
      ['PATCH', `/api/v1/conversations/${ids.conversation}`, { title: 'x' }],
      ['DELETE', `/api/v1/conversations/${ids.conversation}`],
      ['POST', `/api/v1/conversations/${ids.conversation}/read`],
      // Creates in the caller's own workspace that name a W agent: each must be refused, not cross-linked.
      ['POST', '/api/v1/conversations', { agentId: world.agentId }],
      ['PUT', '/api/v1/conversations/pinned-agents', { agentIds: [world.agentId] }],
      ['POST', '/api/v1/mcp-servers', { agentId: world.agentId, name: 'ct-x', url: 'https://x.test/mcp' }],
      ['POST', '/api/v1/squads', { name: 'CTX', leaderAgentId: world.agentId }],
   ];

   test('every agent-layer resource of W answers 404 to a caller from W2, and W is unchanged', async () => {
      for (const [method, path, body] of probes()) {
         const res = await call(app, world.outsiderToken, method, path, body);
         assert.equal(res.status, 404, `${method} ${path}`);
      }
      const [skill] = await sql`SELECT description FROM skills WHERE id = ${ids.skill}`;
      assert.notEqual(skill?.description, 'x');
      const [mcp] = await sql`SELECT enabled FROM mcp_servers WHERE id = ${ids.mcp}`;
      assert.equal(mcp?.enabled, true);
      const [squad] = await sql`SELECT archived_at, name FROM squads WHERE id = ${ids.squad}`;
      assert.equal(squad?.archived_at, null);
      assert.equal(squad?.name, 'CT');
      const [builder] = await sql`SELECT status FROM agent_builder_sessions WHERE id = ${ids.builder}`;
      assert.equal(builder?.status, 'drafting');
      const [conversation] = await sql`SELECT id FROM conversations WHERE id = ${ids.conversation}`;
      assert.ok(conversation);
      const [agent] = await sql`SELECT archived_at FROM agents WHERE id = ${world.agentId}`;
      assert.equal(agent?.archived_at, null);
      const [crossLinked] = await sql`
         SELECT (SELECT count(*) FROM mcp_servers WHERE agent_id = ${world.agentId} AND workspace_id = ${world.otherWorkspaceId})
              + (SELECT count(*) FROM squads WHERE leader_agent_id = ${world.agentId} AND workspace_id = ${world.otherWorkspaceId})
              + (SELECT count(*) FROM user_pinned_agents WHERE agent_id = ${world.agentId} AND user_id = ${world.outsiderId}) AS n`;
      assert.equal(Number(crossLinked?.n), 0);
   });

   test('W2’s listings contain nothing of W', async () => {
      for (const path of ['/api/v1/skills', '/api/v1/mcp-servers', '/api/v1/squads', '/api/v1/conversations']) {
         const res = await call(app, world.outsiderToken, 'GET', path);
         assert.deepEqual(res.body.nodes, [], path);
      }
   });

   test('an unauthenticated caller is refused before any handler', async () => {
      for (const path of ['/api/v1/skills', '/api/v1/mcp-servers', '/api/v1/squads', '/api/v1/agent-builder/sessions']) {
         const res = await app.request(path);
         assert.equal(res.status, 401, path);
      }
   });
```

(`GET /api/v1/squads` returns `{ nodes }`, as the skills and MCP listings do.)

- [ ] **Step 2: Run it and confirm it fails or passes for the right reason**

Run: `cd /Users/secret/Code/berry-circle/server-ts && BERRY_TEST_DATABASE_URL=… node --test --experimental-strip-types src/mounts/agent-layer.cross-tenant.test.ts`
Expected: PASS once Tasks 2–11 are in. Any 200 or 403 in the probe list is a leak to fix in that mount before continuing: a 403 reveals that the resource exists.

- [ ] **Step 3: Wire `index.ts`**

In `server-ts/src/index.ts`, after `const idempotency = new IdempotencyStore(sql);` and the `connections` block, add:

```ts
// One sealer for agent-layer secrets (MCP headers, agent env). Without the key
// it refuses every seal, so nothing can be stored in the clear by accident.
const agentSealer = config.integrationKey
   ? sealerFromKey(config.integrationKey)
   : unavailableSealer('INTEGRATION_ENCRYPTION_KEY is not set');
const skillRepository = new SkillRepository(sql);
const mcpRepository = new McpServerRepository({ sql, sealer: agentSealer });
const agentProfiles = new AgentProfileRepository({ sql, sealer: agentSealer });
const squadRepository = new SquadRepository(sql);
```

Then:
- `issueMounts({ …, agentAccess: agentAccessGuard(sql) })`
- replace the `agentMounts(…)` call with `agentMounts({ sessions, agents, idempotency, catalog: modelCatalog, logger, runs: runOptions.runs, ledger: runOptions.ledger, profile: agentProfiles })`
- register:

```ts
registry.registerAll(
   skillMounts({
      sessions, sql, skills: skillRepository, idempotency,
      importer: { fromGitHub: (url) => importFromGitHub(url) },
   })
);
registry.registerAll(mcpServerMounts({ sessions, sql, servers: mcpRepository }));
registry.registerAll(
   squadMounts({ sessions, sql, squads: squadRepository, issues, enqueue: null, agentAccess: agentAccessGuard(sql) })
);
registry.registerAll(
   agentBuilderMounts({
      sessions, sql,
      builder: new AgentBuilder({ sql, complete: null, skills: skillRepository, agents, mcp: mcpRepository }),
   })
);
```

Add the matching imports and `unavailableSealer` to the existing `sealing.ts` import. Add `/api/v1/agent-builder`, `/api/v1/mcp-servers`, `/api/v1/skills` and `/api/v1/squads` to the "Served" block in `server-ts/SCOPE.md`, in alphabetical position.

- [ ] **Step 4: Run the full gates**

Run: `cd /Users/secret/Code/berry-circle/server-ts && pnpm typecheck && pnpm test && BERRY_TEST_DATABASE_URL=… pnpm test`
Expected: PASS. The registry refuses overlapping prefixes at startup, so `node --experimental-strip-types src/index.ts` must boot. Check that with `pnpm dev` against the Compose DB and confirm `GET /api/v1/skills` answers 401 without a session.

- [ ] **Step 5: Commit**

```bash
git add server-ts/src/index.ts server-ts/SCOPE.md server-ts/src/mounts/agent-layer.cross-tenant.test.ts
git commit -m "feat(server-ts): serve skills, MCP servers, squads and the agent builder"
```

---

### Task 13: Plug into workstream A — queue, completions, envelope, container, agent tools

**Run only after A is merged into `feat/multica-parity`.** First confirm A's exports:
`grep -n "export async function enqueueTask\|export function enqueueTask" server-ts/src/runs/queue.ts`,
`grep -n "export.*runCompletion" server-ts/src/runtime/completion.ts`,
`grep -n "export.*registerAgentTool" server-ts/src/runtime/agent-tools/registry.ts`,
`grep -rn "taskEnvelopeSchema.parse\|satisfies TaskEnvelope\|: TaskEnvelope =" server-ts/src server-ts/sandbox`.
If any is missing, stop and report which one. Do not recreate A's code here.

**Files:**
- Modify: `server-ts/src/index.ts`; A's envelope builder (the file the last grep finds under `server-ts/src/runtime/`); A's container entry under `server-ts/sandbox/agentcore/` (the file that builds the Strands `Agent` from an envelope); `server-ts/src/runs/repository.ts` (`RUN_SOURCE` → `LEFT JOIN boards` if A made `runs.board_id` nullable)
- Create: `server-ts/src/squads/delegate-tool.ts`, `server-ts/src/squads/delegate-tool.test.ts`, `server-ts/src/runtime/envelope.extensions.test.ts`
- Modify (inside A's marked chat-guard block only): `server-ts/src/runs/queue.ts`, `server-ts/src/runs/queue.test.ts`, `server-ts/src/runs/dispatcher.ts` (`#claim` predicate); `server-ts/src/conversations/chat-tasks.ts` (drop `setActiveRun`); `server-ts/src/squads/retrigger.ts` (`parent_id` when B's column exists)

**Interfaces:**
- Consumes: `enqueueTask`, `runCompletion`, `registerAgentTool(name, def)`, `TaskEnvelope`/`taskEnvelopeSchema` (A), `loadAgentExtensions` (Task 9), `writeSkills`/`loadMcpClients` (Task 9), `registerChatReplies` (Task 11), `registerSquadRetrigger`/`delegateToMember` (Task 7), `commentTriggers` (Task 8).
- Produces: a running product. Chat messages, mentions and squad assignments enqueue tasks. The envelope carries `agent.skills`, `agent.mcpServers`, env and the squad briefing. The container writes skills and connects MCP servers. Leaders get a `delegate_to_member` tool.

- [ ] **Step 1: Write the failing envelope test**

`server-ts/src/runtime/envelope.extensions.test.ts`: build an envelope through A's builder for the fixture world's agent, with one enabled skill and one MCP server (using the same setup as Task 9's test), then assert:

```ts
   const envelope = taskEnvelopeSchema.parse(built);
   assert.deepEqual(envelope.agent.skills.map((s) => s.name), ['ext-skill']);
   // SKILL.md survives the parse: A's skillRefSchema keeps only name and files.
   assert.ok(envelope.agent.skills[0]?.files.some((f) => f.path === 'SKILL.md'));
   assert.deepEqual(envelope.agent.mcpServers.map((s) => [s.name, s.transport]), [['direct', 'http']]);
   // A satisfied-by-type check that D's shapes are A's shapes, not a mapping:
   const skillRef: SkillRef = {} as EnvelopeSkill;
   const mcpRef: McpServerRef = {} as EnvelopeMcpServer;
   void skillRef;
   void mcpRef;
```

(`SkillRef`/`McpServerRef` are exported by A's `runtime/envelope.ts`, and `EnvelopeSkill`/`EnvelopeMcpServer` come from `agents/extensions.ts`. The two assignments fail `pnpm typecheck` if the shapes drift.)

Also assert that `JSON.stringify(await someListingResponse)` never contains the env value or the header value. That repeats the Task 4 and 6 guarantees at the envelope seam.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd /Users/secret/Code/berry-circle/server-ts && BERRY_TEST_DATABASE_URL=… node --test --experimental-strip-types src/runtime/envelope.extensions.test.ts`
Expected: FAIL, with empty `skills` and `mcpServers`.

- [ ] **Step 3: Fill the envelope**

In A's envelope builder, where `agent: { instructions, model, skills, mcpServers, permissions }` is assembled, call:

```ts
      const extensions = await loadAgentExtensions(
         { sql, skills: skillRepository, mcp: mcpRepository, profile: agentProfiles, gateway: gatewayRoute },
         { workspaceId: task.workspaceId, agentId: task.agentId, issueId: task.issueId ?? null }
      );
      // skills / mcpServers straight in; env into the envelope's env slot A defines
      // (runtime profile env is merged first, the agent's own env wins on a clash);
      // the squad briefing is appended to the instructions, fenced as Berry text.
```

The builder receives `skillRepository`, `mcpRepository` and `agentProfiles` from `index.ts`. `gatewayRoute` is `config.agentCoreGateway ? { url: config.agentCoreGateway.gatewayUrl, headers: () => identity.gatewayHeaders() } : null`, where `identity` is `new AgentCoreIdentity({ region, providerName, workloadName })` built exactly as `agentcore/bootstrap.ts` builds it. `EnvelopeSkill`/`EnvelopeMcpServer` are A's `SkillRef`/`McpServerRef` field for field, so no mapping is needed. If A's merged schema changed after this plan, stop and reconcile the Task 9 types rather than map silently. Do not edit A's schema. Log `extensions.skipped` with `logger.warn('mcp server skipped: no gateway', { names })`; names only, never URLs with credentials or header values. `redactEnvelope` (A) already redacts MCP header values and env; do not log the envelope any other way.

- [ ] **Step 4: Container side**

In A's container entry, before the Strands `Agent` is constructed for an envelope:

```ts
import { writeSkills } from '../../src/agents/runtime/skill-files.ts';
import { loadMcpClients } from '../../src/agents/runtime/mcp-clients.ts';

   await writeSkills(workspaceRoot, envelope.agent.skills);
   const mcpClients = await loadMcpClients(envelope.agent.mcpServers);
   // pass `mcpClients` into the Agent's tools alongside Berry and shell tools
```

The relative import paths follow however A's Dockerfile copies `src/agents/runtime` (spec §2.1). If A copies the directory to another location, use A's existing import style for `agent.ts`. On a warm session (the same `runtimeSessionId`), skip `writeSkills` when the skill tree is unchanged: compare `JSON.stringify(envelope.agent.skills)` with the value stored on the session state.

- [ ] **Step 5a: Chat session guard (spec §2.2a, left to D by A)**

A's `enqueueTask` carries the comment `// Chat guard (workstream D): …`. Spec §2.2a requires that two runs never share a chat session at once. Spec §5 also requires that chat can queue several tasks and that queued ones can be cancelled and prioritised. So the guard **serializes** runs rather than refusing them:

1. In the marked block, when `input.chatSessionId` is set: `SELECT id, active_run_id FROM conversations WHERE id = ${input.chatSessionId} AND workspace_id = ${input.workspaceId} FOR UPDATE`. When there is no row, throw `NotFound`: a chat task for another workspace's session is refused.
2. After the insert: `UPDATE conversations SET active_run_id = ${runId} WHERE id = ${input.chatSessionId} AND active_run_id IS NULL`.
3. In A's dispatcher claim query (`#claim`), add the predicate `AND (r.chat_session_id IS NULL OR NOT EXISTS (SELECT 1 FROM runs o WHERE o.chat_session_id = r.chat_session_id AND o.status = 'running'))`, so a session's second queued task waits for the first one to end.
4. `sendChatMessage` (Task 11) no longer calls `setActiveRun`, because the guard now owns it. Delete that line and the `setActiveRun` method. `appendAgentReply` advances `active_run_id` to the next queued run (Task 11).

Test in A's `queue.test.ts` (append): two `enqueueTask` calls for one chat session both succeed; the first run's id becomes `active_run_id`; the dispatcher claims only the first; after it succeeds, the second is claimable. A chat session id from another workspace throws `NotFound`. This touches A's files after A has merged, inside the block A marked for D. Note it in the commit body.

- [ ] **Step 5b: Delegation tool on A's tool registry**

`server-ts/src/squads/delegate-tool.ts`:

```ts
import { z } from 'zod';
import type { IssueRepository } from '../core/issues.ts';
import type { Sql } from '../db/pool.ts';
import type { AgentToolDefinition } from '../runtime/agent-tools/registry.ts';
import { delegateToMember } from './retrigger.ts';

const input = z.object({
   memberId: z.string().uuid(),
   title: z.string().trim().min(1).max(500),
   description: z.string().max(20_000).default(''),
});

/**
 * `delegate_to_member`: only the leader of the squad that owns the task's issue
 * may call it, and only for an agent member of that squad (delegateToMember
 * enforces the latter). Everything else is a tool error, never a created issue.
 */
export function delegateTool(deps: { sql: Sql; issues: IssueRepository }): AgentToolDefinition<typeof input> {
   return {
      description: 'Create a sub-issue assigned to an agent member of your squad.',
      scope: 'task:write',
      inputSchema: input,
      async handler(context, args) {
         const { workspaceId, issueId, agentId } = context.task;
         if (!issueId) throw new Error('delegation needs a task on an issue');
         const [lead] = await deps.sql`
            SELECT 1 FROM issue_squads i JOIN squads s ON s.id = i.squad_id AND s.archived_at IS NULL
             WHERE i.issue_id = ${issueId} AND s.workspace_id = ${workspaceId} AND s.leader_agent_id = ${agentId}`;
         if (!lead) throw new Error('only the squad leader may delegate');
         return delegateToMember(deps, {
            workspaceId,
            parentIssueId: issueId,
            memberAgentId: args.memberId,
            title: args.title,
            description: args.description,
         });
      },
   };
}
```

The field names follow A's `AgentToolDefinition<S extends z.ZodObject> { description; scope: TaskScope; inputSchema: S; handler(context: AgentToolContext, input: z.output<S>) }` (A plan, Task 6). `context.task` is A's `TaskClaims`: `{ workspaceId, agentId, issueId: string | null, … }`. If A's merged registry differs, rename the fields here; the checks stay. Add `server-ts/src/squads/delegate-tool.test.ts`: the leader's context gets a created child issue, and a member agent's context (or a context from another workspace) gets the refusal.

When B's `issues.parent_id` column exists (`SELECT 1 FROM information_schema.columns WHERE table_name = 'issues' AND column_name = 'parent_id'`), `delegateToMember` also sets `parent_id = parentIssueId` on the child. That makes a delegation a real sub-issue in B's tree, and B's stage gate and child progress then see it. Add that `UPDATE` in `retrigger.ts` behind the column check, and assert it in `retrigger.test.ts` when the column is present.

- [ ] **Step 5: Server wiring**

In `server-ts/src/index.ts`:

```ts
import { enqueueTask } from './runs/queue.ts';
import { runCompletion } from './runtime/completion.ts';
import { registerAgentTool } from './runtime/agent-tools/registry.ts';

const enqueue: EnqueueTask = enqueueTask;               // compile-time proof the shapes agree
const complete: CompleteFn = (request) => runCompletion(runtimeDeps, request);
```

`runtimeDeps` is whatever A's `index.ts` already passes as the first argument of `runCompletion`.

Then:
- `squadMounts({ …, enqueue })`, `new AgentBuilder({ …, complete })`, and `conversationMounts({ …, enqueue, complete })`.
- `const commentOptions = { …, triggers: commentTriggers({ sql, enqueue, report: (e) => logger.error('comment trigger failed', { error: String(e) }) }) }`.
- `registerChatReplies({ sql, conversations: conversationRepository, report })` and `registerSquadRetrigger({ sql, enqueue, report })`, once, at startup.
- `registerAgentTool('delegate_to_member', delegateTool({ sql, issues }))`, using the definition from Step 5b. It returns `{ issueId, identifier }`.
- `squadMounts` keeps `agentAccess: agentAccessGuard(sql)`.
- `autoDispatch` in the issues mount is left alone. A decides whether `enqueueTask(source: 'assignment')` replaces `runs.admit`, and D does not touch it.

- [ ] **Step 6: Run and confirm everything passes**

Run: `cd /Users/secret/Code/berry-circle/server-ts && pnpm typecheck && BERRY_TEST_DATABASE_URL=… pnpm test`
Expected: PASS, including the previously gated chat-task assertions in `conversations.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add server-ts/src server-ts/sandbox
git commit -m "feat(server-ts): run chat, mentions and squads on the runtime and carry skills and MCP into tasks"
```

---
## Frontend tasks

Every frontend task follows the same rules: Prettier 3-space and single quotes, Zod v3 schemas in `lib/*.ts`, calls through `apiFetch`, `sonner` toasts for failures, and semantic tokens (`text-muted-foreground`, `border-border`, the `--shell-*` variables in chat). No test runner exists yet, so each task's check is `cd /Users/secret/Code/berry-circle/frontend && pnpm lint && pnpm build:check`, plus a manual pass with `pnpm dev` against the running server.

### Task 14: Skills pages and rail entry

**Files:**
- Create: `frontend/lib/skills.ts`, `frontend/app/[orgId]/skills/page.tsx`, `frontend/app/[orgId]/skills/[skillId]/page.tsx`, `frontend/components/common/skills/skills-list.tsx`, `frontend/components/common/skills/skill-detail.tsx`, `frontend/components/common/skills/skill-import-dialog.tsx`
- Modify: `frontend/components/layout/shell/shell-routes.ts` (add `'skills'` to `ShellRoute` and a `MANAGE` entry after `members`), `frontend/store/sidebar-prefs-store.ts` (add `'skills'` to `SidebarItemKey`, `DEFAULT_VISIBILITY` and `DEFAULT_ORDER.configure` after `'agents'`), `frontend/components/layout/sidebar/customize-sidebar-dialog.tsx` (one item `{ key: 'skills', label: 'skills', icon: BookOpen }`)

**Interfaces:**
- Consumes: Task 2 and 3 routes.
- Produces: `/{orgId}/skills` and `/{orgId}/skills/{skillId}`, which I's `searchResultHref('skill')` targets.
  - `lib/skills.ts` exports `skillSchema`, `type Skill`, `listSkills(params?: { q?: string; label?: string; agentId?: string })`, `getSkill(id)`, `createSkill(input)`, `updateSkill(id, patch)`, `deleteSkill(id)`, `importSkillFromUrl(url)`, `importSkillZip(file: File)`, `refreshSkill(id)` and `setSkillForAgent(skillId, agentId, enabled: boolean | null)`, where `null` removes the binding.

- [ ] **Step 1: Client module**

`frontend/lib/skills.ts`:

```ts
import { z } from 'zod';
import { apiFetch } from './api';

const fileSchema = z.object({ path: z.string(), size: z.number(), content: z.string().optional() });

export const skillSchema = z.object({
   id: z.string(),
   name: z.string(),
   description: z.string(),
   content: z.string(),
   labels: z.array(z.string()),
   source: z.object({
      kind: z.enum(['manual', 'github', 'zip']),
      url: z.string().nullable(),
      ref: z.string().nullable(),
      importedAt: z.string().nullable(),
   }),
   files: z.array(fileSchema),
   agentEnabled: z.boolean().nullable().optional(),
   createdAt: z.string(),
   updatedAt: z.string(),
});
export type Skill = z.infer<typeof skillSchema>;

export interface SkillInput {
   name: string;
   description: string;
   content: string;
   labels: string[];
   files: { path: string; content: string }[];
}

function parse(json: unknown): Skill {
   const parsed = skillSchema.safeParse(json);
   if (!parsed.success) throw new Error('Skill response was not recognized');
   return parsed.data;
}

export async function listSkills(params: { q?: string; label?: string; agentId?: string } = {}): Promise<Skill[]> {
   const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
   const json: unknown = await apiFetch(`/api/v1/skills${query.size ? `?${query}` : ''}`);
   const parsed = z.object({ nodes: z.array(skillSchema) }).safeParse(json);
   if (!parsed.success) throw new Error('Skill list was not recognized');
   return parsed.data.nodes;
}

export const getSkill = async (id: string) => parse(await apiFetch(`/api/v1/skills/${encodeURIComponent(id)}`));

export const createSkill = async (input: SkillInput) =>
   parse(await apiFetch('/api/v1/skills', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify(input),
   }));

export const updateSkill = async (id: string, patch: Partial<SkillInput>) =>
   parse(await apiFetch(`/api/v1/skills/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }));

export async function deleteSkill(id: string): Promise<void> {
   await apiFetch(`/api/v1/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export const importSkillFromUrl = async (url: string) =>
   parse(await apiFetch('/api/v1/skills/import', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ url }),
   }));

export const importSkillZip = async (file: File) =>
   parse(await apiFetch('/api/v1/skills/import/zip', {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: file,
   }));

export const refreshSkill = async (id: string) =>
   parse(await apiFetch(`/api/v1/skills/${encodeURIComponent(id)}/refresh`, { method: 'POST' }));

export async function setSkillForAgent(skillId: string, agentId: string, enabled: boolean | null): Promise<void> {
   const path = `/api/v1/skills/${encodeURIComponent(skillId)}/agents/${encodeURIComponent(agentId)}`;
   await apiFetch(path, enabled === null ? { method: 'DELETE' } : { method: 'PUT', body: JSON.stringify({ enabled }) });
}
```

(`apiFetch` sets `content-type: application/json` only when the body is a string, so the zip upload keeps `application/zip`.)

- [ ] **Step 2: Pages and components**

- `app/[orgId]/skills/page.tsx` renders `<MainLayout header={<SkillsHeader />}><SkillsList /></MainLayout>`, with a small inline header: a title "Skills", a search `Input`, "New skill" and "Import" buttons. It follows `app/[orgId]/agents/page.tsx`.
- `skills-list.tsx`: loads with `listSkills({ q })`, debounced 250 ms. The row layout matches `agent-line.tsx`: name, description, labels as chips, a source badge (GitHub / zip / manual) and the file count. A row links to `/${orgId}/skills/${id}`. When empty it shows "No skills yet. Create one, or import a folder from GitHub or a zip."
- `skill-import-dialog.tsx` is a `Dialog` with two tabs. "From GitHub" takes a URL input and calls `importSkillFromUrl`. "Upload zip" takes `<input type="file" accept=".zip,application/zip">` and calls `importSkillZip`. The server's `error.message` is shown via `BerryApiError` (the codes `SKILL_MANIFEST_MISSING`, `SKILL_TOO_LARGE` and `SKILL_URL_INVALID` carry readable messages).
- `skill-detail.tsx` has fields for name, description and labels (comma-separated input), and the content in `DescriptionTextarea` (plain text, exact bytes, per AGENTS.md). It shows a files list with path and size, where each file opens in a read-only `<pre>`. Actions are "Save" (`updateSkill`), "Refresh from GitHub" (only when `source.kind === 'github'`) and "Delete" (with an `AlertDialog` confirm, then `router.push` to the list).
- The rail entry in `shell-routes.ts`:

```ts
   {
      id: 'skills',
      label: 'skills',
      href: '/skills',
      match: ['/skills/'],
      prefsKey: 'skills',
      icon: '<path d="M5 4h10a4 4 0 014 4v12H9a4 4 0 01-4-4z" /><path d="M9 8h6M9 12h6" />',
   },
```

- [ ] **Step 3: Check**

Run: `cd /Users/secret/Code/berry-circle/frontend && pnpm lint && pnpm build:check`
Expected: both succeed. Manual check: create a skill with a file, import one from a public GitHub folder, refresh it, delete it, and confirm the rail item appears and can be hidden in "Customize sidebar".

- [ ] **Step 4: Commit**

```bash
git add frontend/lib/skills.ts frontend/app/[orgId]/skills frontend/components/common/skills \
  frontend/components/layout/shell/shell-routes.ts frontend/store/sidebar-prefs-store.ts \
  frontend/components/layout/sidebar/customize-sidebar-dialog.tsx
git commit -m "feat(frontend): add a skills catalogue page with GitHub and zip import"
```

---

### Task 15: Agent detail — skills, tools (MCP), tasks, profile and lifecycle; workspace MCP settings

**Files:**
- Create: `frontend/lib/mcp.ts`, `frontend/components/common/agents/agent-skills-tab.tsx`, `frontend/components/common/agents/agent-tools-tab.tsx`, `frontend/components/common/agents/agent-tasks-tab.tsx`, `frontend/components/common/agents/agent-profile-settings.tsx`, `frontend/app/[orgId]/settings/mcp/page.tsx`, `frontend/components/common/settings/mcp-servers.tsx`
- Modify: `frontend/lib/agents.ts`, `frontend/components/common/agents/agent-details.tsx` (`DETAIL_TABS` and the tab contents), `frontend/components/layout/sidebar/nav-settings.tsx` (one workspace item `{ name: 'MCP servers', url: '/settings/mcp', icon: Plug }`)

**Interfaces:**
- Consumes: Task 4, 5 and 6 routes; `listSkills({ agentId })` and `setSkillForAgent` (Task 14).
- Produces:
  - `lib/agents.ts` additions:
    - `agentSchema` gains `labels: z.array(z.string()).default([])`, `envNames: z.array(z.string()).default([])`, `access: z.object({ assign: z.string(), mention: z.string() }).optional()`, `systemRole: z.string().nullish()` and `archivedAt: z.string().nullish()`.
    - `loadArchivedAgents()`, `restoreAgent(id)`, `copyAgent(id)`, `archiveAgent(id)`, `cancelAgentTasks(id): Promise<number>`, `listAgentTasks(id, after?)`, `setAgentLabels(id, labels)`, `setAgentEnv(id, env): Promise<string[]>`, `uploadAgentAvatar(id, file: File)`, `getAgentAccess(id)`, `setAgentAccess(id, access)` and `getGuideAgent(): Promise<Agent | null>`.
  - `lib/mcp.ts` exports `mcpServerSchema`, `type McpServer`, `listMcpServers(agentId?: string | 'workspace')`, `createMcpServer(input)`, `updateMcpServer(id, patch)` and `deleteMcpServer(id)`.
  - `DETAIL_TABS = ['overview', 'work', 'skills', 'tools', 'tasks', 'model', 'settings'] as const`

- [ ] **Step 1: Client additions**

Append to `frontend/lib/agents.ts` (and extend `agentSchema` as listed):

```ts
const runNodeSchema = z.object({
   id: z.string(),
   status: z.string(),
   issueId: z.string().nullish(),
   createdAt: z.string(),
   completedAt: z.string().nullish(),
});
export type AgentTask = z.infer<typeof runNodeSchema>;

const parseAgent = (json: unknown): Agent => {
   const parsed = agentSchema.safeParse(json);
   if (!parsed.success) throw new Error('Agent response was not recognized');
   return parsed.data;
};
const agentPath = (id: string, rest = '') => `/api/v1/agents/${encodeURIComponent(id)}${rest}`;

export async function loadArchivedAgents(): Promise<Agent[]> {
   const json: unknown = await apiFetch('/api/v1/agents?archived=true&first=100');
   const parsed = agentConnectionSchema.safeParse(json);
   if (!parsed.success) throw new Error('Agent list was not recognized');
   return parsed.data.nodes;
}
export const restoreAgent = async (id: string) => parseAgent(await apiFetch(agentPath(id, '/restore'), { method: 'POST' }));
export const copyAgent = async (id: string) =>
   parseAgent(await apiFetch(agentPath(id, '/copy'), { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() } }));
export async function archiveAgent(id: string): Promise<void> {
   await apiFetch(agentPath(id), { method: 'DELETE' });
}
export async function cancelAgentTasks(id: string): Promise<number> {
   const json: unknown = await apiFetch(agentPath(id, '/cancel-tasks'), { method: 'POST' });
   return z.object({ cancelled: z.number() }).parse(json).cancelled;
}
export async function listAgentTasks(id: string, after?: string) {
   const json: unknown = await apiFetch(agentPath(id, `/tasks?first=50${after ? `&after=${encodeURIComponent(after)}` : ''}`));
   return connectionSchema(runNodeSchema).parse(json);
}
export const setAgentLabels = async (id: string, labels: string[]) =>
   parseAgent(await apiFetch(agentPath(id, '/labels'), { method: 'PUT', body: JSON.stringify({ labels }) }));
export async function setAgentEnv(id: string, env: Record<string, string>): Promise<string[]> {
   const json: unknown = await apiFetch(agentPath(id, '/env'), { method: 'PUT', body: JSON.stringify({ env }) });
   return z.object({ envNames: z.array(z.string()) }).parse(json).envNames;
}
export const uploadAgentAvatar = async (id: string, file: File) =>
   parseAgent(await apiFetch(agentPath(id, '/avatar'), { method: 'PUT', headers: { 'content-type': file.type }, body: file }));

export const agentAccessSchema = z.object({
   assign: z.enum(['everyone', 'admins', 'listed']),
   mention: z.enum(['everyone', 'admins', 'listed']),
   members: z.array(z.string()),
});
export type AgentAccess = z.infer<typeof agentAccessSchema>;
export const getAgentAccess = async (id: string) => agentAccessSchema.parse(await apiFetch(agentPath(id, '/access')));
export const setAgentAccess = async (id: string, access: AgentAccess) =>
   parseAgent(await apiFetch(agentPath(id, '/permissions'), { method: 'PUT', body: JSON.stringify({ access }) }));
export async function getGuideAgent(): Promise<Agent | null> {
   try {
      return parseAgent(await apiFetch('/api/v1/agents/guide'));
   } catch (error) {
      if (error instanceof BerryApiError && error.status === 404) return null;
      throw error;
   }
}
```

(Import `BerryApiError` from `./api`. Check the status property name with `grep -n "class BerryApiError" -A8 frontend/lib/api.ts`.)

`frontend/lib/mcp.ts` follows the same pattern for `/api/v1/mcp-servers`. Its schema is `{ id, agentId: string | null, name, url, transport: 'streamable_http' | 'sse', headerNames: string[], viaGateway: boolean, enabled: boolean, createdAt, updatedAt }`. The input type is `{ agentId: string | null; name; url; transport; headers: Record<string, string>; viaGateway; enabled }`.

- [ ] **Step 2: Components**

- `agent-skills-tab.tsx` shows `listSkills({ agentId })` rows with a `Switch`. Toggling calls `setSkillForAgent(skill.id, agentId, checked)` with an optimistic flip and a revert plus toast on failure. A row whose `agentEnabled` is null shows the switch off. It links to `/${orgId}/skills` to manage the catalogue.
- `agent-tools-tab.tsx` has two lists. "Workspace servers" (`listMcpServers('workspace')`) is read-only, with a note "Managed in Settings → MCP servers". "This agent's servers" (`listMcpServers(agentId)`) has an add form: name, URL, a transport `Select`, header rows (name + a password `Input`), a "Route through AgentCore Gateway" `Switch`, and enabled. Existing headers show as names with "••••" and a "Replace headers" action; the UI never displays stored values, because it never receives them.
- `agent-tasks-tab.tsx` shows `listAgentTasks` with status icons (reuse `RunStatusIcon` from `agent-details.tsx` by exporting it), a link to the issue when `issueId` is present, "Load more" via `endCursor`, and a "Cancel all queued and running tasks" button → `cancelAgentTasks` → toast "Cancelled N tasks".
- `agent-profile-settings.tsx` is rendered inside the existing `settings` tab after the two `AgentConfigField`s. It has:
  - avatar upload (`<input type="file" accept="image/png,image/jpeg,image/webp,image/gif">` → `uploadAgentAvatar`, previewing `agent.avatarUrl`). The API authenticates with a Bearer header only (`server-ts/src/auth/middleware.ts`), and a relative `/api/v1/...` URL resolves against the Next origin. So an `<img src={agent.avatarUrl}>` for a Berry-served avatar (one starting with `/api/v1/agents/`) would 401 or 404. Add `useAgentAvatarSrc(avatarUrl)` in `frontend/lib/agents.ts`: an `https?://` URL is returned as is; a Berry path is fetched once through `apiFetch` as a blob, turned into `URL.createObjectURL` (revoked on unmount), and cached by URL (the `?v=` changes on each upload). Use it wherever an agent avatar renders (agent-line, agent-details, this preview).
  - labels (a chip input → `setAgentLabels`)
  - environment variables: the list shows `envNames`, and the edit dialog holds name/value rows. Saving calls `setAgentEnv` with the **full** set. The copy says "Values are encrypted and can't be viewed again. Saving replaces every variable." Blank value fields for existing names are not allowed, so the UI requires re-entering them.
  - access: two `Select`s (assign / mention: Everyone / Admins only / Listed members), plus a member multi-select from `lib/members.ts` when either is "listed" → `setAgentAccess`
  - lifecycle: "Duplicate" (`copyAgent` → navigate to the copy), "Archive" (`archiveAgent`, confirm; disabled for the protected orchestrator, identified by `capabilities` including `orchestrate`, the same heuristic the list uses), and, when `agent.archivedAt`, a "Restore" banner.
- `agent-details.tsx`: extend `DETAIL_TABS` and add `<TabsContent value="skills">`, `"tools"` and `"tasks"` rendering the three new components with `agentId={agent.id}`. Render `<AgentProfileSettings agent={agent} onChange={…} />` at the end of the settings tab, where `onChange` re-hydrates `useAgentsStore`.
- `components/common/agents/agents.tsx`: add a "Show archived" toggle to `header-options.tsx` (via `useAgentsListStore`, adding `showArchived` + `setShowArchived` to that store). When on, the list loads `loadArchivedAgents()`.
- `settings/mcp/page.tsx` + `mcp-servers.tsx` provide the same add/edit/delete UI as the tools tab, for `agentId: null` servers. They are admin-only: on a 403 from a write, show "Only workspace admins can change MCP servers" and render read-only.

- [ ] **Step 3: Check**

Run: `cd /Users/secret/Code/berry-circle/frontend && pnpm lint && pnpm build:check`
Expected: both succeed. Manual check: toggle a skill on an agent; add an agent MCP server with a header and reload (only the name shows); set env and confirm the values never reappear; upload an avatar and see it in the agents list; archive, show archived, restore; duplicate; cancel tasks.

- [ ] **Step 4: Commit**

```bash
git add frontend/lib/agents.ts frontend/lib/mcp.ts frontend/components/common/agents frontend/components/common/settings/mcp-servers.tsx \
  frontend/app/[orgId]/settings/mcp frontend/components/layout/sidebar/nav-settings.tsx frontend/components/layout/headers/agents \
  frontend/store/agents-list-store.ts
git commit -m "feat(frontend): manage an agent's skills, MCP servers, tasks, env, avatar and access"
```

---

### Task 16: New agent — manual form and AI builder

**Files:**
- Create: `frontend/lib/agent-builder.ts`, `frontend/app/[orgId]/agents/new/page.tsx`, `frontend/components/common/agents/new-agent-manual.tsx`, `frontend/components/common/agents/new-agent-builder.tsx`
- Modify: `frontend/lib/agents.ts` (`createAgent`), `frontend/components/layout/headers/agents/header-options.tsx` (a "New agent" `Link` button)

**Interfaces:**
- Consumes: `POST /api/v1/agents` (existing: `{ name, description?, instructions?, provider?, model?, skills?, avatarUrl? }`, idempotent); Task 10 routes; `listAgentModels` (existing); `listSkills` (Task 14).
- Produces: `createAgent(input): Promise<Agent>`. `lib/agent-builder.ts` exports `agentDraftSchema`, `type AgentDraft`, `startBuilderSession(): Promise<{ id: string }>`, `getBuilderSession(id)`, `sendBuilderTurn(id, prompt): Promise<{ draftId: string; draft: AgentDraft; unknownSkills: string[] }>`, `applyBuilderDraft(id, draftId): Promise<{ agentId: string }>` and `discardBuilderSession(id)`.

- [ ] **Step 1: Client**

`frontend/lib/agent-builder.ts`:

```ts
import { z } from 'zod';
import { apiFetch } from './api';

export const agentDraftSchema = z.object({
   name: z.string(),
   description: z.string(),
   instructions: z.string(),
   skills: z.array(z.string()),
   mcp: z.array(z.object({ name: z.string(), url: z.string(), transport: z.enum(['streamable_http', 'sse']) })),
   model: z.string().nullable(),
});
export type AgentDraft = z.infer<typeof agentDraftSchema>;

const base = '/api/v1/agent-builder/sessions';

export async function startBuilderSession(): Promise<{ id: string }> {
   const json: unknown = await apiFetch(base, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() } });
   return z.object({ id: z.string() }).parse(json);
}

export async function getBuilderSession(id: string) {
   const json: unknown = await apiFetch(`${base}/${encodeURIComponent(id)}`);
   return z
      .object({
         id: z.string(),
         status: z.enum(['drafting', 'applied', 'discarded']),
         appliedAgentId: z.string().nullable(),
         drafts: z.array(z.object({ id: z.string(), turn: z.number(), prompt: z.string(), draft: agentDraftSchema })),
      })
      .parse(json);
}

export async function sendBuilderTurn(id: string, prompt: string) {
   const json: unknown = await apiFetch(`${base}/${encodeURIComponent(id)}/turns`, {
      method: 'POST',
      body: JSON.stringify({ prompt }),
   });
   return z.object({ draftId: z.string(), draft: agentDraftSchema, unknownSkills: z.array(z.string()) }).parse(json);
}

export async function applyBuilderDraft(id: string, draftId: string): Promise<{ agentId: string }> {
   const json: unknown = await apiFetch(`${base}/${encodeURIComponent(id)}/apply`, {
      method: 'POST',
      body: JSON.stringify({ draftId }),
   });
   return z.object({ agentId: z.string() }).parse(json);
}

export async function discardBuilderSession(id: string): Promise<void> {
   await apiFetch(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
```

Add to `lib/agents.ts`:

```ts
export async function createAgent(input: {
   name: string;
   description?: string;
   instructions?: string;
   provider?: string;
   model?: string;
}): Promise<Agent> {
   const json: unknown = await apiFetch('/api/v1/agents', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify(input),
   });
   const parsed = agentSchema.safeParse(json);
   if (!parsed.success) throw new Error('Agent response was not recognized');
   return parsed.data;
}
```

- [ ] **Step 2: Page and components**

- `app/[orgId]/agents/new/page.tsx` renders `MainLayout` with `Tabs` "Describe it" (builder, the default) and "Set it up yourself" (manual).
- `new-agent-manual.tsx` is a `react-hook-form` + `zodResolver` form. Its schema is `z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(5000), instructions: z.string().max(20000), model: z.string().optional() })`, with the model chosen from `AgentModelPicker` (existing component, which gives provider + model). On submit it calls `createAgent`, then `router.push(`/${orgId}/agents/${agent.id}`)`. A 503 `MODEL_CATALOG_UNAVAILABLE` hides the model field instead of failing.
- `new-agent-builder.tsx`:
  - Left: a prompt `Textarea` + "Draft" button → `startBuilderSession` (once) then `sendBuilderTurn`. The list of turns shows each turn's prompt, and clicking one previews that draft.
  - Right: a **preview** card with name, description, instructions (in `<pre className="whitespace-pre-wrap">`), skills as chips (unknown ones struck through, with the note "not in this workspace — will be skipped"), MCP servers, and the suggested model as a hint ("set it on the Model tab after creating").
  - Buttons: "Create agent" → `applyBuilderDraft(sessionId, selectedDraftId)` → navigate to the new agent's page; "Start over" → `discardBuilderSession`.
  - A 503 `AGENT_BUILDER_UNAVAILABLE` shows "The AI builder needs the agent runtime. Use 'Set it up yourself'." and switches tabs.
  - A 403 `MCP_SETTINGS_REQUIRED` on "Create agent" shows "This draft adds MCP servers, which only workspace admins can add. Ask the builder to drop them, or ask an admin." The session stays open, so the person can send another turn.
- `header-options.tsx` adds `<Button size="xs" asChild><Link href={`/${orgId}/agents/new`}>New agent</Link></Button>` (using `useParams` for `orgId`).

- [ ] **Step 3: Check**

Run: `cd /Users/secret/Code/berry-circle/frontend && pnpm lint && pnpm build:check`
Expected: both succeed. Manual check: create an agent manually, draft one with two turns, preview the first draft, apply it, and land on the new agent with its skill enabled.

- [ ] **Step 4: Commit**

```bash
git add frontend/lib/agent-builder.ts frontend/lib/agents.ts frontend/app/[orgId]/agents/new \
  frontend/components/common/agents/new-agent-manual.tsx frontend/components/common/agents/new-agent-builder.tsx \
  frontend/components/layout/headers/agents/header-options.tsx
git commit -m "feat(frontend): create agents by hand or by describing them to the builder"
```

---
### Task 17: Squads pages, rail entry, and assigning an issue to a squad

**Files:**
- Create: `frontend/lib/squads.ts`, `frontend/app/[orgId]/squads/page.tsx`, `frontend/app/[orgId]/squads/[squadId]/page.tsx`, `frontend/components/common/squads/squads-list.tsx`, `frontend/components/common/squads/squad-detail.tsx`
- Modify: `shell-routes.ts` (`'squads'` in `ShellRoute` and a `MANAGE` entry after `skills`), `sidebar-prefs-store.ts` (`'squads'` key, visibility, `configure` order after `'skills'`), `customize-sidebar-dialog.tsx` (`{ key: 'squads', label: 'squads', icon: UsersRound }`), and the issue assignee picker `frontend/components/layout/sidebar/create-new-issue/assignee-selector.tsx` (a "Squads" group)

**Interfaces:**
- Consumes: Task 7 routes; `loadWorkspaceAgents`; the member list from `lib/members.ts`.
- Produces: `lib/squads.ts` exports `squadSchema`, `type Squad`, `listSquads()`, `getSquad(id)`, `createSquad({ name, description, leaderAgentId })`, `updateSquad(id, patch)`, `archiveSquad(id)`, `setSquadMembers(id, members: { type: 'agent' | 'user'; id: string; role: string }[])` and `assignIssueToSquad(squadId, issueRef): Promise<{ issueId: string; leaderAgentId: string; runId: string | null }>`.

- [ ] **Step 1: Client**

`frontend/lib/squads.ts`:

```ts
import { z } from 'zod';
import { apiFetch } from './api';

export const squadSchema = z.object({
   id: z.string(),
   name: z.string(),
   description: z.string(),
   leaderAgentId: z.string(),
   members: z.array(z.object({ type: z.enum(['agent', 'user']), id: z.string(), name: z.string(), role: z.string() })),
   archivedAt: z.string().nullable(),
   createdAt: z.string(),
   updatedAt: z.string(),
});
export type Squad = z.infer<typeof squadSchema>;
const path = (id = '', rest = '') => `/api/v1/squads${id ? `/${encodeURIComponent(id)}` : ''}${rest}`;

export async function listSquads(): Promise<Squad[]> {
   return z.object({ nodes: z.array(squadSchema) }).parse(await apiFetch(path())).nodes;
}
export const getSquad = async (id: string) => squadSchema.parse(await apiFetch(path(id)));
export const createSquad = async (input: { name: string; description: string; leaderAgentId: string }) =>
   squadSchema.parse(await apiFetch(path(), {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify(input),
   }));
export const updateSquad = async (id: string, patch: Partial<{ name: string; description: string; leaderAgentId: string }>) =>
   squadSchema.parse(await apiFetch(path(id), { method: 'PATCH', body: JSON.stringify(patch) }));
export async function archiveSquad(id: string): Promise<void> {
   await apiFetch(path(id), { method: 'DELETE' });
}
export const setSquadMembers = async (id: string, members: { type: 'agent' | 'user'; id: string; role: string }[]) =>
   squadSchema.parse(await apiFetch(path(id, '/members'), { method: 'PUT', body: JSON.stringify({ members }) }));
export async function assignIssueToSquad(squadId: string, issueRef: string) {
   const json: unknown = await apiFetch(path(squadId, '/assign'), { method: 'POST', body: JSON.stringify({ issueRef }) });
   return z.object({ issueId: z.string(), leaderAgentId: z.string(), runId: z.string().nullable() }).parse(json);
}
```

- [ ] **Step 2: Pages**

- `squads-list.tsx` shows name, description, the leader (agent name from `useAgentsStore`), member count, and a "New squad" dialog with name, description and a leader `Select` over live agents.
- `squad-detail.tsx` has editable name, description and leader, and a roster table: member (agent or person), a role text input and remove, plus "Add member" with a combined picker of agents and people. It saves with `setSquadMembers` (the whole roster). There is an "Assign an issue" box: an issue key or id input → `assignIssueToSquad` → toast "Assigned to <leader>; its run is queued" (or "…; it will start when runs are available" when `runId` is null). "Archive squad" has a confirm.
- `assignee-selector.tsx`: add a "Squads" group from `listSquads()`, loaded when the popover opens. Choosing one calls `assignIssueToSquad(squad.id, issue.id)` for an existing issue. In the create dialog the issue has no id yet, so choosing a squad there sets the leader agent as assignee and, after creation, calls `assignIssueToSquad`. Read the component's current `onChange` contract and keep it; the squad path runs after it.
- The rail entry icon is `'<circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3 20a6 6 0 0112 0M14 20a4.5 4.5 0 017-3.5" />'`, with `href: '/squads'` and `match: ['/squads/']`.

- [ ] **Step 3: Check**

Run: `cd /Users/secret/Code/berry-circle/frontend && pnpm lint && pnpm build:check`
Expected: both succeed. Manual check: create a squad with a leader and two members, assign an issue from the squad page and from the assignee picker, and confirm the issue shows the leader as assignee.

- [ ] **Step 4: Commit**

```bash
git add frontend/lib/squads.ts frontend/app/[orgId]/squads frontend/components/common/squads \
  frontend/components/layout/shell/shell-routes.ts frontend/store/sidebar-prefs-store.ts \
  frontend/components/layout/sidebar/customize-sidebar-dialog.tsx frontend/components/layout/sidebar/create-new-issue/assignee-selector.tsx
git commit -m "feat(frontend): add squads and let an issue be given to one"
```

---

### Task 18: Chat — sessions, task queue, drafts, suggestions, pinned agents

**Files:**
- Create: `frontend/components/common/chat/chat-sessions.tsx`, `frontend/components/common/chat/chat-tasks-panel.tsx`
- Modify: `frontend/lib/chat.ts`, `frontend/components/common/chat/chat.tsx`, `frontend/components/common/chat/chat-sidebar.tsx`, `frontend/components/common/chat/chat-thread.tsx`

**Interfaces:**
- Consumes: Task 11 routes; `subscribeWorkspaceEvents` (`lib/events.ts`) to refresh on `run.*` events; I's `?agent=` deep link (keep it working: `?agent=<id>` opens or creates that agent's latest session).
- Produces, in `lib/chat.ts`:
  - `summarySchema` gains `pinned`, `archived`, `unread`, `activeRunId` and `draft`; `messageSchema` gains `runId: z.string().nullish()`.
  - `listThreads({ archived?: boolean })`, `createSession(agentId, title?)`, `renameSession(id, title)`, `setSessionPinned(id, pinned)`, `setSessionArchived(id, archived)`, `deleteSession(id)`, `markSessionRead(id)`, `saveDraft(id, draft)`, `listMessages(id, before?)`, `listSessionTasks(id)`, `cancelSessionTask(id, runId)`, `prioritizeSessionTask(id, runId)`, `listTaskEvents(id, runId)`, `listSuggestions(agentId)`, `getPinnedAgents()` and `setPinnedAgents(ids)`.
  - `sendMessage(id, body): Promise<{ messageId: string; runId: string; queued: true }>`. The response is now 202; a 503 `AGENT_TASKS_UNAVAILABLE` surfaces as an error message.

- [ ] **Step 1: Client**

In `frontend/lib/chat.ts`, replace `SendResult`/`sendMessage` and add the functions above, each a thin `apiFetch` plus Zod v3 parse in the existing style. For example:

```ts
export async function sendMessage(conversationId: string, body: string) {
   const json: unknown = await apiFetch(`/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body }),
   });
   return z.object({ messageId: z.string(), runId: z.string(), queued: z.literal(true) }).parse(json);
}

const taskSchema = z.object({
   id: z.string(),
   status: z.enum(['queued', 'running']),
   priority: z.number(),
   createdAt: z.string(),
   startedAt: z.string().nullable(),
});
export type ChatTask = z.infer<typeof taskSchema>;

export async function listSessionTasks(conversationId: string): Promise<ChatTask[]> {
   const json: unknown = await apiFetch(`/api/v1/conversations/${encodeURIComponent(conversationId)}/tasks`);
   return z.object({ nodes: z.array(taskSchema) }).parse(json).nodes;
}

export async function saveDraft(conversationId: string, draft: string): Promise<void> {
   await apiFetch(`/api/v1/conversations/${encodeURIComponent(conversationId)}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ draft }),
   });
}
```

(The server's `GET /:id/tasks` serializer maps `created_at` → `createdAt` and `started_at` → `startedAt` with `toRFC3339`. Write it that way in Task 11 if it is not already.)

- [ ] **Step 2: Components**

- `chat-sidebar.tsx` becomes two sections. "Pinned agents" (from `getPinnedAgents`, with a pin toggle on hover of any agent in the "New chat" menu) starts a session per click via `createSession`. "Sessions" is rendered by `chat-sessions.tsx`.
- `chat-sessions.tsx` lists `listThreads()` with pinned first, an unread count badge, and a spinner dot when `activeRunId`. A row menu (`DropdownMenu`) offers Rename (inline input → `renameSession`), Pin/Unpin, Archive, and Delete (confirm). The "Archived" disclosure at the bottom loads `listThreads({ archived: true })` with Unarchive.
- `chat.tsx`:
  - Selecting a session loads `listMessages`, `listSessionTasks` and `listSuggestions(agentId)`, calls `markSessionRead`, and restores the composer from `thread.draft` (**draft restore**).
  - The composer saves the draft with `saveDraft` debounced at 600 ms.
  - Sending calls `sendMessage`; the turn shows immediately and a "queued" chip appears. Sending is not blocked while a task runs; it queues behind it.
  - `subscribeWorkspaceEvents` listens for events whose type starts with `run.` and re-reads messages and tasks for the open session. Polling every 5 s while `tasks.length > 0` is the fallback, since the relay may be null (AGENTS.md).
  - "Load earlier" at the top pages with `listMessages(id, oldestId)` (**history**).
  - When the thread is empty, suggestions render as buttons that fill the composer.
- `chat-tasks-panel.tsx` is a collapsible panel above the composer listing queued and running tasks. Each has "Cancel" (`cancelSessionTask`) and, for queued ones, "Run next" (`prioritizeSessionTask`). "View steps" opens a `Sheet` with `listTaskEvents(id, runId)` rendered as the **thread view** of that task: tool calls and outputs in order, using the same event rendering the run page uses if it is exported, otherwise a plain list of `type` + summary.
- `chat-thread.tsx`: an agent message with `runId` gets a small "View steps" link that opens the same sheet. Remove the "blocks until the agent answers" comments and pending logic.

- [ ] **Step 3: Check**

Run: `cd /Users/secret/Code/berry-circle/frontend && pnpm lint && pnpm build:check`
Expected: both succeed. Manual check (A merged): start two sessions with one agent; send two messages quickly and see both queued; prioritise the second; cancel one; the reply arrives without a reload; rename, pin, archive, unarchive and delete; type a draft, switch sessions and back, and the draft is restored.

- [ ] **Step 4: Commit**

```bash
git add frontend/lib/chat.ts frontend/components/common/chat
git commit -m "feat(frontend): turn chat into sessions whose messages run as agent tasks"
```

---

### Task 19: Mention picker, trigger preview, rendered mentions, onboarding guide

**Files:**
- Create: `frontend/components/common/issues/details/mention-picker.tsx`
- Modify: `frontend/lib/comments.ts` (`previewCommentTriggers`, `renderMentions`), `frontend/components/common/issues/details/activity-feed.tsx` (composer ~line 328, send ~line 208, and the comment body rendering), `frontend/app/onboarding/page.tsx`

**Interfaces:**
- Consumes: `POST /api/v1/issues/:ref/comments/trigger-preview` (Task 8), `loadWorkspaceAgents`, `listSquads` (Task 17), `getGuideAgent` (Task 15), and chat's `?agent=` deep link.
- Produces:
  - `previewCommentTriggers(issueRef, body): Promise<{ targets: { agentId: string; agentName: string; reason: 'mention' | 'squad_leader' | 'reply_to_assignee' }[]; refused: { agentId: string; agentName: string; reason: 'no_access' }[] }>`
  - `mentionToken(kind: 'agent' | 'squad', id: string, name: string): string`, which returns `@[${name}](${kind}:${id})` with `]` and newlines stripped from `name`.
  - `splitMentions(body): ({ text: string } | { mention: { kind: 'agent' | 'squad'; id: string; name: string } })[]`

- [ ] **Step 1: Client helpers**

Append to `frontend/lib/comments.ts`:

```ts
const MENTION = /@\[([^\]\n]{1,100})\]\((agent|squad):([0-9a-fA-F-]{36})\)/g;

export function mentionToken(kind: 'agent' | 'squad', id: string, name: string): string {
   return `@[${name.replace(/[\]\n]/g, '').slice(0, 100)}](${kind}:${id})`;
}

export type MentionPart =
   | { text: string }
   | { mention: { kind: 'agent' | 'squad'; id: string; name: string } };

export function splitMentions(body: string): MentionPart[] {
   const parts: MentionPart[] = [];
   let last = 0;
   for (const match of body.matchAll(MENTION)) {
      const index = match.index ?? 0;
      if (index > last) parts.push({ text: body.slice(last, index) });
      parts.push({ mention: { kind: match[2] as 'agent' | 'squad', id: match[3] ?? '', name: match[1] ?? '' } });
      last = index + match[0].length;
   }
   if (last < body.length) parts.push({ text: body.slice(last) });
   return parts;
}

const triggerPlanSchema = z.object({
   targets: z.array(z.object({
      agentId: z.string(),
      agentName: z.string(),
      reason: z.enum(['mention', 'squad_leader', 'reply_to_assignee']),
   })),
   refused: z.array(z.object({ agentId: z.string(), agentName: z.string(), reason: z.literal('no_access') })),
});
export type TriggerPlan = z.infer<typeof triggerPlanSchema>;

export async function previewCommentTriggers(issueRef: string, body: string): Promise<TriggerPlan> {
   const json: unknown = await apiFetch(`/api/v1/issues/${encodeURIComponent(issueRef)}/comments/trigger-preview`, {
      method: 'POST',
      body: JSON.stringify({ body }),
   });
   return triggerPlanSchema.parse(json);
}
```

(Add `import { z } from 'zod';` if the file does not already import it.)

- [ ] **Step 2: Composer and rendering**

- `mention-picker.tsx` is a `Popover` anchored to the textarea. It opens when the user types `@` followed by word characters at the caret, and filters agents (`loadWorkspaceAgents`) and squads (`listSquads`) by name. Arrow keys and Enter choose an entry, which replaces `@query` with `mentionToken(...)` followed by a space. Escape closes it.
- `activity-feed.tsx`:
  - Wire the picker to the composer `textarea`.
  - While the draft is non-empty, call `previewCommentTriggers(issueRef, draft)` debounced at 400 ms and show a line under the composer. It reads "Will start: Coder (mention), Core → Lead (squad)", uses "Coder will pick up this reply" for `reply_to_assignee`, and "Not allowed to mention: X" in the muted destructive tone for refused entries.
  - When sending, keep the current `createIssueComment(issueRef, text)`; the server fires the triggers.
  - When rendering comment bodies, map `splitMentions(body)` to text plus `<span className="rounded bg-accent px-1 text-foreground">@{name}</span>`. An agent mention links to `/${orgId}/agents/${id}` and a squad mention to `/${orgId}/squads/${id}`.
- `app/onboarding/page.tsx`: after the workspace step, show "Questions? Ask the Guide". `getGuideAgent()` is followed by `router.push(`/${orgId}/chat?agent=${guide.id}`)`. The link is hidden when the guide is null (archived).

- [ ] **Step 3: Check**

Run: `cd /Users/secret/Code/berry-circle/frontend && pnpm lint && pnpm build:check`
Expected: both succeed. Manual check: type `@Co`, pick Coder, and the preview says "Will start: Coder". Set Coder's mention scope to admins and, as a member, the preview shows "Not allowed". Posted mentions render as chips. Onboarding opens a chat with the Guide.

- [ ] **Step 4: Commit**

```bash
git add frontend/lib/comments.ts frontend/components/common/issues/details frontend/app/onboarding/page.tsx
git commit -m "feat(frontend): mention agents and squads in comments with a preview of what starts"
```

---

## Self-review

**Spec §5 coverage.**

| Spec item | Task |
|---|---|
| Skills catalogue: table, files, labels, GitHub/zip import, refresh, search, attach with toggle | 2, 3, 14 |
| The envelope carries enabled skills, and the container writes them to the workspace | 9 (`writeSkills`), 13 |
| MCP servers per agent and workspace, headers sealed, in the envelope, Strands MCP client, Gateway routing | 4, 9, 13, 15 |
| Agent CRUD: create, archive, restore, cancel all tasks, task list, env (sealed), labels, avatar, copy | 5, 6, 15, 16 |
| AI agent builder: `agent_builder_sessions`/`drafts`, completion task, preview, apply | 10, 16 |
| Onboarding guide agent | 5 (091), 19 |
| Squads: roles, leader, routing, delegation via Berry tools, re-trigger, briefing | 7, 9, 13, 17 |
| Mentions trigger runs, reply routing, trigger preview | 8, 19 |
| Chat: sessions CRUD, pin, archive, read, pinned agents, agent tasks, cancel and prioritise, titles, drafts, history and thread views, suggestions | 11, 18 |
| Per-agent access scopes extending `PUT /permissions` | 6, 15 |
| §11 isolation, secrets, cross-tenant tests | 1, 12, and every mount test |

**Placeholder scan.** Some steps say "follows the pattern" for a mount test (Tasks 4, 7, 11). Each of those lists its exact assertions, and the pattern file (`skills.test.ts`) is given in full in Task 2. Task 13 depends on files A has not written yet. It gives the grep commands that locate them and the exact code to insert, and it stops rather than guesses if an export is missing.

**Type consistency.** `EnqueueInput`/`EnqueueTask`/`CompleteFn` (Task 1) are used unchanged in Tasks 7, 8, 10, 11 and 13. `SkillRepository.copyBindings` and `McpServerRepository.copyForAgent` are static and take a `Queryable`, and Task 5 calls them as such. `EnvelopeSkill`/`EnvelopeMcpServer` (Task 9) are A's `SkillRef`/`McpServerRef` (`{ name, files }`, `{ name, url, transport: 'http' | 'sse', headers }`), which Task 13 proves with a type assertion. They mirror `EnvelopeSkillLike`/`EnvelopeMcpServerLike` field for field. The catalogue's `streamable_http` becomes `http` only at the envelope seam (`wireTransport`). Validation failures everywhere are 422 `VALIDATION_FAILED` (`assertValid`); malformed JSON is 400 `INVALID_BODY`. `TriggerPlan` is the same on the server (Task 8) and in the frontend schema (Task 19).

## Open questions for the human

1. **Chat runs and `runs` schema (A).** Resolved by reading A's plan. Migration 053 makes `runs.issue_id`/`board_id` nullable, adds `chat_session_id` and `priority`, and claims `priority DESC, created_at ASC`.
2. **Envelope element shapes (A).** Resolved. A owns `skillRefSchema`/`mcpServerRefSchema`, and D's types now equal them (Task 9), with a compile-time check in Task 13.
3. **Chat guard placement.** A left the guard to D inside `enqueueTask`. Task 13 Step 5a serializes a session's runs (lock and set `active_run_id`, plus a claim predicate) rather than refusing, because spec §5 needs several queued chat tasks. A's owner should confirm that the one-line predicate in `Dispatcher.#claim` is acceptable.
4. **Reply routing vs. an active run.** A's `enqueueTask` **refuses** with `ActiveRunExists` when the issue has a queued or running run. So a mention or reply on a busy issue starts nothing: Task 8 reports the failure and releases the claim. Should the preview warn "Coder is busy on this issue" (a small addition to `planCommentTriggers`), or should A queue behind the active run instead? Currently the trigger is dropped and logged.
5. **Settings "chat" tab (spec §10).** Spec §10 lists a chat settings tab, but spec §5 names no chat settings. This plan builds none. Decide whether pinned agents or suggestions belong there, or drop the tab from §10.
