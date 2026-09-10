import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMention, parseMentions } from './mentions.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';

test('user and agent mentions are read from their tokens, once each', () => {
   const body = `hi ${formatMention('user', USER, 'Ada')} and ${formatMention('agent', AGENT, 'Bot')}, ${formatMention('user', USER, 'Ada')}`;
   assert.deepEqual(parseMentions(body), { users: [USER], agents: [AGENT] });
});

test('a plain @name is not a mention', () => {
   assert.deepEqual(parseMentions('ping @ada please'), { users: [], agents: [] });
});

test('a malformed id is ignored', () => {
   assert.deepEqual(parseMentions('[@x](mention://user/not-a-uuid)'), { users: [], agents: [] });
});
