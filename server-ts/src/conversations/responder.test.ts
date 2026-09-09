import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toMessages } from './responder.ts';
import type { ConversationMessage } from './repository.ts';

/**
 * A stored thread as the turns a model can take. Bedrock refuses a
 * conversation that does not alternate or that starts with the assistant, so
 * the shape is the guarantee, not the words.
 */

function row(
   authorType: ConversationMessage['authorType'],
   authorName: string,
   body: string
): ConversationMessage {
   return { id: body, authorType, authorName, body, channel: 'chat', createdAt: '2026-09-09T00:00:00Z' };
}

test('turns alternate, start with the user, and join same-side runs', () => {
   const messages = toMessages([
      row('agent', 'Bot', 'ignored leading reply'),
      row('user', 'Ann', 'first'),
      row('user', 'Ann', 'second'),
      row('agent', 'Bot', 'reply'),
      row('user', 'Ann', 'third'),
   ]);
   assert.deepEqual(
      messages.map((message) => message.role),
      ['user', 'assistant', 'user']
   );
   assert.match(JSON.stringify(messages[0]), /first\\n\\nsecond/);
   assert.doesNotMatch(JSON.stringify(messages), /ignored leading reply/);
});

test('a system row rides in the next user turn, and names appear only with two people', () => {
   const messages = toMessages([
      row('system', 'Berry', 'Ben joined'),
      row('user', 'Ann', 'hello'),
      row('user', 'Ben', 'hi'),
   ]);
   assert.equal(messages.length, 1);
   assert.match(JSON.stringify(messages[0]), /\[Berry\] Ben joined/);
   assert.match(JSON.stringify(messages[0]), /Ann: hello/);
   assert.match(JSON.stringify(messages[0]), /Ben: hi/);

   const alone = toMessages([row('user', 'Ann', 'hello')]);
   assert.doesNotMatch(JSON.stringify(alone[0]), /Ann:/);
});
