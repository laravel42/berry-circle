import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LlmRequest } from '@google/adk';
import type { Schema } from '@google/genai';
import {
   OpenRouterError,
   OpenRouterLlm,
   parseCompletion,
   toJsonSchema,
   toOpenAIMessages,
   toOpenAITools,
} from './openrouter-llm.ts';

/**
 * These run without a network. The live checks — a completion, a stream, a
 * tool round trip, and a real LlmAgent driving all three — were run against
 * OpenRouter directly; what is pinned here is the translation between ADK's
 * Google GenAI types and OpenAI chat completions, which is where the two
 * disagree and where an agent breaks quietly rather than loudly.
 */

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
   return { contents: [], liveConnectConfig: {}, toolsDict: {}, ...overrides } as LlmRequest;
}

/** A fetch that returns one canned JSON body and records what it was sent. */
function stubFetch(payload: unknown, status = 200) {
   const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
   const impl = (async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(payload), {
         status,
         headers: { 'content-type': 'application/json' },
      });
   }) as unknown as typeof fetch;
   return { impl, sent };
}

function llm(fetchImpl: typeof fetch): OpenRouterLlm {
   return new OpenRouterLlm({ model: 'openai/gpt-5.4-nano', apiKey: 'test-key', fetchImpl });
}

const COMPLETION = {
   choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
   usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
};

test('a completion becomes one final response with usage', async () => {
   const { impl } = stubFetch(COMPLETION);
   const responses = [];
   for await (const response of llm(impl).generateContentAsync(
      request({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }] })
   )) {
      responses.push(response);
   }

   assert.equal(responses.length, 1);
   assert.equal(responses[0]?.content?.parts?.[0]?.text, 'pong');
   assert.equal(responses[0]?.turnComplete, true);
   assert.deepEqual(responses[0]?.usageMetadata, {
      promptTokenCount: 11,
      candidatesTokenCount: 5,
      totalTokenCount: 16,
   });
});

test('a system instruction reaches the model as a system message', () => {
   // It lives in config, not in contents. An agent whose instructions silently
   // failed to arrive looks like a badly written prompt.
   const messages = toOpenAIMessages(
      request({
         contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
         config: { systemInstruction: 'You are Berry.' },
      })
   );
   assert.deepEqual(messages[0], { role: 'system', content: 'You are Berry.' });
   assert.equal(messages[1]?.role, 'user');
});

test('a system instruction given as Content is flattened', () => {
   const messages = toOpenAIMessages(
      request({ config: { systemInstruction: { parts: [{ text: 'a' }, { text: 'b' }] } } })
   );
   assert.equal(messages[0]?.content, 'a\nb');
});

test('the model role becomes assistant, and a tool result its own message', () => {
   const messages = toOpenAIMessages(
      request({
         contents: [
            { role: 'user', parts: [{ text: 'weather?' }] },
            {
               role: 'model',
               parts: [{ functionCall: { id: 'call_1', name: 'get_weather', args: { city: 'Oslo' } } }],
            },
            {
               role: 'user',
               parts: [
                  { functionResponse: { id: 'call_1', name: 'get_weather', response: { tempC: 7 } } },
               ],
            },
         ],
      })
   );

   assert.equal(messages[1]?.role, 'assistant', 'ADK says model, OpenAI says assistant');
   assert.deepEqual(messages[1]?.tool_calls, [
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } },
   ]);
   assert.equal(messages[1]?.content, null, 'a call with no prose carries no content');

   assert.equal(messages[2]?.role, 'tool');
   assert.equal(messages[2]?.tool_call_id, 'call_1');
   assert.equal(messages[2]?.content, '{"tempC":7}');
});

test('a thought part is not sent as prose', () => {
   const messages = toOpenAIMessages(
      request({
         contents: [{ role: 'model', parts: [{ text: 'reasoning', thought: true }, { text: 'answer' }] }],
      })
   );
   assert.equal(messages[0]?.content, 'answer');
});

test("ADK's uppercase schema types are lowered", () => {
   // ADK emits Google's Schema, whose type is an uppercase enum. OpenRouter
   // answers `400 Provider returned error` and says nothing about casing,
   // which makes this the most confusing failure in the integration.
   const lowered = toJsonSchema({
      type: 'OBJECT',
      properties: {
         city: { type: 'STRING' },
         days: { type: 'ARRAY', items: { type: 'INTEGER' } },
         nested: { type: 'OBJECT', properties: { flag: { type: 'BOOLEAN' } } },
      },
      required: ['city'],
   });

   assert.equal(lowered?.type, 'object');
   const properties = lowered?.properties as Record<string, Record<string, unknown>>;
   assert.equal(properties.city?.type, 'string');
   assert.equal(properties.days?.type, 'array');
   assert.equal((properties.days?.items as Record<string, unknown>)?.type, 'integer');
   assert.equal(
      ((properties.nested?.properties as Record<string, Record<string, unknown>>)?.flag)?.type,
      'boolean'
   );
   assert.deepEqual(lowered?.required, ['city'], 'non-type values are untouched');
});

test('a tool declaration becomes an OpenAI function', () => {
   const tools = toOpenAITools(
      request({
         config: {
            tools: [
               {
                  functionDeclarations: [
                     {
                        name: 'get_weather',
                        description: 'Current weather.',
                        // Cast because GenAI types this as an enum; the point
                        // of the test is that the wire value is uppercase.
                        parameters: {
                           type: 'OBJECT',
                           properties: { city: { type: 'STRING' } },
                        } as unknown as Schema,
                     },
                  ],
               },
            ],
         },
      })
   );

   assert.equal(tools.length, 1);
   const fn = tools[0]?.function as Record<string, unknown>;
   assert.equal(fn.name, 'get_weather');
   assert.equal((fn.parameters as Record<string, unknown>).type, 'object');
});

