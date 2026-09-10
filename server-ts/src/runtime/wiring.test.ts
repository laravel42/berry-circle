import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { z } from 'zod';
import { closeDatabase, openDatabase } from '../db/pool.ts';
import { CompletionFailed } from './completion.ts';
import { cleanupFixture, seedFixture, type Fixture } from './test-fixture.ts';
import type { IssueRepository } from '../core/issues.ts';
import type { Sql } from '../db/pool.ts';
import { enqueueTask } from '../runs/queue.ts';
import { getAgentTool } from './agent-tools/registry.ts';
import { agentCompletion, agentEnqueue, quickActionEnqueue, registerDelegateTool } from './wiring.ts';

/**
 * Each seam carries the runtime's real function. The types are proven by the
 * compiler (wiring.ts is typed with every seam); these pin the values, and
 * that the composition root hands them to every injection point, so a seam
 * cannot quietly go back to a fake or to null.
 */

const root = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

test('quick actions queue through the runtime task queue', () => {
   assert.equal(quickActionEnqueue, enqueueTask);
   assert.match(root, /enqueue: quickActionEnqueue/);
});

test('the agent layer queues through the runtime task queue', () => {
   assert.equal(agentEnqueue, enqueueTask);
});

test('delegate_to_member is on the runtime tool registry, for task writers', () => {
   registerDelegateTool({ sql: {} as Sql, issues: {} as IssueRepository });
   const tool = getAgentTool('delegate_to_member');
   assert.ok(tool);
   assert.equal(tool.scope, 'task:write');
   assert.match(root, /registerDelegateTool\(\{ sql, issues \}\)/);
});

test('the composition root gives the agent layer the real queue and completion everywhere', () => {
   // No seam is left unwired.
   assert.doesNotMatch(root, /\b(enqueue|complete): null\b/);
   assert.match(root, /const complete = agentCompletion\(\{/);
   // Chat sessions.
   assert.match(root, /conversationMounts\(\{[^}]*enqueue: agentEnqueue,\s*complete,/s);
   // Squads, and the builder's completions.
   assert.match(root, /squadMounts\(\{[^}]*enqueue: agentEnqueue,/s);
   assert.match(root, /new AgentBuilder\(\{ sql, complete, /);
   // Mentions and replies on comments.
   assert.match(root, /triggers: commentTriggers\(\{\s*sql,\s*enqueue: agentEnqueue,/);
   // The terminal hooks, registered once.
   assert.match(root, /registerChatReplies\(\{ sql, conversations: conversationRepository \}\)/);
   assert.match(root, /registerSquadRetrigger\(\{ sql, enqueue: agentEnqueue \}\)/);
   // The envelope carries the agent's skills, MCP servers and env.
   assert.match(
      root,
      /extensions: \{ skills: skillRepository, mcp: mcpRepository, profile: agentProfiles, gateway: gatewayRoute \}/
   );
});

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('the agent layer’s completions', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let fixture: Fixture | null = null;
   before(async () => {
      sql = openDatabase({ url: url! });
      fixture = await seedFixture(sql, 'wiring');
   });
   after(async () => {
      await sql`DELETE FROM runs WHERE workspace_id = ${fixture!.workspaceId}`;
      await cleanupFixture(sql, fixture);
      await closeDatabase(sql);
   });

   test('are completion tasks on the runtime queue, run by the orchestrator', async () => {
      const f = fixture!;
      // No dispatcher here, so the task is queued and the wait times out.
      const complete = agentCompletion({ sql, timeoutMs: 150, pollMs: 25, defaultModel: 'm' });
      await assert.rejects(
         complete({ workspaceId: f.workspaceId, purpose: 'wiring_check', system: 's', prompt: 'p', schema: z.object({ ok: z.boolean() }) }),
         (error: unknown) => error instanceof CompletionFailed && error.code === 'COMPLETION_TIMEOUT'
      );
      const [run] = await sql`
         SELECT agent_id, kind, source, completion_spec->>'purpose' AS purpose FROM runs
          WHERE workspace_id = ${f.workspaceId} ORDER BY created_at DESC LIMIT 1`;
      assert.deepEqual(
         { ...run },
         { agent_id: f.orchestratorId, kind: 'completion', source: 'completion', purpose: 'wiring_check' }
      );
   });
});
