import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { createHookHandler } from './handler.ts';
import type { HookRequest } from './types.ts';

const body = JSON.stringify({
   type: 'event', trigger: 'comment.created', pluginKey: 'hello', installationId: 'i', workspaceId: 'w',
   config: {}, secrets: {}, api: { url: 'https://berry.example.com', token: 'berry_plg_x', expiresAt: 'z' },
   event: { id: 'e', type: 'comment.created', occurredAt: 'z', payload: {} },
});
const signed = (secret: string) => {
   const t = Math.floor(Date.now() / 1000);
   return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
};

test('a signed event reaches onEvent with a client bound to the call token', async () => {
   let seen: HookRequest | null = null;
   const handle = createHookHandler({ signingSecret: 's', onEvent: async (request) => { seen = request; } });
   const response = await handle(new Request('https://plugin/hooks', {
      method: 'POST', body, headers: { 'Berry-Signature': signed('s') },
   }));
   assert.equal(response.status, 204);
   assert.equal((seen as HookRequest | null)?.trigger, 'comment.created');
});

test('an unsigned or mis-signed call is refused before the handler runs', async () => {
   let ran = false;
   const handle = createHookHandler({ signingSecret: 's', onEvent: async () => { ran = true; } });
   const response = await handle(new Request('https://plugin/hooks', {
      method: 'POST', body, headers: { 'Berry-Signature': signed('other') },
   }));
   assert.equal(response.status, 401);
   assert.equal(ran, false);
});
