import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { platformMounts, type Capabilities } from './platform.ts';

/**
 * `/api/v1/config`, which is how the browser decides whether to offer sign-in.
 *
 * `githubSignIn` cannot be a fact about how the process started: the App it
 * needs is created from the browser while the server runs. So it is asked, and
 * the answer changes the moment the App does.
 */

const base: Capabilities = {
   agentExecution: false,
   metrics: true,
   realtime: true,
   storage: false,
   valkey: false,
   planner: false,
   githubSignIn: false,
};

function capabilitiesOf(capabilities: Capabilities) {
   const registry = new Registry();
   registry.registerAll(
      platformMounts({ database: async () => undefined, capabilities, version: 'test' })
   );
   const app = createApp(registry);
   return async () => {
      const body = (await (await app.request('/api/v1/config')).json()) as {
         capabilities: Record<string, boolean>;
      };
      return body.capabilities;
   };
}

test('a boolean capability is reported as it always was', async () => {
   const read = capabilitiesOf({ ...base, storage: true, githubSignIn: true });

   assert.deepEqual(await read(), {
      agentExecution: false,
      metrics: true,
      realtime: true,
      storage: true,
      valkey: false,
      planner: false,
      githubSignIn: true,
   });
});

test('githubSignIn is answered at the time of asking, and flips with the App', async () => {
   let signIn = false;
   const read = capabilitiesOf({ ...base, githubSignIn: async () => signIn });

   assert.equal((await read()).githubSignIn, false);
   // The App has just been created from the browser; no restart happened.
   signIn = true;
   assert.equal((await read()).githubSignIn, true);
   // And removed again.
   signIn = false;
   assert.equal((await read()).githubSignIn, false);
});
