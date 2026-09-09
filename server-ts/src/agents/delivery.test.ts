import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitAndPush, parseNumstat } from './delivery.ts';
import { CheckoutFailed } from './checkout.ts';
import type { ExecResult, ExecutionSession } from '../execution/driver.ts';

const TOKEN = 'ghu_SuperSecretTokenValue000000000000000';

interface Call {
   command: string;
   cwd: string | undefined;
   env: Record<string, string> | undefined;
}

function fakeSession(results: Record<string, Partial<ExecResult>> = {}): {
   session: ExecutionSession;
   calls: Call[];
} {
   const calls: Call[] = [];
   const session: ExecutionSession = {
      id: 'run-1',
      exec: async (command, options) => {
         calls.push({ command, cwd: options?.cwd, env: options?.env });
         const match = Object.keys(results).find((key) => command.includes(key));
         return { stdout: '', stderr: '', exitCode: 0, ...(match ? results[match] : {}) } as ExecResult;
      },
      stream: () => ({ async *[Symbol.asyncIterator]() {} }),
      writeFile: async () => undefined,
      readFile: async () => '',
      stop: async () => undefined,
      destroy: async () => undefined,
   };
   return { session, calls };
}

const CHANGES = '12\t3\tsrc/auth/passkey.ts\n4\t0\tsrc/auth/passkey.test.ts\n';

test('a clean tree is a result, not a failure and not an empty pull request', async () => {
   // An agent that answered a question or found the bug absent changed
   // nothing. Committing anyway would put a reviewer in front of a diff with
   // nothing in it.
   const { session, calls } = fakeSession({ numstat: { stdout: '' } });
   const delivery = await commitAndPush({
      session,
      directory: 'frontend',
      branch: 'forge/ber-142',
      token: TOKEN,
      message: 'nothing to do',
   });

   assert.deepEqual(delivery, {
      committed: false,
      commit: null,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      files: [],
   });
   assert.ok(!calls.some((call) => call.command.includes('commit')));
   assert.ok(!calls.some((call) => call.command.includes('push')));
});

test('changes are committed, pushed, and reported with a diffstat', async () => {
   const { session, calls } = fakeSession({
      numstat: { stdout: CHANGES },
      'rev-parse': { stdout: 'a1b2c3d\n' },
   });
   const delivery = await commitAndPush({
      session,
      directory: 'frontend',
      branch: 'forge/ber-142-passkeys',
      token: TOKEN,
      message: 'Implement passkey enrolment',
   });

   assert.deepEqual(delivery, {
      committed: true,
      commit: 'a1b2c3d',
      filesChanged: 2,
      insertions: 16,
      deletions: 3,
      files: ['src/auth/passkey.ts', 'src/auth/passkey.test.ts'],
   });
   assert.ok(calls.some((call) => call.command.includes('push')));
   assert.ok(calls.every((call) => call.cwd === 'frontend'));
});

test('the token never appears in a command, only on the environment of the fetch and the push', async () => {
   // The same rule as the checkout, and for the same reason: commands are
   // recorded verbatim and streamed to everyone watching the run.
   const { session, calls } = fakeSession({
      numstat: { stdout: CHANGES },
      'rev-parse': { stdout: 'abc\n' },
   });
   await commitAndPush({
      session,
      directory: 'frontend',
      branch: 'b',
      token: TOKEN,
      message: 'work',
   });

   for (const call of calls) {
      assert.ok(!call.command.includes(TOKEN), `token leaked into: ${call.command}`);
   }
   const withToken = calls.filter((call) => call.env?.BERRY_GIT_TOKEN !== undefined);
   assert.deepEqual(
      withToken.map((call) => (call.command.includes('push') ? 'push' : 'fetch')),
      ['fetch', 'push']
   );
   for (const call of withToken) assert.match(call.command, /\$BERRY_GIT_TOKEN/);
});

test('a retried run updates its own branch but refuses to clobber someone else', async () => {
   const { session, calls } = fakeSession({
      numstat: { stdout: CHANGES },
      'rev-parse': { stdout: 'abc\n' },
   });
   await commitAndPush({
      session,
      directory: 'frontend',
      branch: 'b',
      token: TOKEN,
      message: 'work',
   });
   const push = calls.find((call) => call.command.includes('push'))!;
   // The lease names the value it expects — the sha the fetch brought back —
   // because the implicit lease is refused on a shallow clone.
   assert.match(push.command, /--force-with-lease='b:abc'/);
   // The lease has to have something to compare with: a fresh clone knows
   // nothing about the branch the earlier attempt pushed, and was refused
   // with "stale info" until the branch was fetched first.
   const fetch = calls.findIndex((call) => /fetch origin '\+refs\/heads\/b:refs\/remotes\/origin\/b'/.test(call.command));
   const pushAt = calls.findIndex((call) => call.command.includes('push'));
   assert.ok(fetch >= 0 && fetch < pushAt, 'the branch is fetched before it is pushed');
   assert.equal(calls[fetch]!.env?.BERRY_GIT_TOKEN, TOKEN, 'the fetch authenticates the same way');
});

