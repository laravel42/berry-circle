import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { AgentRepository, type Agent } from './repository.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';

/**
 * Agents against a real PostgreSQL.
 *
 * The parts worth testing are the ones the database decides: the protected
 * orchestrator's refusal is a trigger, the skills column is a text[] with its
 * own grammar, and "leave this field alone" is a CASE in the UPDATE rather
 * than something the caller can see.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('agents', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let agents: AgentRepository;
   const fixture = { workspaceId: '', userId: '', viewerId: '', outsiderId: '' };

   before(async () => {
      sql = openDatabase({ url: url! });
      agents = new AgentRepository(sql);
      await seed(sql, fixture);
   });

   after(async () => {
      await cleanup(sql, fixture);
      await closeDatabase(sql);
   });

   test('Berry can author an agent, which the old runtime left no room for', async () => {
      const created = await agents.create({
         workspaceId: fixture.workspaceId,
         name: 'Rows Writer',
         description: 'Authored in Berry.',
         instructions: 'Be brief.',
         provider: 'openrouter',
         model: 'anthropic/claude-sonnet-4.5',
         skills: ['writing'],
      });

      assert.equal(created.name, 'Rows Writer');
      // Available, not unknown: Berry owns this agent's availability and
      // nothing else will ever set it, so "unknown" would be a lie about a row
      // whose state is entirely known.
      assert.equal(created.status, 'available');
      assert.equal(created.modelName, 'anthropic/claude-sonnet-4.5');
      assert.deepEqual(created.skills, ['writing']);
      assert.equal(created.protected, false);

      const read = await agents.get(created.id, fixture.workspaceId);
      assert.deepEqual(read, created);
   });

   test('a page is ordered by name and resumes exactly where it stopped', async () => {
      const workspaceId = await freshWorkspace(sql, fixture.userId);
      // Migration 091 seeds a guide into every new workspace; this test is about
      // paging, so it pages the orchestrator and its own agents only.
      await sql`DELETE FROM agents WHERE workspace_id = ${workspaceId} AND system_role = 'guide'`;
      for (const name of ['delta', 'alpha', 'charlie', 'bravo']) {
         await agents.create({ workspaceId, name });
      }

      const first = await agents.list(workspaceId, '', null, 2);
      assert.deepEqual(
         first.map((agent) => agent.name),
         ['Orchestrator', 'alpha']
      );

      const last = first.at(-1)!;
      const second = await agents.list(workspaceId, '', { name: last.name, id: last.id }, 10);
      assert.deepEqual(
         second.map((agent) => agent.name),
         ['bravo', 'charlie', 'delta']
      );
      // No overlap and no gap: the cursor is (name, id), so two agents sharing
      // a name still page in a stable order.
      await dropWorkspace(sql, workspaceId);
   });

   test('a status filter narrows the page without breaking the cursor', async () => {
      const workspaceId = await freshWorkspace(sql, fixture.userId);
      const offline = await agents.create({ workspaceId, name: 'quiet' });
      await sql`UPDATE agents SET status = 'offline' WHERE id = ${offline.id}`;
      await agents.create({ workspaceId, name: 'ready' });

      const available = await agents.list(workspaceId, 'available', null, 10);
      assert.ok(available.every((agent) => agent.status === 'available'));
      assert.ok(available.some((agent) => agent.name === 'ready'));
      assert.ok(!available.some((agent) => agent.name === 'quiet'));

      const quiet = await agents.list(workspaceId, 'offline', null, 10);
      assert.deepEqual(
         quiet.map((agent) => agent.name),
         ['quiet']
      );
      await dropWorkspace(sql, workspaceId);
   });

   test('a saved field is written and an unsent one is left alone', async () => {
      const created = await agents.create({
         workspaceId: fixture.workspaceId,
         name: 'Config Subject',
         description: 'Original description.',
         instructions: 'Original instructions.',
         provider: 'openrouter',
         model: 'anthropic/claude-sonnet-4.5',
         skills: ['writing'],
      });

      const updated = await agents.setConfig(created.id, fixture.workspaceId, {
         instructions: 'Replaced instructions.',
      });
      assert.equal(updated.instructions, 'Replaced instructions.');
      // Everything else survives. Conflating "leave unchanged" with "erase"
      // would make saving one field blank the rest, which is exactly what an
      // editor must not do.
      assert.equal(updated.description, 'Original description.');
      assert.equal(updated.modelName, 'anthropic/claude-sonnet-4.5');
      assert.deepEqual(updated.skills, ['writing']);
   });

   test('an empty string clears a field, because that is the only way to', async () => {
      const created = await agents.create({
         workspaceId: fixture.workspaceId,
         name: 'Clearable',
         description: 'Something.',
      });
      const cleared = await agents.setConfig(created.id, fixture.workspaceId, { description: '' });
      assert.equal(cleared.description, '');
   });

   test('the model is stored, because nothing projects it any more', async () => {
      // Berry used to read the model back from the runtime after pushing it. There
      // is nothing to read it back from now, so a save that did not store it
      // would silently do nothing at all.
      const created = await agents.create({ workspaceId: fixture.workspaceId, name: 'Switcher' });
      assert.equal(created.modelName, null);

      const switched = await agents.setConfig(created.id, fixture.workspaceId, {
         provider: 'openrouter',
         model: 'openai/gpt-5',
      });
      assert.equal(switched.modelProvider, 'openrouter');
      assert.equal(switched.modelName, 'openai/gpt-5');

      const [row] = await sql`SELECT model_name FROM agents WHERE id = ${created.id}`;
      assert.equal(row!.model_name, 'openai/gpt-5');
   });

   test('an archived agent leaves the list but keeps its id', async () => {
      const created = await agents.create({ workspaceId: fixture.workspaceId, name: 'Retiree' });
      await agents.archive(created.id, fixture.workspaceId, new Date());

      await assert.rejects(() => agents.get(created.id, fixture.workspaceId), NotFound);
      const listed = await agents.list(fixture.workspaceId, '', null, 100);
      assert.ok(!listed.some((agent) => agent.id === created.id));

      // Never deleted: the id is referenced by every run the agent made and by
      // assignment history, and those have to keep naming somebody.
      const [row] = await sql`SELECT name, archived_at FROM agents WHERE id = ${created.id}`;
      assert.equal(row!.name, 'Retiree');
      assert.notEqual(row!.archived_at, null);
   });

   test('the workspace orchestrator cannot be removed', async () => {
      // A workspace without one has nothing to fall back to when no other
      // agent can take a task, which is what the flag protects against.
      const [orchestrator] = await sql`
         SELECT id FROM agents WHERE workspace_id = ${fixture.workspaceId} AND protected`;
      await assert.rejects(
         () => agents.archive(orchestrator!.id as string, fixture.workspaceId, new Date()),
         Forbidden
      );
   });

   test('an agent in another workspace is not found rather than forbidden', async () => {
      const otherWorkspace = await freshWorkspace(sql, fixture.userId);
      const theirs = await agents.create({ workspaceId: otherWorkspace, name: 'Elsewhere' });

      // Reached through the agent, so the workspace comes from the row rather
      // than from the caller — naming a workspace you belong to cannot reach
      // an agent in one you do not.
      await assert.rejects(() => agents.get(theirs.id, fixture.workspaceId), NotFound);
      await dropWorkspace(sql, otherWorkspace);
   });

   test('a viewer may read agents and may not change them', async () => {
      const scope = await agents.authorizeWorkspace(
         fixture.viewerId,
         fixture.workspaceId,
         'product.read'
      );
      assert.equal(scope.role, 'viewer');
      await assert.rejects(
         () => agents.authorizeWorkspace(fixture.viewerId, fixture.workspaceId, 'product.write'),
         Forbidden
      );
   });

   test('someone outside the workspace is told it is not there', async () => {
      // Not "forbidden": that would confirm the workspace exists to anybody
      // who guesses its id.
      await assert.rejects(
         () => agents.authorizeWorkspace(fixture.outsiderId, fixture.workspaceId, 'product.read'),
         NotFound
      );
   });

   test('the capability view carries the load that decides who gets work', async () => {
      const workspaceId = await freshWorkspace(sql, fixture.userId);
      const idle = await agents.create({ workspaceId, name: 'idle', skills: ['writing'] });
      const busy = await agents.create({ workspaceId, name: 'busy' });
      await startRun(sql, workspaceId, fixture.userId, busy.id);

      const capabilities = await agents.listCapabilities(workspaceId);
      const byName = new Map(capabilities.map((item) => [item.agent.name, item]));
      assert.equal(byName.get('idle')!.activeRuns, 0);
      assert.equal(byName.get('busy')!.activeRuns, 1);
      assert.deepEqual(byName.get('idle')!.agent.skills, ['writing']);
      // `protected ASC` sorts the orchestrator last: the workspace's real
      // agents come first and the built-in fallback trails them, which is the
      // order a planner wants to read them in.
      assert.equal(capabilities.at(-1)!.agent.protected, true);
      assert.ok(capabilities.slice(0, -1).every((item) => !item.agent.protected));
      await dropWorkspace(sql, workspaceId);
   });
});

async function seed(sql: Sql, fixture: Record<string, string>): Promise<void> {
   const suffix = randomUUID().slice(0, 8);
   fixture.userId = await createUser(sql, `agents-${suffix}`);
   fixture.viewerId = await createUser(sql, `viewer-${suffix}`);
   fixture.outsiderId = await createUser(sql, `outsider-${suffix}`);
   fixture.workspaceId = await freshWorkspace(sql, fixture.userId);
   await sql`
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES (${fixture.workspaceId}, ${fixture.viewerId}, 'viewer')`;
}

async function createUser(sql: Sql, handle: string): Promise<string> {
   const [row] = await sql`
      INSERT INTO users (id, email, name)
      VALUES (${randomUUID()}, ${`${handle}@berry.test`}, ${handle})
      RETURNING id`;
   return row!.id as string;
}

/** A workspace, which gets its protected Orchestrator by trigger. */
async function freshWorkspace(sql: Sql, ownerId: string): Promise<string> {
   const suffix = randomUUID().slice(0, 8);
   const [workspace] = await sql`
      INSERT INTO workspaces (id, name, slug, settings, created_by)
      VALUES (${randomUUID()}, ${`Agents ${suffix}`}, ${`agents-${suffix}`},
              ${sql.json({ issuePrefix: 'AGT', defaultRole: 'member', allowMemberInvites: false } as never)},
              ${ownerId})
      RETURNING id`;
   const workspaceId = workspace!.id as string;
   await sql`
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${ownerId}, 'owner')`;
   return workspaceId;
}

