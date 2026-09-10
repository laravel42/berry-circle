import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import type { TaskEnvelope } from '../../../runtime/envelope.ts';
import type { LifecycleEvent } from '../../../runtime/lifecycle.ts';
import { ScriptedModel, call, say } from '../scripted-model.ts';
import { runCompletionTask } from './completion-task.ts';

function completion(jsonSchema: Record<string, unknown> | null, transcript: TaskEnvelope['transcript'] = []): TaskEnvelope {
   return {
      kind: 'completion', runId: 'c1', sessionKey: 'completion:c1', runtimeSessionId: `berry-${'c'.repeat(64)}`,
      agent: { name: 'Orchestrator', instructions: '', model: 'scripted', skills: [], mcpServers: [], permissions: [], maxTokens: null, temperature: null },
      task: { prompt: 'Classify this', issue: null, comments: [], dependencies: [], projectResources: [], priorWork: null },
      transcript, repo: null,
      completion: { system: 'You classify.', jsonSchema },
      env: {}, berry: { apiUrl: 'https://berry.test', token: 't' },
   };
}

async function run(envelope: TaskEnvelope, model: ScriptedModel): Promise<LifecycleEvent[]> {
   const events: LifecycleEvent[] = [];
   await runCompletionTask(envelope, (event) => events.push(event), { modelFactory: () => model, region: 'us-east-1' });
   return events;
}

test('free text comes back as the result text', async () => {
   const events = await run(completion(null), new ScriptedModel([say('a tidy answer')]));
   const last = events.at(-1);
   assert.ok(last?.type === 'task.completed');
   assert.equal(last.result.text, 'a tidy answer');
});

test('a schema is enforced by the model and returned as structured', async () => {
   const schema = z.toJSONSchema(z.object({ label: z.enum(['bug', 'feature']) })) as Record<string, unknown>;
   // Strands asks for structured output through its own tool,
   // STRUCTURED_OUTPUT_TOOL_NAME in the SDK's tools/structured-output-tool.js.
   const model = new ScriptedModel([call('strands_structured_output', { label: 'bug' }), say('done')]);
   const events = await run(completion(schema), model);
   const last = events.at(-1);
   assert.ok(last?.type === 'task.completed', JSON.stringify(last));
   assert.deepEqual(last.result.structured, { label: 'bug' });
});

test('a conversation in the transcript is the history before the prompt', async () => {
   const model = new ScriptedModel([say('reply')]);
   await run(completion(null, [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }]), model);
   assert.equal(model.received[0]!.length, 3);
});
