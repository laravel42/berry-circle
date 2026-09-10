import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactEnvelope, taskEnvelopeSchema, type TaskEnvelope } from './envelope.ts';

export function sampleEnvelope(overrides: Partial<TaskEnvelope> = {}): TaskEnvelope {
   return {
      kind: 'agent',
      runId: '11111111-1111-4111-8111-111111111111',
      sessionKey: 'a:i',
      runtimeSessionId: `berry-${'0'.repeat(64)}`,
      agent: {
         name: 'Builder',
         instructions: 'Be brief.',
         model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
         skills: [],
         mcpServers: [],
         permissions: ['read_repository'],
         maxTokens: null,
         temperature: null,
      },
      task: {
         prompt: 'Fix the bug',
         issue: { id: 'i', identifier: 'BER-1', title: 'Bug', description: null },
         comments: [],
         dependencies: [],
         projectResources: [],
         priorWork: null,
      },
      transcript: [],
      repo: null,
      completion: null,
      env: { SECRET_ENV: 'hunter2' },
      berry: { apiUrl: 'https://berry.example', token: 'berry_task_secret' },
      ...overrides,
   };
}

test('a complete envelope parses', () => {
   const parsed = taskEnvelopeSchema.safeParse(sampleEnvelope());
   assert.equal(parsed.success, true);
});

test('a session id shorter than AgentCore accepts is refused', () => {
   const parsed = taskEnvelopeSchema.safeParse(sampleEnvelope({ runtimeSessionId: 'berry-short' }));
   assert.equal(parsed.success, false);
});

test('a completion envelope carries its system prompt and schema', () => {
   const parsed = taskEnvelopeSchema.safeParse(
      sampleEnvelope({
         kind: 'completion',
         completion: { system: 'Answer in JSON', jsonSchema: { type: 'object' } },
      })
   );
   assert.equal(parsed.success, true);
});

test('a redacted envelope names no secret', () => {
   const text = JSON.stringify(
      redactEnvelope(
         sampleEnvelope({
            repo: {
               fullName: 'o/r',
               branch: 'b',
               baseBranch: 'main',
               credential: { username: 'x-access-token', password: 'ghs_secret' },
               verifyCommands: [],
               issueReference: 'BER-1',
               issueTitle: 'Bug',
            },
         })
      )
   );
   for (const secret of ['hunter2', 'berry_task_secret', 'ghs_secret']) {
      assert.equal(text.includes(secret), false, secret);
   }
});
