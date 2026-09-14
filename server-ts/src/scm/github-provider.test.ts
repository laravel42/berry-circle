import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubProvider } from './github-provider.ts';
import { ScmError } from './provider.ts';

/**
 * GitHub behind the SCM interface, offline.
 *
 * The interesting cases are the asymmetries with a host Berry owns: a
 * repository here already belongs to somebody, so this provider resolves where
 * the previous one created, and refuses where the previous one deleted.
 */

function fetcher(responses: Array<{ status: number; body?: unknown }>) {
   const calls: Array<{ url: string; method: string; body: unknown; auth: string }> = [];
   let next = 0;
   const fake = (async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
         url: String(url),
         method: init?.method ?? 'GET',
         body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
         auth: headers.get('authorization') ?? '',
      });
      const entry = responses[next++] ?? { status: 500 };
      return new Response(
         entry.status === 204 || entry.body === undefined ? null : JSON.stringify(entry.body),
         { status: entry.status, headers: { 'content-type': 'application/json' } }
      );
   }) as unknown as typeof globalThis.fetch;
   return { fake, calls };
}

function provider(responses: Array<{ status: number; body?: unknown }>, token = 'ghs_installation') {
   const { fake, calls } = fetcher(responses);
   return { calls, github: new GitHubProvider({ token: async () => token, fetch: fake }) };
}

test('a repository is resolved, never created', async () => {
   // Making a repository in somebody's organization because they made a Berry
   // project is not a thing Berry should do quietly.
   const p = provider([
      { status: 200, body: { id: 5, name: 'atlas', full_name: 'acme/atlas', owner: { login: 'acme' }, default_branch: 'main' } },
   ]);
   const repo = await p.github.ensureRepository({ owner: 'acme', name: 'atlas' });

   assert.equal(repo.id, 5);
   assert.equal(p.calls.length, 1);
   assert.equal(p.calls[0]?.method, 'GET', 'resolving is a read, not a write');
});

test('deleting a repository is refused outright', async () => {
   // The repository is the workspace organization's code. Nothing in Berry
   // should be able to remove it — not project deletion, and not the reset.
   const p = provider([]);
   await assert.rejects(p.github.deleteRepository(), (error: ScmError) => {
      assert.equal(error.status, 403);
      return true;
   });
   assert.equal(p.calls.length, 0, 'it must not even reach GitHub');
});

test('a repository is never renamed, whatever the project is called', async () => {
   // A rename breaks every clone, bookmark and CI reference pointing at it.
   const p = provider([
      { status: 200, body: {} },
      { status: 200, body: { id: 5, name: 'atlas', owner: { login: 'acme' } } },
   ]);
   await p.github.updateRepository({ owner: 'acme', name: 'atlas' }, {
      description: 'new words',
   } as never);

   assert.equal(p.calls[0]?.method, 'PATCH');
   assert.deepEqual(p.calls[0]?.body, { description: 'new words' });
});

test('the installation token is sent as a bearer', async () => {
   const p = provider([{ status: 200, body: { id: 1, owner: { login: 'acme' } } }]);
   await p.github.getRepository({ owner: 'acme', name: 'atlas' });
   assert.equal(p.calls[0]?.auth, 'Bearer ghs_installation');
});

test('an issue clears its milestone with null, not zero', async () => {
   // Gitea read 0 as "none" and GitHub reads null; absorbing that difference is
   // what this layer is for.
   const p = provider([{ status: 200, body: { id: 1, number: 7 } }]);
   await p.github.updateIssue({ owner: 'acme', name: 'atlas' }, 7, { milestoneId: null });
   assert.equal((p.calls[0]?.body as Record<string, unknown>).milestone, null);
});

test('a pull request that already exists is returned rather than failing', async () => {
   // A retried delivery must not fail because the previous attempt succeeded.
   const p = provider([
      { status: 422, body: { message: 'A pull request already exists' } },
      { status: 200, body: [{ id: 9, number: 12, head: { ref: 'berry/42' }, base: { ref: 'main' }, state: 'open' }] },
   ]);
   const pull = await p.github.openPullRequest(
      { owner: 'acme', name: 'atlas' },
      { title: 'Work', head: 'berry/42', base: 'main' }
   );

   assert.equal(pull.number, 12);
   assert.equal(pull.created, false);
});

test('a branch is qualified with its owner when searching for its pull request', async () => {
   // GitHub's filter is `owner:branch`; a bare branch matches nothing.
   const p = provider([{ status: 200, body: [] }]);
   await p.github.findPullRequest({ owner: 'acme', name: 'atlas' }, 'berry/42');
   assert.match(p.calls[0]!.url, /head=acme%3Aberry%2F42/);
});

test('a merged pull request is reported merged even without the flag', async () => {
   const p = provider([
      { status: 200, body: [{ number: 3, state: 'closed', merged_at: '2026-01-01T00:00:00Z', head: { ref: 'b' }, base: { ref: 'main' } }] },
   ]);
   const pull = await p.github.findPullRequest({ owner: 'acme', name: 'atlas' }, 'b');
   assert.equal(pull?.merged, true);
});

test('a 403 asks to reconnect rather than to retry', async () => {
   // On GitHub a 403 is a rate limit or a missing App permission, and neither
   // is fixed by trying again in a second.
   const p = provider([{ status: 403, body: { message: 'Resource not accessible by integration' } }]);
   await assert.rejects(p.github.getRepository({ owner: 'a', name: 'b' }), (error: ScmError) => {
      assert.equal(error.remedy, 'reconnect');
      assert.equal(error.retryable, false);
      return true;
   });
});

test('a 5xx is retryable and a 404 is a missing object', async () => {
   const down = provider([{ status: 502 }]);
   await assert.rejects(down.github.getRepository({ owner: 'a', name: 'b' }), (e: ScmError) => e.retryable);

   const gone = provider([{ status: 404 }]);
   await assert.rejects(gone.github.getRepository({ owner: 'a', name: 'b' }), (e: ScmError) => {
      assert.equal(e.remedy, 'missing');
      return true;
   });
});

test('the run credential is GitHub’s token-as-user convention', async () => {
   const p = provider([]);
   assert.deepEqual(await p.github.runCredential(), {
      username: 'x-access-token',
      password: 'ghs_installation',
   });
});
