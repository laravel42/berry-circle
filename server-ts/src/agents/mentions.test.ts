import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMentions } from './mentions.ts';

const A = '0a1b2c3d-0000-4000-8000-00000000000a';
const S = '0a1b2c3d-0000-4000-8000-00000000000b';

test('agent and squad tokens are found, once each', () => {
   const parsed = parseMentions(
      `@[Coder](agent:${A}) please, and @[Core](squad:${S}); again @[Coder](agent:${A.toUpperCase()})`
   );
   assert.deepEqual(parsed, { agents: [A], squads: [S] });
});

test('a bare @name, an email and a malformed token are not mentions', () => {
   assert.deepEqual(parseMentions('@Coder mail me@x.test @[Coder](agent:nope)'), { agents: [], squads: [] });
});

test('a display name cannot span lines', () => {
   assert.deepEqual(parseMentions(`@[Co\nder](agent:${A})`), { agents: [], squads: [] });
});
