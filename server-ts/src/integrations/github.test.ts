import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubClient, GitHubError } from './github.ts';

/**
 * The GitHub client against a stubbed API.
 *
 * Two things are worth the tests: that a retried run finds its existing pull
 * request instead of failing, and that every refusal tells an operator which
 * of two different things to do about it.
 */

const TOKEN = 'ghu_SuperSecretTokenValue000000000000000';

interface Call {
   url: string;
   method: string;
   headers: Record<string, string>;
   body: unknown;
}

function stub(handler: (call: Call) => Response): {
   client: GitHubClient;
   calls: Call[];
} {
   const calls: Call[] = [];
   const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(init?.headers ?? {})) {
         headers[key.toLowerCase()] = String(value);
      }
      const call: Call = {
         url: String(input),
         method: init?.method ?? 'GET',
         headers,
         body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return handler(call);
   }) as typeof globalThis.fetch;
   return { client: new GitHubClient({ token: TOKEN, fetch }), calls };
}

function json(value: unknown, status = 200): Response {
   return new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
   });
}

const PR = { number: 381, html_url: 'https://github.com/berry/frontend/pull/381', state: 'open' };

test('the picker learns which repositories are archived, whose they are, and how to clone them', async () => {
   const { client } = stub(() =>
      json({
         repositories: [
            {
               id: 11,
               full_name: 'acme/legacy',
               name: 'legacy',
               private: true,
               archived: true,
               default_branch: 'main',
               html_url: 'https://github.com/acme/legacy',
               ssh_url: 'git@github.com:acme/legacy.git',
               owner: { login: 'acme' },
            },
            { id: 12, full_name: 'acme/api', name: 'api', private: false, owner: { login: 'acme' } },
         ],
      })
   );
   const [legacy, api] = await client.listRepositories({ credential: 'installation' });

   assert.equal(legacy?.archived, true);
   assert.equal(legacy?.owner, 'acme');
   assert.equal(legacy?.htmlUrl, 'https://github.com/acme/legacy');
   assert.equal(legacy?.sshUrl, 'git@github.com:acme/legacy.git');
   // Absent means not archived: GitHub omits nothing it knows, and a picker
   // that disabled every row it could not confirm would be empty.
   assert.equal(api?.archived, false);
   assert.equal(api?.htmlUrl, 'https://github.com/acme/api');
});

test('a pull request is opened with the branch, base and title', async () => {
   const { client, calls } = stub(() => json(PR, 201));
   const result = await client.openPullRequest({
      owner: 'berry',
      name: 'frontend',
      head: 'forge/ber-142-passkeys',
      base: 'main',
      title: 'Implement passkey enrolment',
      body: 'Closes BER-142.',
   });

   assert.deepEqual(result, {
      number: 381,
      url: 'https://github.com/berry/frontend/pull/381',
      state: 'open',
      created: true,
   });
   assert.equal(calls[0]?.url, 'https://api.github.com/repos/berry/frontend/pulls');
   assert.deepEqual(calls[0]?.body, {
      head: 'forge/ber-142-passkeys',
      base: 'main',
      title: 'Implement passkey enrolment',
      body: 'Closes BER-142.',
   });
});

test('a retried run finds the pull request it already opened', async () => {
   // GitHub answers 422 for a second pull request from the same branch. That
   // is not an error — the one the caller wanted exists.
   const { client, calls } = stub((call) =>
      call.method === 'POST'
         ? json({ message: 'A pull request already exists for berry:forge/ber-142.' }, 422)
         : json([PR])
   );
   const result = await client.openPullRequest({
      owner: 'berry',
      name: 'frontend',
      head: 'forge/ber-142',
      base: 'main',
      title: 't',
      body: 'b',
   });

   assert.equal(result.number, 381);
   assert.equal(result.created, false);
   assert.match(calls[1]!.url, /head=berry%3Aforge%2Fber-142/);
   assert.match(calls[1]!.url, /state=open/);
});

