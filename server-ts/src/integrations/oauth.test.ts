import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import {
   AuthorizationNotPending,
   ExchangeFailed,
   OAuthStateStore,
   exchangeGitHubCode,
   githubAuthorizeUrl,
} from './oauth.ts';
import { deleteWorkspaceBoards } from '../test-support/boards.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';

/**
 * The OAuth handshake.
 *
 * The exchange is tested against a fake `fetch`, because what matters is how
 * this code reads GitHub's answers — including the ones GitHub sends with a
 * 200. The state store is tested against a real PostgreSQL, because
 * single-use is a property of the UPDATE and a fake would agree with whatever
 * the code did.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

const CREDENTIALS = { clientId: 'client-id', clientSecret: 'client-secret' };

test('the authorize URL carries everything the provider needs, and no secret', () => {
   const link = new URL(
      githubAuthorizeUrl(CREDENTIALS, {
         state: 'opaque-state',
         redirectUri: 'https://berry.example/api/v1/integrations/callback/github',
         scopes: ['repo', 'read:org'],
      })
   );
   assert.equal(link.origin + link.pathname, 'https://github.com/login/oauth/authorize');
   assert.equal(link.searchParams.get('client_id'), 'client-id');
   assert.equal(link.searchParams.get('state'), 'opaque-state');
   assert.equal(link.searchParams.get('scope'), 'repo read:org');
   // The client secret is for the exchange, which happens server to server.
   assert.ok(!link.search.includes('client-secret'));
});

test('an exchange returns the credential and who it belongs to', async () => {
   const calls: string[] = [];
   const exchanged = await exchangeGitHubCode(
      {
         ...CREDENTIALS,
         fetch: (async (input: unknown) => {
            const target = String(input);
            calls.push(target);
            if (target.includes('/login/oauth/access_token')) {
               return Response.json({ access_token: 'gho_token', scope: 'repo,read:org' });
            }
            return Response.json({ id: 4711, login: 'octocat' });
         }) as unknown as typeof globalThis.fetch,
      },
      { code: 'the-code', redirectUri: 'https://berry.example/cb' }
   );

   assert.equal(exchanged.accessToken, 'gho_token');
   assert.deepEqual(exchanged.scopes, ['repo', 'read:org']);
   assert.equal(exchanged.accountName, 'octocat');
   assert.equal(exchanged.accountId, '4711');
   assert.equal(calls.length, 2);
});

test('GitHub reports a refusal with a 200, and it is still a refusal', async () => {
   // The failure this guards: a 200 with an `error` body read as success
   // stores an empty token and the connection looks fine until a run fails.
   await assert.rejects(
      () =>
         exchangeGitHubCode(
            {
               ...CREDENTIALS,
               fetch: (async () =>
                  Response.json({ error: 'bad_verification_code' })) as unknown as typeof globalThis.fetch,
            },
            { code: 'stale', redirectUri: 'https://berry.example/cb' }
         ),
      (error: unknown) => {
         assert.ok(error instanceof ExchangeFailed);
         assert.equal(error.outcome, 'exchange_failed');
         return true;
      }
   );
});

test('a denial is told apart from a failure, because the words differ', async () => {
   await assert.rejects(
      () =>
         exchangeGitHubCode(
            {
               ...CREDENTIALS,
               fetch: (async () =>
                  Response.json({ error: 'access_denied' })) as unknown as typeof globalThis.fetch,
            },
            { code: 'x', redirectUri: 'https://berry.example/cb' }
         ),
      (error: unknown) => {
         assert.ok(error instanceof ExchangeFailed);
         assert.equal(error.outcome, 'denied');
         return true;
      }
   );
});

test('a body with no token is not a connection', async () => {
   await assert.rejects(
      () =>
         exchangeGitHubCode(
            {
               ...CREDENTIALS,
               fetch: (async () => Response.json({ scope: 'repo' })) as unknown as typeof globalThis.fetch,
            },
            { code: 'x', redirectUri: 'https://berry.example/cb' }
         ),
      (error: unknown) => {
         assert.ok(error instanceof ExchangeFailed);
         assert.equal(error.outcome, 'invalid_response');
         return true;
      }
   );
});

test('the account lookup failing does not lose a working credential', async () => {
   // The token is the point; the login is a label. Losing the connection
   // because GitHub was slow to say who it belongs to would be absurd.
   const exchanged = await exchangeGitHubCode(
      {
         ...CREDENTIALS,
         fetch: (async (input: unknown) => {
            if (String(input).includes('/login/oauth/access_token')) {
               return Response.json({ access_token: 'gho_token' });
            }
            throw new Error('github is down');
         }) as unknown as typeof globalThis.fetch,
      },
      { code: 'x', redirectUri: 'https://berry.example/cb' }
   );
   assert.equal(exchanged.accessToken, 'gho_token');
   assert.equal(exchanged.accountName, null);
});

describe('oauth state store', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   const fixture = { workspaceId: '', userId: '' };

   before(async () => {
      sql = openDatabase({ url: url! });
      const [user] = await sql`
         INSERT INTO users (id, email, name)
         VALUES (${randomUUID()}, ${`oauth-${randomUUID().slice(0, 8)}@berry.test`}, 'OAuth Test')
         RETURNING id`;
      fixture.userId = user!.id as string;
      const suffix = randomUUID().slice(0, 8);
      const [workspace] = await sql`
         INSERT INTO workspaces (id, name, slug, settings, created_by)
         VALUES (${randomUUID()}, ${`OAuth ${suffix}`}, ${`oauth-${suffix}`},
                 ${sql.json({ issuePrefix: 'OAU', defaultRole: 'member', allowMemberInvites: false } as never)},
                 ${fixture.userId})
         RETURNING id`;
      fixture.workspaceId = workspace!.id as string;
   });

   after(async () => {
      await sql`DELETE FROM integration_oauth_states WHERE workspace_id = ${fixture.workspaceId}`;
      await sql`DELETE FROM integration_oauth_states WHERE workspace_id IS NULL`;
      await deleteWorkspaceAgents(sql, [fixture.workspaceId]);
      await deleteWorkspaceBoards(sql, [fixture.workspaceId]);
      await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${fixture.workspaceId}`;
      await sql`DELETE FROM workspaces WHERE id = ${fixture.workspaceId}`;
      await sql`DELETE FROM users WHERE id = ${fixture.userId}`;
      await closeDatabase(sql);
   });

   test('a state names the workspace and the person who started the flow', async () => {
      const store = new OAuthStateStore({ sql });
      const pending = await store.start({ ...fixture, provider: 'github', redirectUri: 'https://b/cb', scopes: ['repo'] });

      const resolved = await store.consume(pending.state);
      assert.equal(resolved.workspaceId, fixture.workspaceId);
      assert.equal(resolved.userId, fixture.userId);
      assert.equal(resolved.provider, 'github');
      assert.deepEqual(resolved.scopes, ['repo']);
   });

   test('the state is stored as a hash, never as itself', async () => {
      // The row is a bearer credential for the callback. If it were readable,
      // anyone with database access could finish someone else's handshake.
      const store = new OAuthStateStore({ sql });
      const pending = await store.start({ ...fixture, provider: 'github', redirectUri: 'https://b/cb', scopes: [] });

      const rows = await sql`
         SELECT encode(state_hash, 'hex') AS hex FROM integration_oauth_states
          WHERE workspace_id = ${fixture.workspaceId}`;
      for (const row of rows) {
         assert.ok(!(row.hex as string).includes(Buffer.from(pending.state).toString('hex')));
      }
   });

   test('a state works once', async () => {
      // A replayed callback would attach a second credential from a code the
      // provider has already spent, or worse, attach someone else's.
      const store = new OAuthStateStore({ sql });
      const pending = await store.start({ ...fixture, provider: 'github', redirectUri: 'https://b/cb', scopes: [] });

      await store.consume(pending.state);
      await assert.rejects(() => store.consume(pending.state), AuthorizationNotPending);
   });

   test('an expired state is not a state', async () => {
      // Aged by moving the row's own clock back rather than by writing an
      // already-dead one: the table checks `expires_at > created_at`, so a
      // state that was never valid cannot be inserted at all.
      const store = new OAuthStateStore({ sql });
      const pending = await store.start({ ...fixture, provider: 'github', redirectUri: 'https://b/cb', scopes: [] });
      await age(sql, fixture.workspaceId);

      await assert.rejects(() => store.consume(pending.state), AuthorizationNotPending);
   });

   test('a first-run setup state names no workspace and no user', async () => {
      // Creating the App is the one flow that runs before either exists: the
      // deployment has no user because sign-in is what the App is for.
      const store = new OAuthStateStore({ sql });
      const pending = await store.start({
         workspaceId: null,
         userId: null,
         provider: 'github_app',
         redirectUri: 'https://b/cb',
         scopes: [],
      });

      const resolved = await store.consume(pending.state);
      assert.equal(resolved.workspaceId, null);
      assert.equal(resolved.userId, null);
      assert.equal(resolved.provider, 'github_app');
   });

   test('a state nobody started is refused', async () => {
      const store = new OAuthStateStore({ sql });
      await assert.rejects(() => store.consume('not-a-state'), AuthorizationNotPending);
   });

   test('sweeping clears the expired and leaves the live', async () => {
      const store = new OAuthStateStore({ sql });
      await store.start({ ...fixture, provider: 'github', redirectUri: 'https://b/cb', scopes: [] });
      await age(sql, fixture.workspaceId);
      const kept = await store.start({ ...fixture, provider: 'github', redirectUri: 'https://b/cb', scopes: [] });

      await store.sweep();
      const [remaining] = await sql`
         SELECT count(*)::int AS n FROM integration_oauth_states
          WHERE workspace_id = ${fixture.workspaceId}`;
      assert.equal(remaining!.n, 1);
      // And the one that survived is the live one.
      assert.equal((await store.consume(kept.state)).workspaceId, fixture.workspaceId);
   });
});

/** Moves every state of this workspace into the past, constraint included. */
async function age(sql: Sql, workspaceId: string): Promise<void> {
   await sql`
      UPDATE integration_oauth_states
         SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
       WHERE workspace_id = ${workspaceId}`;
}
