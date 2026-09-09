import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import { PlanTriage, TriageUnavailable } from './triage.ts';

/**
 * What the orchestrator is allowed to decide, and what happens to the rest.
 *
 * The model is faked: what is under test is which of its answers are believed,
 * and which tasks are started once they are.
 */

interface Fake {
   triage: PlanTriage;
   admitted: Array<{ issueId: string; agentId: string; instructions: string }>;
   sent: () => Record<string, unknown>;
}

function fake(options: {
   tasks: Array<{ id: string; status: string; title?: string; description?: string | null }>;
   agents: string[];
   answer: unknown;
   admitFails?: string;
}): Fake {
   const admitted: Fake['admitted'] = [];
   let sent: Record<string, unknown> = {};

   const triage = new PlanTriage({
      // A tagged template that yields no rows: the model falls back to the
      // deployment default, and the assignment UPDATE writes into nothing.
      sql: (async () => []) as never,
      region: 'us-east-1',
      defaultModel: 'test/model',
      completion: {
         async structured(input: { model: string; system: string; user: string; schema: z.ZodType }) {
            sent = { model: input.model, system: input.system, user: input.user };
            // Parsed the way the real completion parses it, so an answer the
            // schema refuses is refused here too.
            const value = input.schema.parse(options.answer);
            return { value, text: JSON.stringify(value), inputTokens: 0, outputTokens: 0, durationMs: 1 };
         },
      } as never,
   });

   // The database halves are replaced: this test is about the decision, and a
   // real schema would only restate what the fixtures already say.
   (triage as unknown as { tasks: unknown }).tasks = async () =>
      options.tasks.map((task) => ({
         id: task.id,
         number: 1,
         title: task.title ?? task.id,
         description: task.description ?? null,
         status: task.status,
         capabilities: [],
      }));
   (triage as unknown as { roster: unknown }).roster = async () =>
      options.agents.map((id) => ({ id, name: id, description: null, capabilities: [] }));

   return {
      triage,
      admitted,
      sent: () => sent,
   };
}

async function run(f: Fake, admitFails?: string) {
   return f.triage.triage({
      planId: 'p1',
      workspaceId: 'w1',
      admit: async (task) => {
         if (admitFails && task.issueId === admitFails) throw new Error('busy');
         f.admitted.push(task);
      },
   });
}

describe('routing a compiled plan', () => {
   test('assigns what the orchestrator decided and starts what can run', async () => {
      const f = fake({
         tasks: [
            { id: 't1', status: 'todo' },
            { id: 't2', status: 'blocked' },
         ],
         agents: ['a1'],
         answer: { assignments: [{ taskId: 't1', agentId: 'a1' }, { taskId: 't2', agentId: 'a1' }] },
      });

      const result = await run(f);

      assert.equal(result.assigned, 2);
      // Blocked work waits on another task, so starting it would put an agent
      // on something whose input does not exist yet.
      assert.equal(result.started, 1);
      assert.deepEqual(f.admitted.map((a) => a.issueId), ['t1']);
   });

   test('an agent that is not on the roster is dropped, not written', async () => {
      const f = fake({
         tasks: [{ id: 't1', status: 'todo' }],
         agents: ['a1'],
         answer: { assignments: [{ taskId: 't1', agentId: 'someone-else' }] },
      });

      const result = await run(f);

      assert.equal(result.assigned, 0);
      assert.deepEqual(result.unassigned, ['t1']);
   });

   test('a task outside this plan is dropped', async () => {
      const f = fake({
         tasks: [{ id: 't1', status: 'todo' }],
         agents: ['a1'],
         answer: { assignments: [{ taskId: 'someone-elses-task', agentId: 'a1' }] },
      });

      assert.equal((await run(f)).assigned, 0);
   });

   test('one task failing to start does not strand the others', async () => {
      const f = fake({
         tasks: [
            { id: 't1', status: 'todo' },
            { id: 't2', status: 'todo' },
         ],
         agents: ['a1'],
         answer: { assignments: [{ taskId: 't1', agentId: 'a1' }, { taskId: 't2', agentId: 'a1' }] },
      });

      const result = await run(f, 't1');

      assert.equal(result.assigned, 2);
      assert.equal(result.started, 1);
      assert.deepEqual(f.admitted.map((a) => a.issueId), ['t2']);
   });

   test('a workspace with no agent to take work says so', async () => {
      const f = fake({ tasks: [{ id: 't1', status: 'todo' }], agents: [], answer: {} });

      await assert.rejects(run(f), TriageUnavailable);
   });

   test('nothing to route is not a failure', async () => {
      const f = fake({ tasks: [], agents: ['a1'], answer: {} });

      assert.deepEqual(await run(f), { assigned: 0, started: 0, unassigned: [] });
   });

   test('the orchestrator is shown the task and the roster, and nothing else', async () => {
      const f = fake({
         tasks: [{ id: 't1', status: 'todo', title: 'Ship it', description: 'the details' }],
         agents: ['a1'],
         answer: { assignments: [] },
      });

      await run(f);
      const body = f.sent();
      const user = JSON.parse(body.user as string) as {
         agents: unknown[];
         tasks: Array<{ id: string; title: string }>;
      };

      assert.equal(user.agents.length, 1);
      assert.deepEqual(user.tasks[0]!.id, 't1');
      assert.deepEqual(user.tasks[0]!.title, 'Ship it');
   });
});
