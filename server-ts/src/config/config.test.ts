import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from './config.ts';

/**
 * The credential fallbacks, against the environment Compose actually passes.
 *
 * Compose hands an unset variable down as an empty string, so a fallback
 * written with `??` never falls: the empty AgentCore key counted as
 * configured, the clients got no credential, and the default chain found
 * MinIO's key — refused by AWS as an invalid security token.
 */

const base = {
   DATABASE_URL: 'postgres://berry:berry@localhost:5432/berry',
   BERRY_BEDROCK_REGION: 'us-east-1',
   BERRY_BEDROCK_ACCESS_KEY_ID: 'AKIABEDROCK',
   BERRY_BEDROCK_SECRET_ACCESS_KEY: 'bedrock-secret',
};

test('an empty AgentCore key falls through to the Bedrock one', () => {
   const config = loadConfig({
      ...base,
      BERRY_AGENTCORE_ACCESS_KEY_ID: '',
      BERRY_AGENTCORE_SECRET_ACCESS_KEY: '',
      BERRY_AGENTCORE_SESSION_TOKEN: '',
   });
   assert.equal(config.agentCore?.credentials?.accessKeyId, 'AKIABEDROCK');
   assert.equal(config.agentCore?.credentials?.secretAccessKey, 'bedrock-secret');
});

test('a named AgentCore key is preferred over the Bedrock one', () => {
   const config = loadConfig({ ...base, BERRY_AGENTCORE_ACCESS_KEY_ID: 'AKIACORE', BERRY_AGENTCORE_SECRET_ACCESS_KEY: 'core-secret' });
   assert.equal(config.agentCore?.credentials?.accessKeyId, 'AKIACORE');
});

test('no key at all means the default chain, as before', () => {
   const config = loadConfig({ DATABASE_URL: base.DATABASE_URL, BERRY_BEDROCK_REGION: 'us-east-1' });
   assert.equal(config.agentCore?.credentials, null);
});

test('the runtime section reads the local runtime URL and token lifetime', () => {
   const config = loadConfig({
      ...base,
      BERRY_AGENT_RUNTIME_URL: 'http://agent-runtime:8080/',
      BERRY_TASK_TOKEN_TTL_SECONDS: '3600',
   });
   assert.equal(config.runtime.agentRuntimeUrl, 'http://agent-runtime:8080');
   assert.equal(config.runtime.tokenTtlSeconds, 3600);
   assert.equal(config.runtime.concurrency, 2);
});

test('the runtime section needs no Bedrock region: the server calls no model', () => {
   const config = loadConfig({ ...base, BERRY_BEDROCK_REGION: '', AWS_REGION: '' });
   assert.equal(config.runtime.defaultModel, 'us.anthropic.claude-haiku-4-5-20251001-v1:0');
});
