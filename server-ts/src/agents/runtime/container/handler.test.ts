import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { tool, type Message } from '@strands-agents/sdk';
import { z } from 'zod';
import type { TaskEnvelope } from '../../../runtime/envelope.ts';
import type { LifecycleEvent } from '../../../runtime/lifecycle.ts';
import { textOf } from '../plugins/accounting.ts';
import { ScriptedModel, call, say, throwing, type ScriptedTurn } from '../scripted-model.ts';
import { handleInvocation, toConversation, type HandlerDeps } from './handler.ts';
import { SessionRegistry } from './sessions.ts';

const SESSION = `berry-${'a'.repeat(64)}`;

function envelope(overrides: Partial<TaskEnvelope> = {}): TaskEnvelope {
   return {
      kind: 'agent',
      runId: 'run-1',
      sessionKey: 'agent:issue',
      runtimeSessionId: SESSION,
      agent: {
         name: 'Builder', instructions: 'Be brief.', model: 'scripted', skills: [], mcpServers: [],
         permissions: [], maxTokens: null, temperature: null,
      },
      task: { prompt: 'first', issue: null, comments: [], dependencies: [], projectResources: [], priorWork: null },
      transcript: [],
      repo: null,
      completion: null,
      env: {},
      berry: { apiUrl: 'https://berry.test', token: 'berry_task_t' },
      ...overrides,
   };
}

function harness(turns: ScriptedTurn[], extra: Partial<HandlerDeps> = {}) {
   const model = new ScriptedModel(turns);
   const registry = new SessionRegistry();
   const deps: HandlerDeps = {
      registry,
      modelFactory: () => model,
      region: 'us-east-1',
      workRoot: mkdtempSync(join(tmpdir(), 'berry-sessions-')),
      loadTools: async () => [],
      ...extra,
   };
   const run = async (e: TaskEnvelope) => {
      const events: LifecycleEvent[] = [];
      await handleInvocation(e, (event) => events.push(event), deps);
      return events;
   };
   return { model, registry, deps, run };
}

const texts = (messages: Message[] | undefined) => (messages ?? []).map(textOf);

test('a run emits started, its words, usage, then completed', async () => {
   const { run } = harness([say('all done')]);
   const events = await run(envelope());
   assert.equal(events[0]!.type, 'task.started');
   assert.equal(events.at(-1)!.type, 'task.completed');
   assert.ok(events.some((event) => event.type === 'task.usage'));
   const completed = events.at(-1);
   assert.ok(completed?.type === 'task.completed');
   assert.equal(completed.result.text, 'all done');
});

test('warm: a second task on a live session appends to the same conversation', async () => {
   const { model, run } = harness([say('one'), say('two')]);
   await run(envelope({ runId: 'run-1', task: { ...envelope().task, prompt: 'first' } }));
   await run(
      envelope({
         runId: 'run-2',
         task: { ...envelope().task, prompt: 'second' },
         // Ignored while warm: the live conversation is the better record.
         transcript: [{ role: 'user', text: 'STALE' }, { role: 'assistant', text: 'STALE' }],
      })
   );
   assert.deepEqual(texts(model.received[1]), ['first', 'one', 'second']);
});

test('cold: a session the runtime does not hold is restored from the transcript', async () => {
   const { model, run } = harness([say('answer')]);
   await run(
      envelope({
         task: { ...envelope().task, prompt: 'follow-up' },
         transcript: [
            { role: 'user', text: 'earlier question' },
            { role: 'assistant', text: 'earlier answer' },
         ],
      })
   );
   assert.deepEqual(texts(model.received[0]), ['earlier question', 'earlier answer', 'follow-up']);
});

test('a changed agent configuration restarts cold rather than reusing the old conversation', async () => {
   const { model, run } = harness([say('one'), say('two')]);
   await run(envelope());
   await run(
      envelope({
         runId: 'run-2',
         agent: { ...envelope().agent, instructions: 'Now be verbose.' },
         task: { ...envelope().task, prompt: 'second' },
         transcript: [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'one' }],
      })
   );
   assert.deepEqual(texts(model.received[1]), ['first', 'one', 'second']);
});

test('the runtime reports busy while a loop works and idle after', async () => {
   const seen: boolean[] = [];
   const holder: { registry?: SessionRegistry } = {};
   const probe = tool({
      name: 'probe',
      description: 'probe',
      inputSchema: z.object({}),
      callback: () => {
         seen.push(holder.registry?.busy ?? false);
         return 'ok';
      },
   });
   const h = harness([call('probe', {}), say('done')], { loadTools: async () => [probe] });
   holder.registry = h.registry;
   await h.run(envelope());
   assert.deepEqual(seen, [true]);
   assert.equal(h.registry.busy, false);
});

test('a failed model call is task.failed, and the session is dropped for a cold retry', async () => {
   const { registry, run } = harness([throwing(new Error('boom'))]);
   const events = await run(envelope());
   assert.equal(events.at(-1)!.type, 'task.failed');
   assert.equal(registry.get(SESSION), undefined);
});

test('an unreadable tool manifest fails the task instead of running toolless', async () => {
   const { run } = harness([say('x')], {
      loadTools: async () => {
         throw new Error('manifest refused');
      },
   });
   const events = await run(envelope());
   const last = events.at(-1);
   assert.ok(last?.type === 'task.failed');
   assert.equal(last.failure.retryable, true);
});

test('a transcript is normalised to alternating turns that start with the user', () => {
   assert.deepEqual(
      toConversation([
         { role: 'assistant', text: 'orphan' },
         { role: 'user', text: 'a' },
         { role: 'user', text: 'b' },
         { role: 'assistant', text: 'c' },
         { role: 'user', text: 'unanswered' },
      ]),
      [
         { role: 'user', content: [{ text: 'a\n\nb' }] },
         { role: 'assistant', content: [{ text: 'c' }] },
      ]
   );
});

test('an agent task writes its skills into the session workspace and connects its MCP servers', async () => {
   const loaded: string[] = [];
   const { deps, run } = harness([say('ok')], {
      loadMcp: async (servers) => {
         loaded.push(...servers.map((server) => server.name));
         return [];
      },
   });
   const manifest = '---\nname: lint\ndescription: "d"\n---\nRun the linter.';
   const events = await run(
      envelope({
         agent: {
            ...envelope().agent,
            skills: [{ name: 'lint', files: [{ path: 'SKILL.md', content: manifest }] }],
            mcpServers: [{ name: 'docs', url: 'https://docs.test/mcp', transport: 'http', headers: {} }],
         },
      })
   );
   assert.equal(events.at(-1)!.type, 'task.completed');
   assert.equal(readFileSync(join(deps.workRoot, SESSION, '.claude/skills/lint/SKILL.md'), 'utf8'), manifest);
   assert.deepEqual(loaded, ['docs']);
});
