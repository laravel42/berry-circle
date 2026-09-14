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
