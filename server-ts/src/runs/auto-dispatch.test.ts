import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActiveRunExists, type RunRepository } from './repository.ts';
import { autoDispatch, readyForAgent } from './auto-dispatch.ts';

/**
 * When a task starts on its own. The repository is faked: what is under test
 * is the decision, not the row.
 */

const base = { id: 'i', boardId: 'b', status: 'todo', assignee: { type: 'agent', id: 'a' }, activeRunId: null };

test('an agent-assigned task in todo with no run is ready; anything else is not', () => {
   assert.equal(readyForAgent(base), true);
   assert.equal(readyForAgent({ ...base, assignee: { type: 'user', id: 'u' } }), false);
   assert.equal(readyForAgent({ ...base, assignee: null }), false);
   assert.equal(readyForAgent({ ...base, status: 'backlog' }), false);
   assert.equal(readyForAgent({ ...base, status: 'blocked' }), false);
   assert.equal(readyForAgent({ ...base, status: 'in_progress' }), false);
   assert.equal(readyForAgent({ ...base, activeRunId: 'r' }), false);
});

test('a ready task is admitted for its assignee, in the workspace, by the person who edited it', async () => {
   const admitted: unknown[] = [];
   const runs = {
      admit: async (input: unknown) => {
         admitted.push(input);
         return { id: 'run' } as never;
      },
   } as unknown as Pick<RunRepository, 'admit'>;
   const run = await autoDispatch(runs, base, { workspaceId: 'ws', requestedBy: 'user' });
   assert.equal(run?.id, 'run');
   assert.deepEqual(admitted, [
      { issueId: 'i', boardId: 'b', workspaceId: 'ws', agentId: null, requestedBy: 'user', instructions: null },
   ]);
});

test('a task that is not ready admits nothing', async () => {
   let called = 0;
   const runs = { admit: async () => { called += 1; return {} as never; } } as unknown as Pick<RunRepository, 'admit'>;
   await autoDispatch(runs, { ...base, status: 'backlog' }, { workspaceId: 'ws', requestedBy: 'user' });
   assert.equal(called, 0);
});

test('a run that got there first is not an error', async () => {
   const runs = { admit: async () => { throw new ActiveRunExists('other'); } } as unknown as Pick<RunRepository, 'admit'>;
   assert.equal(await autoDispatch(runs, base, { workspaceId: 'ws', requestedBy: 'user' }), null);
});

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
