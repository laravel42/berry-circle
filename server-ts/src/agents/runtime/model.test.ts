import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BedrockModel } from '@strands-agents/sdk';
import { bedrockModel, DEFAULT_MAX_TOKENS } from './model.ts';

/**
 * The one place a Bedrock model is built. What matters is that the spec
 * survives into the model: the id, the ceiling, and — the bug this replaces —
 * the explicit credentials rather than the AWS default chain.
 */

test('the spec reaches the model: id, tokens, temperature', () => {
   const model = bedrockModel({
      model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      region: 'us-east-1',
      maxTokens: 1234,
      temperature: 0.2,
   });
   assert.ok(model instanceof BedrockModel);
   const config = model.getConfig();
   assert.equal(config.modelId, 'us.anthropic.claude-haiku-4-5-20251001-v1:0');
   assert.equal(config.maxTokens, 1234);
   assert.equal(config.temperature, 0.2);
});

test('a completion can ask for the non-streaming API', () => {
   const config = bedrockModel({ model: 'm', region: 'us-east-1', stream: false }).getConfig();
   assert.equal(config.stream, false);
   assert.equal(bedrockModel({ model: 'm', region: 'us-east-1' }).getConfig().stream, undefined);
});

test('a family that accepts less than the default is clamped, not refused', () => {
   assert.equal(bedrockModel({ model: 'us.amazon.nova-pro-v1:0', region: 'r' }).getConfig().maxTokens, 10_000);
   assert.equal(bedrockModel({ model: 'us.amazon.nova-lite-v1:0', region: 'r' }).getConfig().maxTokens, 5_000);
   assert.equal(bedrockModel({ model: 'us.amazon.nova-pro-v1:0', region: 'r', maxTokens: 2_000 }).getConfig().maxTokens, 2_000);
   assert.equal(bedrockModel({ model: 'us.anthropic.claude-sonnet-4-6', region: 'r' }).getConfig().maxTokens, DEFAULT_MAX_TOKENS);
});

test('omitted inference options fall back to the documented ceiling', () => {
   const config = bedrockModel({ model: 'm', region: 'us-east-1' }).getConfig();
   assert.equal(config.maxTokens, DEFAULT_MAX_TOKENS);
   assert.equal(config.temperature, undefined);
});

test('explicit credentials are handed to the client, not the default chain', async () => {
   const model = bedrockModel({
      model: 'm',
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
   });
   // The SDK keeps the client private; the credentials it resolves are what
   // matter, and reaching in is the only way to see them without a request.
   const client = (model as unknown as { _client: { config: { credentials: () => Promise<{ accessKeyId: string }> } } })._client;
   const resolved = await client.config.credentials();
   assert.equal(resolved.accessKeyId, 'AKIAEXAMPLE');
});
