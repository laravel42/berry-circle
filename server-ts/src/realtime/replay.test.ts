import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BOARD_TOPICS, WORKSPACE_TOPICS } from './replay.ts';

/**
 * A topic missing from the replay lists is a fact that silently never
 * arrives. The ledger's event names are string literals in one file, so the
 * list is checked against the source itself rather than against a copy that
 * could drift the same way.
 */

test('every GitHub event the integration writes is replayed, and PR updates reach board streams', () => {
   const sources = [
      '../scm/github-settings.ts',
      '../scm/pull-requests.ts',
      '../mounts/github.ts',
      '../index.ts',
   ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));
   const written = new Set(
      sources.flatMap((source) => source.match(/'github\.[a-z_.]+'/g) ?? []).map((literal) => literal.slice(1, -1))
   );
   assert.ok(written.size >= 4, 'the GitHub writers name their events as literals');
   const workspace = new Set<string>(WORKSPACE_TOPICS);
   assert.deepEqual([...written].filter((topic) => !workspace.has(topic)), []);
   assert.ok(
      (BOARD_TOPICS as readonly string[]).includes('github.pull_request.updated'),
      'an open board sees its issues’ pull requests change'
   );
});

test('every run event the ledger writes is replayed to the board stream', () => {
   const source = readFileSync(new URL('../runs/ledger.ts', import.meta.url), 'utf8');
   const written = new Set(source.match(/'run\.[a-z_.]+'/g)?.map((literal) => literal.slice(1, -1)));
   assert.ok(written.size >= 10, 'the ledger names its events as literals');
   const replayed = new Set<string>([...BOARD_TOPICS, ...WORKSPACE_TOPICS]);
   const missing = [...written].filter((topic) => !replayed.has(topic));
   assert.deepEqual(missing, []);
});

test('recorded usage reaches the workspace stream, not the board stream', () => {
   assert.ok((WORKSPACE_TOPICS as readonly string[]).includes('usage.recorded'));
   assert.ok(!(BOARD_TOPICS as readonly string[]).includes('usage.recorded'));
});
