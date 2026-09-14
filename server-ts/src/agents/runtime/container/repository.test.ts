import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TaskEnvelope } from '../../../runtime/envelope.ts';
import type { LifecycleEvent } from '../../../runtime/lifecycle.ts';
import { LocalSession } from './local-session.ts';
import { containerRepository } from './repository.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function withRepo(branch: string): { session: LocalSession; remote: string } {
   const root = mkdtempSync(join(tmpdir(), 'berry-repo-'));
   const remote = mkdtempSync(join(tmpdir(), 'berry-remote-'));
   git(remote, 'init', '--bare', '-q');
   git(root, 'init', '-q', 'repo');
   const repo = join(root, 'repo');
   git(repo, 'config', 'user.email', 't@berry.test');
   git(repo, 'config', 'user.name', 'T');
   git(repo, 'commit', '--allow-empty', '-q', '-m', 'base');
   git(repo, 'checkout', '-q', '-b', branch);
   git(repo, 'remote', 'add', 'origin', remote);
   return { session: new LocalSession({ id: 's', root }), remote };
}

function envelopeFor(branch: string): TaskEnvelope {
   return {
      kind: 'agent', runId: 'r', sessionKey: 'a:i', runtimeSessionId: `berry-${'r'.repeat(64)}`,
      agent: { name: 'A', instructions: '', model: 'm', skills: [], mcpServers: [], permissions: [], maxTokens: null, temperature: null },
      task: { prompt: 'p', issue: null, comments: [], dependencies: [], projectResources: [], priorWork: null },
      transcript: [],
      repo: {
         fullName: 'owner/name', branch, baseBranch: 'main',
         credential: { username: 'x-access-token', password: 'token' },
         verifyCommands: ['true'], issueReference: 'BER-1', issueTitle: 'Fix it',
      },
      completion: null, env: {}, berry: { apiUrl: 'https://b.test', token: 't' },
   };
}

test('no repository in the envelope means no checkout', async () => {
   const { session } = withRepo('b');
   const directory = await containerRepository().prepare({
      envelope: { ...envelopeFor('b'), repo: null }, session, warm: false, emit: () => {},
   });
   assert.equal(directory, null);
});

test('a warm session reuses its checkout on the issue branch without cloning', async () => {
   const { session } = withRepo('berry/ber-1');
   const events: LifecycleEvent[] = [];
   const directory = await containerRepository().prepare({
      envelope: envelopeFor('berry/ber-1'), session, warm: true, emit: (event) => events.push(event),
   });
   assert.equal(directory, join(session.root, 'repo'));
   const ready = events.find((event) => event.type === 'task.message' && event.message.kind === 'repository.ready');
   assert.ok(ready);
});

test('delivery verifies, commits and pushes the branch', async () => {
   const { session, remote } = withRepo('berry/ber-2');
   await session.writeFile('repo/new.txt', 'hello\n');
   const events: LifecycleEvent[] = [];
   const delivery = await containerRepository().deliver({
      envelope: envelopeFor('berry/ber-2'), session, directory: join(session.root, 'repo'),
      summary: 'Added a file', emit: (event) => events.push(event),
   });
   assert.equal(delivery?.committed, true);
   assert.equal(delivery?.branch, 'berry/ber-2');
   assert.ok(git(remote, 'rev-parse', 'berry/ber-2'));
   assert.ok(events.some((event) => event.type === 'task.message' && event.message.kind === 'verified'));
});
