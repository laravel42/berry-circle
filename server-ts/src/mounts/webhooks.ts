import { Hono } from 'hono';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import type { Logger } from '../observability/log.ts';
import type { ScmInbound } from '../scm/inbound.ts';
import { verifySignature, type WebhookDeliveries } from '../scm/webhook.ts';

/**
 * `/api/v1/webhooks` — what GitHub tells Berry.
 *
 * Deliberately outside `requireSession`: the caller is a machine with a shared
 * secret, not a person with a session, and demanding a session would simply
 * make the route unusable. The signature is the authentication, which is why
 * it is checked before the body is parsed as anything meaningful.
 *
 * Always answers 2xx once the signature holds. A host that receives a 5xx
 * retries, and retrying an event Berry has decided to ignore produces the same
 * decision forever — so "understood, did nothing" is reported as success with
 * the reason in the body.
 */

const MAX_BODY_BYTES = 1_000_000;

export interface WebhookOptions {
   inbound: ScmInbound;
   deliveries: WebhookDeliveries;
   /** Absent disables the route: an unsigned webhook endpoint is an open door. */
   secret: string | null;
   /**
    * Secrets held elsewhere — the one GitHub issued with the App, sealed in the
    * database. A delivery signed with any of them, or with `secret`, is
    * accepted. A lookup that fails counts as no secret, which closes the route.
    */
   secrets?: () => Promise<Array<string | null>>;
   logger: Logger;
}

async function acceptedSecrets(options: WebhookOptions): Promise<string[]> {
   const held = options.secrets ? await options.secrets().catch(() => []) : [];
   return [options.secret, ...held].filter(
      (secret): secret is string => typeof secret === 'string' && secret !== ''
   );
}

export function webhookMounts(options: WebhookOptions): Mount[] {
   const route = new Hono();

   route.post('/github', async (context) => {
      const secrets = await acceptedSecrets(options);
      if (secrets.length === 0) {
         throw new ApiError(503, 'WEBHOOKS_DISABLED', 'This deployment accepts no webhooks.');
      }

      const raw = await context.req.text();
      if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
         throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Webhook body is too large.');
      }

      const signature = context.req.header('x-hub-signature-256') ?? '';
      if (!secrets.some((secret) => verifySignature(raw, signature, secret))) {
         // Deliberately terse. A detailed reason here is a hint to whoever is
         // guessing, and the operator can see the whole story in the log.
         options.logger.error('webhook signature rejected', {
            provider: 'github',
            event: context.req.header('x-github-event') ?? 'unknown',
         });
         throw new ApiError(401, 'WEBHOOK_UNVERIFIED', 'Signature does not match.');
      }

      const event = context.req.header('x-github-event') ?? '';
      const deliveryId = context.req.header('x-github-delivery') ?? '';
      if (!event || !deliveryId) {
         throw new ApiError(400, 'WEBHOOK_INCOMPLETE', 'Event and delivery headers are required.');
      }

      // Claimed before the work. A redelivery of an event already applied must
      // not apply it twice, and the unique index is what makes two concurrent
      // deliveries resolve to one winner rather than a race.
      const first = await options.deliveries.firstSeen({
         provider: 'github',
         deliveryId,
         eventType: event,
      });
      if (!first) return json({ applied: false, reason: 'duplicate delivery' });

      let payload: Record<string, unknown>;
      try {
         const parsed: unknown = JSON.parse(raw);
         if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('not an object');
         }
         payload = parsed as Record<string, unknown>;
      } catch {
         throw new ApiError(400, 'WEBHOOK_MALFORMED', 'Webhook body is not a JSON object.');
      }

      try {
         const result = await options.inbound.apply(event, payload);
         return json(result);
      } catch (error) {
         // Reported, not raised. The delivery is already recorded, so a retry
         // would be dropped as a duplicate anyway — answering 500 would only
         // make the host retry into a wall and hide the real failure in its
         // delivery log rather than in Berry's.
         options.logger.error('webhook handling failed', {
            provider: 'github',
            event,
            error: error instanceof Error ? error.message : String(error),
         });
         return json({ applied: false, reason: 'handler failed' });
      }
   });

   return [{ prefix: '/api/v1/webhooks', handler: route }];
}
