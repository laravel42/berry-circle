import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GetAgentRuntimeCommand, UpdateAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { applyLifecycle, lifecycleFor } from './runtime-control.ts';

test('the default lifecycle is one idle hour inside an eight-hour life', () => {
   assert.deepEqual(lifecycleFor({ idleTimeoutS: 3600, maxLifetimeS: 28800 }, null), {
      idleRuntimeSessionTimeout: 3600,
      maxLifetime: 28800,
   });
});

test('a profile may change the idle timeout, never past the life or 28800 s', () => {
   assert.equal(lifecycleFor({ idleTimeoutS: 3600, maxLifetimeS: 28800 }, { idleTimeoutS: 7200 }).idleRuntimeSessionTimeout, 7200);
   assert.equal(lifecycleFor({ idleTimeoutS: 3600, maxLifetimeS: 1800 }, { idleTimeoutS: 7200 }).idleRuntimeSessionTimeout, 1800);
   assert.equal(lifecycleFor({ idleTimeoutS: 3600, maxLifetimeS: 99999 }, null).maxLifetime, 28800);
});

test('applying a lifecycle reads the runtime and writes it back with only the lifecycle changed', async () => {
   const sent: unknown[] = [];
   const client = {
      send: async (command: unknown) => {
         sent.push(command);
         if (command instanceof GetAgentRuntimeCommand) {
            return {
               agentRuntimeId: 'berry-abc',
               agentRuntimeArtifact: { containerConfiguration: { containerUri: 'x' } },
               roleArn: 'arn:aws:iam::1:role/r',
               networkConfiguration: { networkMode: 'PUBLIC' },
               lifecycleConfiguration: { idleRuntimeSessionTimeout: 900, maxLifetime: 28800 },
            };
         }
         return {};
      },
   };
   await applyLifecycle(client as never, 'arn:aws:bedrock-agentcore:us-east-1:1:runtime/berry-abc', {
      idleRuntimeSessionTimeout: 3600,
      maxLifetime: 28800,
   });
   const update = sent[1];
   assert.ok(update instanceof UpdateAgentRuntimeCommand);
   assert.equal(update.input.agentRuntimeId, 'berry-abc');
   assert.equal(update.input.roleArn, 'arn:aws:iam::1:role/r');
   assert.deepEqual(update.input.lifecycleConfiguration, { idleRuntimeSessionTimeout: 3600, maxLifetime: 28800 });
});
