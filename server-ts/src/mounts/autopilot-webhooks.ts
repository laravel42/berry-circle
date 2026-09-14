import { Hono } from 'hono';
import type { FireFn } from '../autopilots/fire.ts';
import type { AutopilotRepository, AutopilotTrigger } from '../autopilots/repository.ts';
import { EVENT_HEADER, SIGNATURE_HEADER, validTokenShape, verifySignature } from '../autopilots/signing.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import type { Logger } from '../observability/log.ts';

/**
 * `/api/webhooks/autopilots/:token` — another system telling an autopilot
 * to run.
 *
 * Outside `requireSession` for the reason GitHub's route is: the caller is a
 * machine holding a secret, and the HMAC over the raw body is its
 * credential. The token picks the trigger; the signature proves the sender.
 * Neither alone is enough — a URL leaks into logs far more easily than a
 * signing key does.
 *
 * Once the signature holds, the answer is 2xx whatever Berry decides: a
 * sender that is told 5xx retries, and a retry of a delivery Berry chose to
 * ignore gets the same decision forever. What happened is in the delivery
 * log on the autopilot's page instead.
 */

const MAX_BODY_BYTES = 256 * 1024;

export interface AutopilotWebhookOptions {
   autopilots: AutopilotRepository;
   fire: FireFn;
   logger: Logger;
}

export function autopilotWebhookMounts(options: AutopilotWebhookOptions): Mount[] {
   const route = new Hono();
   const { autopilots, logger } = options;

   route.post('/:token', async (context) => {
      const token = context.req.param('token') ?? '';
      // One answer for "no such trigger" and "not even a token", so the
      // route is no oracle for which URLs are live.
      if (!validTokenShape(token)) throw ApiError.notFound('Autopilot webhook');
      const hook = await autopilots.webhookByToken(token);
      if (!hook) throw ApiError.notFound('Autopilot webhook');

      // Refuse an announced oversize body before reading it into memory; the
      // byte count after reading still catches a missing or lying header.
      const announced = Number(context.req.header('content-length') ?? '0');
      if (Number.isFinite(announced) && announced > MAX_BODY_BYTES) {
         throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Webhook body is too large.');
      }
      const raw = await context.req.text();
      if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
         throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Webhook body is too large.');
      }

      const record = (
         trigger: AutopilotTrigger,
         status: 'accepted' | 'filtered' | 'rejected',
         event: string | null,
         payload: unknown,
         failureReason: string | null
      ) =>
         autopilots.recordDelivery({
            workspaceId: hook.workspaceId,
            autopilotId: trigger.autopilotId,
            triggerId: trigger.id,
            event,
            status,
            payload,
            failureReason,
            replayOf: null,
         });

      const signature = context.req.header(SIGNATURE_HEADER) ?? '';
      if (!verifySignature(raw, signature, hook.signingSecret)) {
         await record(hook.trigger, 'rejected', null, null, 'SIGNATURE_MISMATCH');
         logger.error('autopilot webhook signature rejected', { triggerId: hook.trigger.id });
         throw new ApiError(401, 'WEBHOOK_UNVERIFIED', 'Signature does not match.');
      }

      let payload: Record<string, unknown>;
      try {
         const parsed: unknown = JSON.parse(raw);
         if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
         payload = parsed as Record<string, unknown>;
      } catch {
         await record(hook.trigger, 'rejected', null, null, 'MALFORMED');
         throw new ApiError(400, 'WEBHOOK_MALFORMED', 'Webhook body is not a JSON object.');
      }

      const event = eventName(context.req.header(EVENT_HEADER), payload);
      const filters = hook.trigger.eventFilters;
      if (filters.length > 0 && (event === null || !filters.includes(event))) {
         await record(hook.trigger, 'filtered', event, payload, null);
         return json({ accepted: false, reason: 'event filtered' }, 202);
      }
      if (!hook.trigger.enabled) {
         await record(hook.trigger, 'rejected', event, payload, 'TRIGGER_DISABLED');
         return json({ accepted: false, reason: 'trigger disabled' }, 202);
      }

      const deliveryId = await record(hook.trigger, 'accepted', event, payload, null);
      try {
         const outcome = await options.fire({
            autopilotId: hook.trigger.autopilotId,
            source: 'webhook',
            triggerId: hook.trigger.id,
            payload,
         });
         await autopilots.linkDelivery(
            deliveryId,
            outcome.autopilotRunId,
            outcome.status === 'failed' ? 'failed' : 'accepted'
         );
         return json({ accepted: true, autopilotRunId: outcome.autopilotRunId, status: outcome.status }, 202);
      } catch (error) {
         await autopilots.linkDelivery(deliveryId, null, 'failed');
         logger.error('autopilot webhook handling failed', {
            triggerId: hook.trigger.id,
            error: error instanceof Error ? error.message : String(error),
         });
         return json({ accepted: false, reason: 'handler failed' }, 202);
      }
   });

   return [{ prefix: '/api/webhooks/autopilots', handler: route }];
}

function eventName(header: string | undefined, payload: Record<string, unknown>): string | null {
   const candidates = [header, payload.event, payload.type];
   for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim().slice(0, 100);
   }
   return null;
}
