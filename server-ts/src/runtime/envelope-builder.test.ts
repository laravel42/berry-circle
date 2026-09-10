import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { nullRunMemory } from '../agentcore/memory.ts';
import { GitHubClient } from '../integrations/github.ts';
import { enqueueTask } from '../runs/queue.ts';
import { EnvelopeBuilder, loadTask } from './envelope-builder.ts';
import { runtimeSessionIdFor } from './session-id.ts';
import { cleanupFixture, createIssue, seedFixture, type Fixture } from './test-fixture.ts';
import { buildTranscript } from './transcript.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('envelope builder', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let fixture: Fixture | null = null;
   let builder: EnvelopeBuilder;

   before(async () => {
      sql = openDatabase({ url: url! });
      fixture = await seedFixture(sql, 'envelope');
      builder = new EnvelopeBuilder({
         sql, publicUrl: 'https://berry.test', defaultModel: 'default-model', memory: nullRunMemory(), sealer: null,
         github: (token) => new GitHubClient({ token }),
      });
   });
   afterEach(async () => {
      await sql`DELETE FROM runs WHERE workspace_id = ${fixture!.workspaceId}`;
   });
   after(async () => {
      await cleanupFixture(sql, fixture);
      await closeDatabase(sql);
   });

   async function finishedRun(issueId: string, prompt: string, output: string, agentId = fixture!.agentId): Promise<string> {
      const { runId } = await enqueueTask(sql, {
         workspaceId: fixture!.workspaceId, agentId, issueId, kind: 'agent', source: 'mention', prompt,
      });
      await sql`UPDATE runs SET status = 'succeeded', dispatch_state = 'succeeded', output = ${output},
                       completed_at = now() WHERE id = ${runId}`;
      await sql`UPDATE issues SET active_run_id = NULL WHERE id = ${issueId}`;
      return runId;
   }

   test('the transcript is this agent on this issue, oldest first, without the current run', async () => {
      const f = fixture!;
      const issueId = await createIssue(sql, f);
      await finishedRun(issueId, 'first ask', 'first answer');
      await finishedRun(issueId, 'second ask', 'second answer');
      await finishedRun(issueId, 'someone else', 'not mine', f.orchestratorId);
      const { runId } = await enqueueTask(sql, { workspaceId: f.workspaceId, agentId: f.agentId, issueId, kind: 'agent', source: 'mention', prompt: 'now' });
      const transcript = await buildTranscript(sql, { agentId: f.agentId, issueId, chatSessionId: null, excludeRunId: runId });
      assert.deepEqual(transcript.map((m) => m.text), ['first ask', 'first answer', 'second ask', 'second answer']);
   });

   test('the transcript keeps the newest messages within its budget', async () => {
      const f = fixture!;
      const issueId = await createIssue(sql, f);
      for (let i = 0; i < 5; i += 1) await finishedRun(issueId, `ask ${i}`, `answer ${i}`);
      const transcript = await buildTranscript(sql, { agentId: f.agentId, issueId, chatSessionId: null, excludeRunId: 'none', maxMessages: 4 });
      assert.deepEqual(transcript.map((m) => m.text), ['ask 3', 'answer 3', 'ask 4', 'answer 4']);
   });

   test('an issue task envelope is on the (agent, issue) session and carries the transcript and token', async () => {
      const f = fixture!;
      const issueId = await createIssue(sql, f, 'Envelope task');
      await finishedRun(issueId, 'earlier', 'did a thing');
      const { runId } = await enqueueTask(sql, { workspaceId: f.workspaceId, agentId: f.agentId, issueId, kind: 'agent', source: 'mention', prompt: 'continue' });
      const task = await loadTask(sql, runId);
      const { envelope, delivery } = await builder.build({ task, dispatch: null, token: 'berry_task_x' });
      assert.equal(envelope.runtimeSessionId, runtimeSessionIdFor(`${f.agentId}:${issueId}`));
      assert.equal(envelope.kind, 'agent');
      assert.equal(envelope.agent.model, 'default-model');
      assert.equal(envelope.transcript.length, 2);
      assert.equal(envelope.berry.token, 'berry_task_x');
      assert.match(envelope.task.prompt, /Envelope task/);
      assert.equal(delivery, null, 'no git credential means no repository');
   });

   test('two completion tasks never share a session', async () => {
      const f = fixture!;
      const one = await enqueueTask(sql, { workspaceId: f.workspaceId, agentId: f.orchestratorId, kind: 'completion', source: 'completion', prompt: 'a' });
      const two = await enqueueTask(sql, { workspaceId: f.workspaceId, agentId: f.orchestratorId, kind: 'completion', source: 'completion', prompt: 'b' });
      await sql`UPDATE runs SET completion_spec = ${sql.json({ purpose: 't', system: 's', jsonSchema: null, model: null } as never)}
                 WHERE id IN (${one.runId}, ${two.runId})`;
      const a = await builder.build({ task: await loadTask(sql, one.runId), dispatch: null, token: 't' });
      const b = await builder.build({ task: await loadTask(sql, two.runId), dispatch: null, token: 't' });
      assert.notEqual(a.envelope.runtimeSessionId, b.envelope.runtimeSessionId);
      assert.equal(a.envelope.completion?.system, 's');
      assert.deepEqual(a.envelope.transcript, []);
   });
});
