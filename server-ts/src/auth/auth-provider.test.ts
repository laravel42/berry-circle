import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { AuthProvider } from './auth-provider.ts';
import type { BerryAuth, BerryAuthOptions } from './better-auth.ts';

/**
 * Where sign-in gets its GitHub credentials, and when it is rebuilt.
 *
 * The App is created from the browser, which means the credentials sign-in
 * needs arrive *after* the process started. So the instance is built on first
 * use and rebuilt when the credentials change — once per credential set, not
 * once per request.
 */

const base = {
   pool: {} as never,
   secret: 'a'.repeat(32),
   baseUrl: 'http://localhost:3000',
   trustedOrigins: ['http://localhost:3000'],
   sessionTtlMs: 60_000,
};

/** Records what each build was given, and hands back a distinguishable auth. */
function recorder() {
   const built: Array<BerryAuthOptions['github']> = [];
   const create = (options: BerryAuthOptions): BerryAuth => {
      built.push(options.github);
      return { generation: built.length } as unknown as BerryAuth;
   };
   return { built, create };
}

/** An App in the database, with credentials the test can rotate. */
function storedApp(initial: { clientId: string; clientSecret: string } | null) {
   let current = initial;
   let revision = 0;
   return {
      rotate(next: { clientId: string; clientSecret: string } | null) {
         current = next;
         revision += 1;
      },
      source: {
         fingerprint: async () => (current ? `${current.clientId}@${revision}` : null),
         credentials: async () => current,
      },
   };
}

describe('the auth provider', () => {
   test("signs in with the App's credentials when the database holds one", async () => {
      const { built, create } = recorder();
      const app = storedApp({ clientId: 'db-id', clientSecret: 'db-secret' });
      const provider = new AuthProvider({
         ...base,
         fallback: null,
         stored: app.source,
         create,
      });

      await provider.instance();

      assert.deepEqual(built, [{ clientId: 'db-id', clientSecret: 'db-secret' }]);
   });

   test('falls back to the configured OAuth App when the database holds none', async () => {
      const { built, create } = recorder();
      const provider = new AuthProvider({
         ...base,
         fallback: { clientId: 'env-id', clientSecret: 'env-secret' },
         stored: storedApp(null).source,
         create,
      });

      await provider.instance();

      assert.deepEqual(built, [{ clientId: 'env-id', clientSecret: 'env-secret' }]);
   });

   test("the App's credentials win over the ones in the environment", async () => {
      const { built, create } = recorder();
      const provider = new AuthProvider({
         ...base,
         fallback: { clientId: 'env-id', clientSecret: 'env-secret' },
         stored: storedApp({ clientId: 'db-id', clientSecret: 'db-secret' }).source,
         create,
      });

      await provider.instance();

      assert.deepEqual(built, [{ clientId: 'db-id', clientSecret: 'db-secret' }]);
   });

   test('builds one instance per credential set, not one per use', async () => {
      const { built, create } = recorder();
      const provider = new AuthProvider({
         ...base,
         fallback: null,
         stored: storedApp({ clientId: 'db-id', clientSecret: 'db-secret' }).source,
         create,
      });

      const first = await provider.instance();
      const second = await provider.instance();

      assert.equal(first, second);
      assert.equal(built.length, 1);
   });

   test('rebuilds when the App is created, changed or removed', async () => {
      const { built, create } = recorder();
      const app = storedApp(null);
      const provider = new AuthProvider({
         ...base,
         fallback: null,
         stored: app.source,
         create,
      });

      const before = await provider.instance();
      app.rotate({ clientId: 'db-id', clientSecret: 'db-secret' });
      const created = await provider.instance();
      app.rotate({ clientId: 'db-id', clientSecret: 'rotated' });
      const changed = await provider.instance();
      app.rotate(null);
      const removed = await provider.instance();

      assert.notEqual(before, created);
      assert.notEqual(created, changed);
      assert.notEqual(changed, removed);
      assert.deepEqual(built, [
         null,
         { clientId: 'db-id', clientSecret: 'db-secret' },
         { clientId: 'db-id', clientSecret: 'rotated' },
         null,
      ]);
   });

   test('two requests arriving together build one instance', async () => {
      const { built, create } = recorder();
      const provider = new AuthProvider({
         ...base,
         fallback: null,
         stored: storedApp({ clientId: 'db-id', clientSecret: 'db-secret' }).source,
         create,
      });

      const [first, second] = await Promise.all([provider.instance(), provider.instance()]);

      assert.equal(first, second);
      assert.equal(built.length, 1);
   });

   test('reports whether GitHub sign-in is possible now, from either source', async () => {
      const { create } = recorder();
      const app = storedApp(null);
      const fromDatabase = new AuthProvider({ ...base, fallback: null, stored: app.source, create });
      const fromEnvironment = new AuthProvider({
         ...base,
         fallback: { clientId: 'env-id', clientSecret: 'env-secret' },
         stored: storedApp(null).source,
         create,
      });

      assert.equal(await fromDatabase.githubSignIn(), false);
      app.rotate({ clientId: 'db-id', clientSecret: 'db-secret' });
      assert.equal(await fromDatabase.githubSignIn(), true);
      assert.equal(await fromEnvironment.githubSignIn(), true);
   });

   test('a stored credential that cannot be read leaves sign-in on the fallback', async () => {
      const { built, create } = recorder();
      const failures: unknown[] = [];
      const provider = new AuthProvider({
         ...base,
         fallback: { clientId: 'env-id', clientSecret: 'env-secret' },
         stored: {
            fingerprint: async () => {
               throw new Error('the sealing key does not open this row');
            },
            credentials: async () => null,
         },
         create,
         onError: (error) => failures.push(error),
      });

      await provider.instance();

      assert.deepEqual(built, [{ clientId: 'env-id', clientSecret: 'env-secret' }]);
      assert.equal(await provider.githubSignIn(), true);
      assert.equal(failures.length > 0, true);
   });
});
