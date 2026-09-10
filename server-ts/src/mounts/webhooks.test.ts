import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, test } from 'node:test';
import { createApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import type { Logger } from '../observability/log.ts';
import type { ScmInbound } from '../scm/inbound.ts';
import type { WebhookDeliveries } from '../scm/webhook.ts';
import { webhookMounts, type WebhookOptions } from './webhooks.ts';

/**
 * The GitHub webhook route, driven through the real app shell.
 *
 * An App created through the manifest flow gets its webhook secret from
 * GitHub, sealed in the database — not from the environment. The route has to
 * accept a delivery signed with that secret, and still refuse anything else.
 */

const body = JSON.stringify({ action: 'opened', installation: { id: 7 } });

function sign(payload: string, secret: string): string {
   return `sha256=${createHmac('sha256', secret).update(payload, 'utf8').digest('hex')}`;
}

function appWith(options: Partial<WebhookOptions>) {
   const applied: string[] = [];
   const inbound = {
      apply: async (event: string) => {
         applied.push(event);
         return { applied: true, reason: 'ok' };
      },
   } as unknown as ScmInbound;
   const deliveries = { firstSeen: async () => true } as unknown as WebhookDeliveries;
   const logger = { info: () => undefined, error: () => undefined } as unknown as Logger;
   const registry = new Registry();
   registry.registerAll(
      webhookMounts({ inbound, deliveries, logger, secret: null, ...options })
   );
   return { app: createApp(registry), applied };
}

function deliver(app: ReturnType<typeof createApp>, signature: string) {
   return Promise.resolve(
      app.request('/api/v1/webhooks/github', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'x-github-event': 'pull_request',
            'x-github-delivery': 'delivery-1',
            'x-hub-signature-256': signature,
         },
         body,
      })
   );
}

describe('the GitHub webhook route', () => {
   test('accepts a delivery signed with the App’s own secret', async () => {
      const { app, applied } = appWith({ secrets: async () => ['app-secret'] });
      const response = await deliver(app, sign(body, 'app-secret'));
      assert.equal(response.status, 200);
      assert.deepEqual(applied, ['pull_request']);
   });

   test('still accepts the environment secret beside the App’s', async () => {
      const { app } = appWith({ secret: 'env-secret', secrets: async () => ['app-secret'] });
      const response = await deliver(app, sign(body, 'env-secret'));
      assert.equal(response.status, 200);
   });

   test('refuses a signature made with any other secret, and applies nothing', async () => {
      const { app, applied } = appWith({ secrets: async () => ['app-secret'] });
      const response = await deliver(app, sign(body, 'guessed'));
      assert.equal(response.status, 401);
      assert.deepEqual(applied, []);
   });

   test('with no secret anywhere, the route is closed rather than open', async () => {
      const { app } = appWith({ secrets: async () => [] });
      const response = await deliver(app, sign(body, 'anything'));
      assert.equal(response.status, 503);
   });

   test('a secret lookup that fails closes the route rather than opening it', async () => {
      const { app } = appWith({
         secrets: async () => {
            throw new Error('database down');
         },
      });
      const response = await deliver(app, sign(body, 'anything'));
      assert.equal(response.status, 503);
   });
});
