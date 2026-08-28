import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CheckoutFailed, branchName, checkout, parseRepository, shellQuote } from './checkout.ts';
import type { ExecResult, ExecutionSession } from '../execution/driver.ts';

/**
 * The checkout, and mostly one property of it.
 *
 * `run.command.started` records commands verbatim and streams them to every
 * browser watching a run. A token in a clone URL would therefore be published
 * to the workspace and kept in the ledger — so the assertion these tests exist
 * for is that the credential never appears in a command string.
 */

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
         return {
            stdout: '',
            stderr: '',
            exitCode: 0,
            ...(match ? results[match] : {}),
         } as ExecResult;
      },
      stream: () => ({ async *[Symbol.asyncIterator]() {} }),
      writeFile: async () => undefined,
      readFile: async () => '',
      stop: async () => undefined,
      destroy: async () => undefined,
   };
   return { session, calls };
}

test('the token never appears in a command, only in an exec environment', async () => {
   // The property this whole file exists for.
   const { session, calls } = fakeSession({ 'rev-parse': { stdout: '4f2a9c1\n' } });
   await checkout({ session, repository: 'berry/frontend', branch: 'forge/ber-142', token: TOKEN });

   assert.ok(calls.length > 0);
   for (const call of calls) {
      assert.doesNotMatch(call.command, /ghu_/, `token leaked into: ${call.command}`);
      assert.ok(!call.command.includes(TOKEN), `token leaked into: ${call.command}`);
   }
   // It reached git the only way it is allowed to.
   const clone = calls.find((call) => call.command.includes('clone'));
   assert.equal(clone?.env?.BERRY_GIT_TOKEN, TOKEN);
});

test('only the clone carries the credential, so later commands cannot read it', async () => {
   // Per-command environment does not persist into the container. An agent's
   // own run_command calls afterwards therefore have no token to find.
   const { session, calls } = fakeSession({ 'rev-parse': { stdout: 'abc\n' } });
   await checkout({ session, repository: 'berry/frontend', branch: 'forge/ber-142', token: TOKEN });

   const withToken = calls.filter((call) => call.env?.BERRY_GIT_TOKEN !== undefined);
   assert.equal(withToken.length, 1);
   assert.match(withToken[0]!.command, /clone/);
});

test('git is told the variable name, never the value', async () => {
   const { session, calls } = fakeSession({ 'rev-parse': { stdout: 'abc\n' } });
   await checkout({ session, repository: 'berry/frontend', branch: 'forge/ber-142', token: TOKEN });

   const clone = calls.find((call) => call.command.includes('clone'))!;
   assert.match(clone.command, /credential\.helper/);
   assert.match(clone.command, /\$BERRY_GIT_TOKEN/);
   assert.match(clone.command, /https:\/\/github\.com\/berry\/frontend\.git/);
});

test('the branch is created and the base commit reported', async () => {
   const { session, calls } = fakeSession({ 'rev-parse': { stdout: '4f2a9c1\n' } });
   const result = await checkout({
      session,
      repository: 'berry/frontend',
      branch: 'forge/ber-142-passkeys',
      token: TOKEN,
   });

   assert.deepEqual(result, {
      directory: 'frontend',
      baseCommit: '4f2a9c1',
      branch: 'forge/ber-142-passkeys',
   });
   assert.ok(calls.some((call) => call.command.includes("checkout -b 'forge/ber-142-passkeys'")));
});

test('commits are attributed to Berry, not to whoever connected GitHub', async () => {
   const { session, calls } = fakeSession({ 'rev-parse': { stdout: 'abc\n' } });
   await checkout({ session, repository: 'berry/frontend', branch: 'b', token: TOKEN });

   const identity = calls.filter((call) => call.command.includes('git config user'));
   assert.equal(identity.length, 2);
   assert.ok(identity.every((call) => call.cwd === 'frontend'));
});

test('a clone that fails says why, and does not carry on to the branch', async () => {
   const { session, calls } = fakeSession({
      clone: { exitCode: 128, stderr: 'fatal: repository not found\n' },
   });
   await assert.rejects(
      checkout({ session, repository: 'berry/missing', branch: 'b', token: TOKEN }),
      (error: CheckoutFailed) => {
         assert.equal(error.name, 'CheckoutFailed');
         assert.equal(error.exitCode, 128);
         assert.match(error.message, /repository not found/);
         return true;
      }
   );
   // The clear and the clone; nothing after.
   assert.equal(calls.length, 2, 'it kept going after the clone failed');
});

test('a base branch and a depth are passed through when asked for', async () => {
   const { session, calls } = fakeSession({ 'rev-parse': { stdout: 'abc\n' } });
   await checkout({
      session,
      repository: 'berry/frontend',
      branch: 'b',
      token: TOKEN,
      baseBranch: 'main',
      depth: 50,
   });
   const clone = calls.find((call) => call.command.includes('clone'))!.command;
   assert.match(clone, /--depth 50/);
   assert.match(clone, /--branch 'main'/);
});

test('a repository name that is not owner/name is refused, not escaped', () => {
   // The value ends up in a URL and a shell command. A repository whose name
   // contains a quote is not one anybody has.
   assert.deepEqual(parseRepository('berry/frontend'), { owner: 'berry', name: 'frontend' });
   assert.deepEqual(parseRepository('berry/frontend.git'), { owner: 'berry', name: 'frontend' });
   for (const bad of ['berry', 'berry/front end', "berry/'; rm -rf /", 'a/b/c', '']) {
      assert.throws(() => parseRepository(bad), CheckoutFailed, `accepted: ${bad}`);
   }
});

test('a branch name reads like the product spells it', () => {
   assert.equal(
      branchName('Forge', 'BER-142', 'Implement passkey enrolment'),
      'forge/ber-142-implement-passkey-enrolment'
   );
   // Deterministic, so a retried run reuses its branch rather than scattering
   // near-identical ones.
   assert.equal(
      branchName('Forge', 'BER-142', 'Implement passkey enrolment'),
      branchName('Forge', 'BER-142', 'Implement passkey enrolment')
   );
});

test('a branch name survives titles that are not words', () => {
   assert.equal(branchName('Forge', 'BER-1', '  ***  '), 'forge/ber-1');
   assert.equal(branchName('', 'BER-1', 'x'), 'agent/ber-1-x');
   assert.match(branchName('Forge', 'BER-1', 'Café ☕ résumé'), /^forge\/ber-1-caf/);
   // Bounded, and never trailing in a hyphen — git refuses some of those.
   const long = branchName('Forge', 'BER-1', 'a '.repeat(200));
   assert.ok(long.length < 90, long);
   assert.doesNotMatch(long, /-$/);
});

test('shell quoting survives a value containing a quote', () => {
   assert.equal(shellQuote("it's"), `'it'\\''s'`);
   assert.equal(shellQuote('plain'), `'plain'`);
});

test('a retried run starts from an empty directory, not a half-cloned one', async () => {
   const { session, calls } = fakeSession({ 'rev-parse': { stdout: 'abc\n' } });
   await checkout({ session, repository: 'berry/frontend', branch: 'b', token: TOKEN });
   assert.match(calls[0]!.command, /^rm -rf 'frontend'$/);
});