/** A board, a task and a queued run, so an agent has load to report. */
async function startRun(
   sql: Sql,
   workspaceId: string,
   userId: string,
   agentId: string
): Promise<void> {
   const suffix = randomUUID().slice(0, 8);
   const [board] = await sql`
      INSERT INTO boards (id, workspace_id, name, slug, created_by)
      VALUES (${randomUUID()}, ${workspaceId}, 'Load', ${`ld-${suffix}`}, ${userId})
      RETURNING id`;
   const boardId = board!.id as string;
   const [counter] = await sql`
      UPDATE boards SET issue_counter = issue_counter + 1 WHERE id = ${boardId}
      RETURNING issue_counter`;
   const [issue] = await sql`
      INSERT INTO issues (id, board_id, number, title, status, created_by)
      VALUES (${randomUUID()}, ${boardId}, ${Number(counter!.issue_counter)}, 'Load', 'in_progress', ${userId})
      RETURNING id`;
   await sql`
      INSERT INTO runs (id, issue_id, board_id, agent_id, requested_by)
      VALUES (${randomUUID()}, ${issue!.id as string}, ${boardId}, ${agentId}, ${userId})`;
}

async function dropWorkspace(sql: Sql, workspaceId: string): Promise<void> {
   await sql`DELETE FROM outbox_events WHERE workspace_id = ${workspaceId}`;
   await sql`
      DELETE FROM issues WHERE board_id IN (SELECT id FROM boards WHERE workspace_id = ${workspaceId})`;
   // The protected Orchestrator refuses deletion, deliberately, so the guard
   // is suspended for the fixture's own teardown and nowhere else.
   await deleteWorkspaceAgents(sql, [workspaceId]);
   await sql`DELETE FROM boards WHERE workspace_id = ${workspaceId}`;
   await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${workspaceId}`;
   await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
}

async function cleanup(sql: Sql, fixture: Record<string, string>): Promise<void> {
   if (!fixture.workspaceId) return;
   await dropWorkspace(sql, fixture.workspaceId);
   for (const id of [fixture.userId, fixture.viewerId, fixture.outsiderId]) {
      if (id) await sql`DELETE FROM users WHERE id = ${id}`;
   }
}