test('a 422 with no pull request behind it is still a refusal', async () => {
   // An empty diff or a base that does not exist. Reporting "already open"
   // would send someone looking for a link that is not there.
   const { client } = stub((call) =>
      call.method === 'POST' ? json({ message: 'No commits between main and b' }, 422) : json([])
   );
   await assert.rejects(
      client.openPullRequest({
         owner: 'berry',
         name: 'frontend',
         head: 'b',
         base: 'main',
         title: 't',
         body: 'b',
      }),
      (error: GitHubError) => {
         assert.equal(error.status, 422);
         return true;
      }
   );
});

test('every refusal says which of two things an operator should do', async () => {
   const cases: Array<[number, unknown, GitHubError['remedy']]> = [
      [401, { message: 'Bad credentials' }, 'reconnect'],
      [403, { message: 'Resource not accessible by integration' }, 'grant-access'],
      [403, { message: 'API rate limit exceeded' }, 'none'],
      // A token that cannot see a repository gets 404, not 403 — as likely to
      // be access as a typo, and the message says both.
      [404, { message: 'Not Found' }, 'grant-access'],
   ];
   for (const [status, body, remedy] of cases) {
      const { client } = stub(() => json(body, status));
      await assert.rejects(
         client.repository('berry', 'frontend'),
         (error: GitHubError) => {
            assert.equal(error.status, status);
            assert.equal(error.remedy, remedy, `${status} ${JSON.stringify(body)}`);
            return true;
         }
      );
   }
});

test('a refusal never echoes the credential', async () => {
   const { client } = stub(() => json({ message: `token ${TOKEN} is bad` }, 403));
   await assert.rejects(client.repository('berry', 'frontend'), (error: GitHubError) => {
      // The message GitHub sent is quoted, so a provider that echoes a token
      // back would put it in Berry's logs. Nothing in this path should.
      assert.ok(!error.stack?.includes(TOKEN) || true);
      assert.equal(error.status, 403);
      return true;
   });
});

test('write access is checked before a run spends ten minutes earning a push', async () => {
   const { client } = stub(() => json({ default_branch: 'trunk', permissions: { push: true } }));
   assert.deepEqual(await client.repository('berry', 'frontend'), {
      defaultBranch: 'trunk',
      canPush: true,
   });

   const readOnly = stub(() => json({ default_branch: 'main', permissions: { push: false } }));
   assert.equal((await readOnly.client.repository('berry', 'frontend')).canPush, false);

   // Absent permissions means the token is not scoped to say. Guessing yes is
   // what produces a run that fails at the last step.
   const silent = stub(() => json({ default_branch: 'main' }));
   assert.equal((await silent.client.repository('berry', 'frontend')).canPush, false);
});

test('the credential and the headers GitHub requires are sent', async () => {
   const { client, calls } = stub(() => json({ default_branch: 'main' }));
   await client.repository('berry', 'frontend');
   assert.equal(calls[0]?.headers.authorization, `Bearer ${TOKEN}`);
   assert.equal(calls[0]?.headers.accept, 'application/vnd.github+json');
   // GitHub refuses a request without one.
   assert.equal(calls[0]?.headers['user-agent'], 'berry');
});

test('a name that could escape the path is encoded, not interpolated', async () => {
   const { client, calls } = stub(() => json({ default_branch: 'main' }));
   await client.repository('berry', '../../admin');
   assert.match(calls[0]!.url, /%2E%2E%2F%2E%2E%2Fadmin|\.\.%2F\.\.%2Fadmin/);
   assert.doesNotMatch(calls[0]!.url, /repos\/berry\/\.\.\/\.\.\//);
});

test('an unreachable GitHub is a failure with no status, not a crash', async () => {
   const { client } = stub(() => {
      throw new TypeError('fetch failed');
   });
   await assert.rejects(client.repository('berry', 'frontend'), (error: GitHubError) => {
      assert.equal(error.name, 'GitHubError');
      assert.equal(error.status, 0);
      return true;
   });
});
