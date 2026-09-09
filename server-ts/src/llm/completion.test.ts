import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Message, TextBlock } from '@strands-agents/sdk';
import { z } from 'zod';
import { ScriptedModel, call, say, throwing } from '../agents/runtime/scripted-model.ts';
import { Completion, CompletionFailed, CompletionInvalid } from './completion.ts';

/**
 * One model call, for the parts of Berry that are not an agent — now on the
 * same SDK as the runs, so a structured answer is a schema the model is made
 * to fill rather than a prompt asking nicely and a regex digging it out.
 */

const STRUCTURED = 'strands_structured_output';

function completion(model: ScriptedModel) {
   return new Completion({ region: 'us-east-1', modelFactory: () => model });
}

test('text comes back with its usage', async () => {
   const result = await completion(new ScriptedModel([say('the answer')])).text({
      model: 'm',
      system: 'be brief',
      user: 'hello',
   });
   assert.equal(result.value, 'the answer');
   assert.equal(result.text, 'the answer');
   assert.equal(result.inputTokens, 10);
   assert.equal(result.outputTokens, 5);
});

test('a structured answer is the schema, parsed', async () => {
   const schema = z.object({
      assignments: z.array(z.object({ taskId: z.string(), agentId: z.string() })),
   });
   const model = new ScriptedModel([
      call(STRUCTURED, { assignments: [{ taskId: 't1', agentId: 'a1' }] }),
   ]);
   const result = await completion(model).structured({ model: 'm', system: 's', user: 'u', schema });
   assert.deepEqual(result.value, { assignments: [{ taskId: 't1', agentId: 'a1' }] });
});

test('json() accepts any object, so a lenient reader can validate it', async () => {
   const model = new ScriptedModel([call(STRUCTURED, { goal: { tempId: 'g1' }, extra: true })]);
   const result = await completion(model).json({ model: 'm', system: 's', user: 'u' });
   assert.deepEqual(result.value, { goal: { tempId: 'g1' }, extra: true });
});

test('a model that answers in prose instead of the schema is invalid, with the prose kept', async () => {
   // The SDK forces the tool on a second call; a model that still refuses
   // ends the loop without the shape.
   const model = new ScriptedModel([say('Here you go: {}'), say('I would rather not.')]);
   await assert.rejects(
      completion(model).json({ model: 'm', system: 's', user: 'u' }),
      (error: unknown) => error instanceof CompletionInvalid && /rather not/.test(error.raw)
   );
});

test('a throttle is retried, and a rejection is classified', async () => {
   const throttle = Object.assign(new Error('slow down'), {
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 429 },
   });
   const retried = new ScriptedModel([throwing(throttle), say('ok')]);
   const result = await completion(retried).text({ model: 'm', system: 's', user: 'u' });
   assert.equal(result.value, 'ok');

   const rejected = Object.assign(new Error('bad id'), {
      name: 'ValidationException',
      $metadata: { httpStatusCode: 400 },
   });
   await assert.rejects(
      completion(new ScriptedModel([throwing(rejected)])).text({ model: 'm', system: 's', user: 'u' }),
      (error: unknown) =>
         error instanceof CompletionFailed && error.code === 'UPSTREAM_REJECTED' && !error.retryable
   );
});

test('a conversation is replayed as turns, and the last user turn is answered', async () => {
   const model = new ScriptedModel([say('Hi again.')]);
   const messages = [
      new Message({ role: 'user', content: [new TextBlock('hello')] }),
      new Message({ role: 'assistant', content: [new TextBlock('hi')] }),
      new Message({ role: 'user', content: [new TextBlock('hello again')] }),
   ];
   const result = await completion(model).converse({ model: 'm', system: 's', messages });
   assert.equal(result.value, 'Hi again.');
   assert.equal(model.received[0]?.length, 3);
});
