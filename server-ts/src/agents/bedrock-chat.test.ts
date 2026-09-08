import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BedrockChat, BedrockUnavailable, readJson } from './bedrock-chat.ts';

/**
 * The single-completion path, against a fake Bedrock client.
 *
 * Offline on purpose: a test that reached Bedrock would test AWS's uptime and
 * the account's model access, neither of which is what this file decides.
 */

function client(reply: unknown) {
   const sent: Array<Record<string, unknown>> = [];
   return {
      sent,
      client: {
         async send(command: { input: Record<string, unknown> }) {
            sent.push(command.input);
            if (reply instanceof Error) throw reply;
            return reply;
         },
      } as never,
   };
}

function named(name: string): Error {
   const error = new Error(name);
   error.name = name;
   return error;
}

test('an answer comes back as text with its token usage', async () => {
   const fake = client({
      output: { message: { content: [{ text: 'the answer' }] } },
      usage: { inputTokens: 12, outputTokens: 34 },
   });
   const chat = new BedrockChat({ region: 'us-east-1', client: fake.client });

   const result = await chat.chat({ model: 'us.anthropic.x', system: 'be brief', user: 'hello' });
   assert.equal(result.text, 'the answer');
   assert.equal(result.inputTokens, 12);
   assert.equal(result.outputTokens, 34);
});

test('several content blocks arrive as one string', async () => {
   const fake = client({
      output: { message: { content: [{ text: 'one ' }, { text: 'two' }] } },
   });
   const chat = new BedrockChat({ region: 'us-east-1', client: fake.client });
   assert.equal((await chat.chat({ model: 'm', system: 's', user: 'u' })).text, 'one two');
});

test('asking for JSON says so in the system prompt', async () => {
   // Bedrock has no cross-family response_format, so this is an instruction
   // rather than a guarantee — which is why callers still parse defensively.
   const fake = client({ output: { message: { content: [{ text: '{}' }] } } });
   const chat = new BedrockChat({ region: 'us-east-1', client: fake.client });

   await chat.chat({ model: 'm', system: 'plan it', user: 'u', json: true });
   const system = (fake.sent[0]!.system as Array<{ text: string }>)[0]!.text;
   assert.match(system, /plan it/);
   assert.match(system, /JSON only/);
});

test('throttling is retryable and a bad model id is not', async () => {
   // Retrying a ValidationException wastes a minute to reach the same place.
   const throttled = new BedrockChat({
      region: 'us-east-1',
      client: client(named('ThrottlingException')).client,
   });
   await assert.rejects(throttled.chat({ model: 'm', system: 's', user: 'u' }), (e: BedrockUnavailable) => {
      assert.equal(e.retryable, true);
      return true;
   });

   const invalid = new BedrockChat({
      region: 'us-east-1',
      client: client(named('ValidationException')).client,
   });
   await assert.rejects(invalid.chat({ model: 'm', system: 's', user: 'u' }), (e: BedrockUnavailable) => {
      assert.equal(e.retryable, false);
      return true;
   });
});

test('the failure names the model, because a wrong id is the usual cause', async () => {
   const chat = new BedrockChat({
      region: 'us-east-1',
      client: client(named('ValidationException')).client,
   });
   await assert.rejects(
      chat.chat({ model: 'anthropic/claude-sonnet-4', system: 's', user: 'u' }),
      /anthropic\/claude-sonnet-4/
   );
});

test('an empty answer is empty text, not a crash', async () => {
   const chat = new BedrockChat({ region: 'us-east-1', client: client({}).client });
   assert.equal((await chat.chat({ model: 'm', system: 's', user: 'u' })).text, '');
});

test('fenced JSON is recovered, because models fence it anyway', () => {
   assert.deepEqual(readJson('```json\n{"a":1}\n```'), { a: 1 });
   assert.deepEqual(readJson('{"a":1}'), { a: 1 });
});

test('JSON after a sentence is recovered rather than lost to punctuation', () => {
   assert.deepEqual(readJson('Here you go: {"a":1} — hope that helps'), { a: 1 });
});

test('an answer with no JSON in it is null, not a throw', () => {
   // The caller decides what a missing answer means; this only reports it.
   assert.equal(readJson('I could not do that'), null);
});