test('a tool with no parameters still declares an object', () => {
   // OpenRouter rejects a function whose parameters are absent.
   const tools = toOpenAITools(
      request({ config: { tools: [{ functionDeclarations: [{ name: 'ping' }] }] } })
   );
   assert.deepEqual((tools[0]?.function as Record<string, unknown>).parameters, {
      type: 'object',
      properties: {},
   });
});

test('a tool call comes back as a functionCall part with parsed arguments', () => {
   const response = parseCompletion({
      choices: [
         {
            message: {
               role: 'assistant',
               content: null,
               tool_calls: [
                  { id: 'call_9', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } },
               ],
            },
            finish_reason: 'tool_calls',
         },
      ],
   });

   const call = response.content?.parts?.[0]?.functionCall;
   assert.equal(call?.name, 'get_weather');
   assert.deepEqual(call?.args, { city: 'Oslo' });
   assert.equal(response.finishReason, 'STOP', 'tool_calls is a normal stop');
});

test('malformed tool arguments yield an empty object rather than throwing', () => {
   // A model that emits broken JSON should leave the agent with a call it can
   // refuse, not kill the turn.
   const response = parseCompletion({
      choices: [
         {
            message: {
               tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{oops' } }],
            },
         },
      ],
   });
   assert.deepEqual(response.content?.parts?.[0]?.functionCall?.args, {});
});

test('a stream yields partials and one final response', async () => {
   const chunks = [
      'data: {"choices":[{"delta":{"content":"one "}}]}',
      'data: {"choices":[{"delta":{"content":"two "}}]}',
      'data: {"choices":[{"delta":{"content":"three"},"finish_reason":"stop"}]}',
      'data: {"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}',
      'data: [DONE]',
   ].join('\n\n');
   const impl = (async () =>
      new Response(chunks, { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;

   const partials: string[] = [];
   let final;
   for await (const response of llm(impl).generateContentAsync(request(), true)) {
      if (response.partial) partials.push(response.content?.parts?.[0]?.text ?? '');
      else final = response;
   }

   assert.deepEqual(partials, ['one ', 'two ', 'three']);
   assert.equal(final?.content?.parts?.[0]?.text, 'one two three');
   assert.equal(final?.usageMetadata?.totalTokenCount, 18);
});

test('tool call arguments fragmented across deltas are reassembled', async () => {
   // Arguments arrive in pieces keyed by index. Half a JSON object is not a
   // tool call, and forwarding one would invoke a tool with arguments that do
   // not parse.
   const chunks = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"ci"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"Os"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"lo\\"}"}}]},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
   ].join('\n\n');
   const impl = (async () => new Response(chunks)) as unknown as typeof fetch;

   let final;
   for await (const response of llm(impl).generateContentAsync(request(), true)) {
      if (!response.partial) final = response;
   }
   const call = final?.content?.parts?.[0]?.functionCall;
   assert.equal(call?.name, 'get_weather');
   assert.deepEqual(call?.args, { city: 'Oslo' }, 'reassembled, not emitted in pieces');
});

test('an unparseable stream line is skipped rather than fatal', async () => {
   // OpenRouter interleaves keep-alive comments.
   const chunks = [
      ': keep-alive',
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      'data: not json',
      'data: [DONE]',
   ].join('\n\n');
   const impl = (async () => new Response(chunks)) as unknown as typeof fetch;

   let final;
   for await (const response of llm(impl).generateContentAsync(request(), true)) {
      if (!response.partial) final = response;
   }
   assert.equal(final?.content?.parts?.[0]?.text, 'ok');
});

test('a failed request carries its status and says whether to retry', async () => {
   for (const [status, retryable] of [
      [400, false],
      [401, false],
      [429, true],
      [502, true],
   ] as const) {
      const { impl } = stubFetch({ error: 'nope' }, status);
      await assert.rejects(
         async () => {
            for await (const _ of llm(impl).generateContentAsync(request())) void _;
         },
         (error: unknown) => {
            assert.ok(error instanceof OpenRouterError);
            assert.equal(error.status, status);
            assert.equal(error.retryable, retryable, `status ${status}`);
            return true;
         }
      );
   }
});

test('generation config is translated to OpenAI parameter names', async () => {
   const { impl, sent } = stubFetch(COMPLETION);
   for await (const _ of llm(impl).generateContentAsync(
      request({
         config: {
            temperature: 0.2,
            topP: 0.9,
            maxOutputTokens: 512,
            stopSequences: ['END'],
            responseMimeType: 'application/json',
         },
      })
   )) {
      void _;
   }

   const body = sent[0]!.body;
   assert.equal(body.temperature, 0.2);
   assert.equal(body.top_p, 0.9);
   assert.equal(body.max_tokens, 512);
   assert.deepEqual(body.stop, ['END']);
   assert.deepEqual(body.response_format, { type: 'json_object' });
});

test('live connections are refused rather than faked', async () => {
   // ADK's connect is for models with a duplex socket. Returning something
   // connection-shaped that never delivers would be worse than refusing.
   await assert.rejects(() => llm(stubFetch({}).impl).connect(request()), /does not support live/);
});

test('every OpenRouter model id is claimed by the registry pattern', () => {
   const patterns = OpenRouterLlm.supportedModels;
   const matches = (id: string) =>
      patterns.some((p) => (typeof p === 'string' ? p === id : p.test(id)));
   assert.ok(matches('openai/gpt-5.4-nano'));
   assert.ok(matches('anthropic/claude-sonnet-5'));
   assert.ok(matches('inclusionai/ling-3.0-flash'));
   assert.ok(!matches('gemini-2.0-flash'), 'a bare id is left to another provider');
});
