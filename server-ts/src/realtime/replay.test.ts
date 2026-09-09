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

test('every run event the ledger writes is replayed to the board stream', () => {
   const source = readFileSync(new URL('../runs/ledger.ts', import.meta.url), 'utf8');
   const written = new Set(source.match(/'run\.[a-z_.]+'/g)?.map((literal) => literal.slice(1, -1)));
   assert.ok(written.size >= 10, 'the ledger names its events as literals');
   const replayed = new Set<string>([...BOARD_TOPICS, ...WORKSPACE_TOPICS]);
   const missing = [...written].filter((topic) => !replayed.has(topic));
   assert.deepEqual(missing, []);
});
