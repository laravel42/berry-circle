import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { z } from 'zod';
import { nullRunMemory } from '../agentcore/memory.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { GitHubClient } from '../integrations/github.ts';
import type { Logger } from '../observability/log.ts';
import { Dispatcher } from '../runs/dispatcher.ts';
import { CompletionFailed, CompletionInvalid, RuntimeCompletion, runCompletion } from './completion.ts';
import { EnvelopeBuilder } from './envelope-builder.ts';
import type { LifecycleEvent } from './lifecycle.ts';
import { RuntimeTaskExecutor } from './task-executor.ts';
import { cleanupFixture, seedFixture, type Fixture } from './test-fixture.ts';
import type { RuntimeTransport } from './transport.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;
const quiet = { info() {}, error() {}, warn() {}, debug() {} } as unknown as Logger;

describe('runCompletion', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let fixture: Fixture | null = null;
   let dispatcher: Dispatcher;
   let reply: (envelopeSystem: string) => LifecycleEvent[] = () => [];
   const systems: string[] = [];

   before(async () => {
      sql = openDatabase({ url: url! });
      fixture = await seedFixture(sql, 'completion');
      const transport: RuntimeTransport = {
         async *invoke({ envelope }) {
            systems.push(envelope.completion?.system ?? '');
            for (const event of reply(envelope.completion?.system ?? '')) yield event;
         },
         async stop() {},
      };
      const executor = new RuntimeTaskExecutor({
         sql,
         transport,
         builder: new EnvelopeBuilder({
            sql, publicUrl: 'https://berry.test', defaultModel: 'm', memory: nullRunMemory(), sealer: null,
            github: (token) => new GitHubClient({ token }),
         }),
         defaultTarget: { id: null, driver: 'http', arn: null, qualifier: 'DEFAULT', region: null, endpointUrl: 'http://t' },
         recordUsage: async () => {},
      });
      // Confined to this file's workspace: a live dispatcher that claimed from
      // the whole table would execute the runs other files are asserting about
      // (a suite that queues a task and expects it to *wait* would see it run).
      dispatcher = new Dispatcher({
         sql,
         executor,
         logger: quiet,
         concurrency: 4,
         pollMs: 50,
         workspaceIds: [fixture!.workspaceId],
      });
      dispatcher.start();
   });
   after(async () => {
      await dispatcher.stop();
      await cleanupFixture(sql, fixture);
      await closeDatabase(sql);
   });

   const deps = () => ({ sql, nudge: () => dispatcher.nudge(), pollMs: 25, timeoutMs: 10_000 });

   test('a structured answer comes back validated against the caller schema', async () => {
      reply = () => [
         { type: 'task.started' },
         { type: 'task.completed', result: { text: '', truncated: false, structured: { label: 'bug' }, delivery: null } },
      ];
      const value = await runCompletion(deps(), {
         workspaceId: fixture!.workspaceId, purpose: 'triage', system: 'Label it', prompt: 'crash on save',
         schema: z.object({ label: z.enum(['bug', 'feature']) }),
      });
      assert.deepEqual(value, { label: 'bug' });
      assert.equal(systems.at(-1), 'Label it');
   });

   test('an answer outside the schema is CompletionInvalid', async () => {
      reply = () => [
         { type: 'task.started' },
         { type: 'task.completed', result: { text: 'nope', truncated: false, structured: { label: 'other' }, delivery: null } },
      ];
      await assert.rejects(
         runCompletion(deps(), {
            workspaceId: fixture!.workspaceId, purpose: 't', system: 's', prompt: 'p',
            schema: z.object({ label: z.enum(['bug', 'feature']) }),
         }),
         CompletionInvalid
      );
   });

   test('a runtime failure is CompletionFailed with its code', async () => {
      reply = () => [{ type: 'task.failed', failure: { code: 'MODEL_THROTTLED', message: 'slow down', retryable: true } }];
      await assert.rejects(
         new RuntimeCompletion(deps()).text({ workspaceId: fixture!.workspaceId, model: 'm', system: 's', user: 'u' }),
         (error: unknown) => error instanceof CompletionFailed && error.code === 'MODEL_THROTTLED' && error.retryable
      );
   });

   test('text and usage come back through the adapter', async () => {
      reply = () => [
         { type: 'task.started' },
         { type: 'task.usage', usage: { model: 'm', inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } },
         { type: 'task.completed', result: { text: 'rewritten', truncated: false, delivery: null } },
      ];
      const result = await new RuntimeCompletion(deps()).text({ workspaceId: fixture!.workspaceId, model: 'm', system: 's', user: 'u' });
      assert.equal(result.value, 'rewritten');
      assert.equal(result.inputTokens, 7);
   });
});