test('a branch that does not exist yet fails to fetch, and is pushed anyway', async () => {
   const { session, calls } = fakeSession({
      numstat: { stdout: CHANGES },
      // Listed before `rev-parse`: the fake answers by the first key a command
      // contains, and the remote-ref probe is a `rev-parse --verify`.
      '--verify': { exitCode: 1, stdout: '' },
      'rev-parse': { stdout: 'abc\n' },
      fetch: { exitCode: 128, stderr: "fatal: couldn't find remote ref b\n" },
   });
   const delivery = await commitAndPush({ session, directory: 'frontend', branch: 'b', token: TOKEN, message: 'work' });
   assert.equal(delivery.committed, true);
   const push = calls.find((call) => call.command.includes('push'))!;
   // An empty expectation: create the branch, and refuse if one appeared.
   assert.match(push.command, /--force-with-lease='b:'/);
});

test('a commit message with a body survives the shell', async () => {
   const { session, calls } = fakeSession({
      numstat: { stdout: CHANGES },
      'rev-parse': { stdout: 'abc\n' },
   });
   await commitAndPush({
      session,
      directory: 'frontend',
      branch: 'b',
      token: TOKEN,
      message: "Fix the reviewer's note",
      body: 'Two existing tests covered the old path.\nBoth updated.',
   });

   const commit = calls.find((call) => call.command.includes('git commit'))!.command;
   assert.match(commit, /Fix the reviewer/);
   // The apostrophe is what breaks a naive quote.
   assert.match(commit, /'\\''/);
   assert.match(commit, /Both updated\./);
});

test('a push that is refused says why and does not report a delivery', async () => {
   const { session } = fakeSession({
      numstat: { stdout: CHANGES },
      'rev-parse': { stdout: 'abc\n' },
      push: { exitCode: 1, stderr: '! [rejected] stale info\n' },
   });
   await assert.rejects(
      commitAndPush({ session, directory: 'f', branch: 'b', token: TOKEN, message: 'work' }),
      (error: CheckoutFailed) => {
         assert.match(error.message, /could not push the branch/);
         assert.match(error.message, /rejected/);
         return true;
      }
   );
});

test('a diffstat counts binary files without inventing line numbers', () => {
   // git writes `-` for both counts on a binary file. Reading that as zero
   // would be right by accident; it is a changed file with no line count.
   const stat = parseNumstat('10\t2\tsrc/a.ts\n-\t-\tdocs/diagram.png\n');
   assert.deepEqual(stat, {
      filesChanged: 2,
      insertions: 10,
      deletions: 2,
      files: ['src/a.ts', 'docs/diagram.png'],
   });
});

test('a renamed file is listed at the path it now has', () => {
   // git keeps the unchanged parts of a path outside the braces, so taking
   // everything after the arrow loses the prefix on all but the simplest case.
   const cases: Array<[string, string]> = [
      ['src/{old => new}/file.ts', 'src/new/file.ts'],
      ['old/file.ts => new/file.ts', 'new/file.ts'],
      ['src/{a => b}/x/{c => d}.ts', 'src/b/x/d.ts'],
      ['src/{ => added}/file.ts', 'src/added/file.ts'],
      ['src/{removed => }/file.ts', 'src/file.ts'],
      ['src/untouched.ts', 'src/untouched.ts'],
   ];
   for (const [written, expected] of cases) {
      const stat = parseNumstat(`1\t1\t${written}`);
      assert.equal(stat.files[0], expected, written);
      assert.equal(stat.filesChanged, 1);
   }
});

test('an empty or malformed diffstat reports nothing changed', () => {
   for (const output of ['', '\n\n', 'garbage', '1\t2']) {
      assert.equal(parseNumstat(output).filesChanged, 0, `parsed: ${JSON.stringify(output)}`);
   }
});

test('a file list is bounded, though the counts are not', () => {
   const many = Array.from({ length: 200 }, (_x, index) => `1\t1\tsrc/file${index}.ts`).join('\n');
   const stat = parseNumstat(many);
   assert.equal(stat.filesChanged, 200);
   assert.equal(stat.insertions, 200);
   assert.equal(stat.files.length, 50);
});
