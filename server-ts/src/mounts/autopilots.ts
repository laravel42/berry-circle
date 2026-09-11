import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { InvalidSchedule, nextFireTimes } from '../autopilots/cron.ts';
import type { FireFn } from '../autopilots/fire.ts';
import {
   ASSIGNEE_TYPES,
   EXECUTION_MODES,
   InvalidAutopilot,
   QUOTA_PERIODS,
   type Autopilot,
   type AutopilotRepository,
   type AutopilotTrigger,
   type WebhookSecrets,
} from '../autopilots/repository.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { assertValid, fieldError } from '../http/body.ts';
import { ApiError } from '../http/errors.ts';
import { idempotent } from '../http/idempotent.ts';
import type { IdempotencyStore } from '../http/idempotency.ts';
import type { Mount } from '../http/registry.ts';
import { toApiError } from '../identity/errors.ts';
import type { Permission } from '../identity/roles.ts';
import { SealingUnavailable } from '../integrations/sealing.ts';
import { owned, pathId, resolveScoped, resolveScopedResource } from './shared.ts';

/**
 * `/api/v1/autopilots`.
 *
 * Workspace-scoped through `resolveScoped`, the same gate `/search` and
 * `/views` use for a query-parameter workspace. Routes that name an
 * autopilot find its workspace first and then gate on it; a caller who is
 * not a member gets the answer a random id gets, so an id from another
 * workspace cannot be told apart from one that does not exist.
 *
 * Trigger creation and rotation are the only places a token or signing
 * secret leaves the server, and they are deliberately not idempotent: the
 * idempotency store keeps response bodies, and a secret must not be kept.
 */

export interface AutopilotMountOptions {
   sessions: SessionService;
   sql: Sql;
   autopilots: AutopilotRepository;
   fire: FireFn;
   idempotency: IdempotencyStore;
   clock?: () => Date;
}

const UUID = z
   .string()
   .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
   .transform((value) => value.toLowerCase());
const EVENT_NAME = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/);

const draftFields = {
   name: z.string().trim().min(1).max(200),
   description: z.string().max(5000).nullable(),
   assigneeType: z.enum(ASSIGNEE_TYPES),
   assigneeId: UUID,
   promptTemplate: z.string().min(1).max(20000),
   executionMode: z.enum(EXECUTION_MODES),
   boardId: UUID.nullable(),
   issueId: UUID.nullable(),
   quotaPeriod: z.enum(QUOTA_PERIODS),
   quotaMax: z.number().int().min(1).max(10000).nullable(),
};

const createSchema = z.strictObject({
   workspaceId: UUID,
   ...draftFields,
   description: draftFields.description.default(null),
   boardId: draftFields.boardId.default(null),
   issueId: draftFields.issueId.default(null),
   quotaPeriod: draftFields.quotaPeriod.default('none'),
   quotaMax: draftFields.quotaMax.default(null),
});

const patchSchema = z
   .strictObject({ ...draftFields, status: z.enum(['active', 'paused']) })
   .partial();

const triggerSchema = z.discriminatedUnion('kind', [
   z.strictObject({
      kind: z.literal('cron'),
      expression: z.string().min(1).max(200),
      timezone: z.string().min(1).max(100),
      enabled: z.boolean().default(true),
   }),
   z.strictObject({
      kind: z.literal('webhook'),
      eventFilters: z.array(EVENT_NAME).max(50).default([]),
      enabled: z.boolean().default(true),
   }),
]);

const triggerPatchSchema = z
   .strictObject({
      enabled: z.boolean(),
      expression: z.string().min(1).max(200),
      timezone: z.string().min(1).max(100),
      eventFilters: z.array(EVENT_NAME).max(50),
   })
   .partial();

const membersSchema = z.strictObject({
   members: z
      .array(z.strictObject({ userId: UUID, role: z.enum(['collaborator', 'subscriber']) }))
      .max(200),
});

export function autopilotMounts(options: AutopilotMountOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));
   const { autopilots } = options;
   const clock = options.clock ?? (() => new Date());

   /**
    * The workspace an autopilot belongs to, once the caller is proven a member
    * with `required`. A trigger the route names is found in that workspace
    * before the permission is checked, so an absent or foreign trigger id is
    * the same 404 for every role, and a 403 only speaks of rows the caller
    * could already see.
    */
   async function scopeOf(
      context: Context<{ Variables: AuthVariables }>,
      autopilotId: string,
      required: Permission,
      triggerId?: string
   ): Promise<string> {
      const workspaceId = await autopilots.workspaceOf(autopilotId).catch(mapError);
      try {
         await resolveScopedResource(options.sql, context.get('user').id, workspaceId, required, async (db) => {
            if (triggerId) await owned('autopilot_triggers', triggerId, 'Autopilot')(db);
         });
      } catch (error) {
         // "Workspace not found" would say the autopilot exists somewhere.
         if (error instanceof ApiError && error.status === 404) throw ApiError.notFound('Autopilot');
         throw error;
      }
      return workspaceId;
   }

   route.get('/cron-preview', (context) => {
      const url = new URL(context.req.url);
      const expression = url.searchParams.get('expression') ?? '';
      const timezone = url.searchParams.get('timezone') ?? 'UTC';
      const count = Number(url.searchParams.get('count') ?? '5');
      try {
         const times = nextFireTimes(expression, timezone, clock(), count);
         return json({ expression, timezone, times: times.map((time) => time.toISOString()) });
      } catch (error) {
         return mapError(error);
      }
   });

   route.get('/', async (context) => {
      const workspaceId = new URL(context.req.url).searchParams.get('workspaceId') ?? '';
      if (!workspaceId) assertValid([fieldError('/workspaceId', 'required', 'workspaceId is required.')]);
      const scoped = await resolveScoped(options.sql, context.get('user').id, workspaceId);
      const nodes = await autopilots.list(scoped.ctx.workspaceId);
      return json({ nodes: nodes.map(serializeAutopilot) });
   });

   route.post('/', idempotent(options.idempotency), async (context) => {
      const body = await readJson(context, createSchema);
      const scoped = await resolveScoped(options.sql, context.get('user').id, body.workspaceId, 'product.write');
      const { workspaceId: _ignored, ...draft } = body;
      const created = await autopilots
         .create(scoped.ctx.workspaceId, draft, context.get('user').id)
         .catch(mapError);
      return json(serializeAutopilot(created), 201);
   });

   route.get('/:autopilotId', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.read');
      const [autopilot, triggers, members] = await Promise.all([
         autopilots.get(workspaceId, id),
         autopilots.triggers(workspaceId, id),
         autopilots.members(workspaceId, id),
      ]).catch(mapError);
      return json({ ...serializeAutopilot(autopilot), triggers: triggers.map(serializeTrigger), members });
   });

   route.patch('/:autopilotId', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.write');
      const patch = await readJson(context, patchSchema);
      const updated = await autopilots.update(workspaceId, id, patch, context.get('user').id).catch(mapError);
      return json(serializeAutopilot(updated));
   });

   route.delete('/:autopilotId', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.write');
      await autopilots.archive(workspaceId, id, context.get('user').id).catch(mapError);
      return new Response(null, { status: 204 });
   });

   route.post('/:autopilotId/run', idempotent(options.idempotency), async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      await scopeOf(context, id, 'runs.dispatch');
      const outcome = await options
         .fire({ autopilotId: id, source: 'manual', requestedBy: context.get('user').id })
         .catch(mapError);
      return json(outcome, 202);
   });

   route.get('/:autopilotId/versions', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.read');
      return json({ nodes: await autopilots.versions(workspaceId, id).catch(mapError) });
   });

   route.put('/:autopilotId/members', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.write');
      const body = await readJson(context, membersSchema);
      return json({ nodes: await autopilots.setMembers(workspaceId, id, body.members).catch(mapError) });
   });

   route.post('/:autopilotId/triggers', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.write');
      const body = await readJson(context, triggerSchema);
      if (body.kind === 'cron') {
         const trigger = await autopilots
            .addCronTrigger(workspaceId, id, {
               expression: body.expression,
               timezone: body.timezone,
               enabled: body.enabled,
            })
            .catch(mapError);
         return json({ trigger: serializeTrigger(trigger) }, 201);
      }
      const made = await autopilots
         .addWebhookTrigger(workspaceId, id, { eventFilters: body.eventFilters, enabled: body.enabled })
         .catch(mapError);
      return secretResponse(made.trigger, made.secrets, 201);
   });

   route.patch('/:autopilotId/triggers/:triggerId', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const triggerId = pathId(context.req.param('triggerId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.write', triggerId);
      const patch = await readJson(context, triggerPatchSchema);
      const trigger = await autopilots.updateTrigger(workspaceId, id, triggerId, patch).catch(mapError);
      return json(serializeTrigger(trigger));
   });

   route.delete('/:autopilotId/triggers/:triggerId', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const triggerId = pathId(context.req.param('triggerId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.write', triggerId);
      await autopilots.deleteTrigger(workspaceId, id, triggerId).catch(mapError);
      return new Response(null, { status: 204 });
   });

   route.post('/:autopilotId/triggers/:triggerId/rotate', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const triggerId = pathId(context.req.param('triggerId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.write', triggerId);
      const made = await autopilots.rotateWebhook(workspaceId, id, triggerId).catch(mapError);
      return secretResponse(made.trigger, made.secrets, 200);
   });

   route.get('/:autopilotId/runs', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.read');
      return json({ nodes: await autopilots.runs(workspaceId, id) });
   });

   route.get('/:autopilotId/deliveries', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.read');
      return json({ nodes: await autopilots.deliveries(workspaceId, id) });
   });

   /** One delivery with the payload it carried, for the deliveries tab. */
   route.get('/:autopilotId/deliveries/:deliveryId', async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const deliveryId = pathId(context.req.param('deliveryId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'product.read');
      const { delivery, payload } = await autopilots.deliveryPayload(workspaceId, id, deliveryId).catch(mapError);
      return json({ ...delivery, payload });
   });

   /**
    * Fires again with what the delivery carried. The signature was checked
    * when it first arrived; a replay is a member of the workspace asking,
    * which is why it needs `runs.dispatch` rather than the secret.
    */
   route.post('/:autopilotId/deliveries/:deliveryId/replay', idempotent(options.idempotency), async (context) => {
      const id = pathId(context.req.param('autopilotId'), 'Autopilot');
      const deliveryId = pathId(context.req.param('deliveryId'), 'Autopilot');
      const workspaceId = await scopeOf(context, id, 'runs.dispatch');
      const { delivery, payload } = await autopilots.deliveryPayload(workspaceId, id, deliveryId).catch(mapError);
      // A rejected delivery was refused at the door — a bad signature, a body
      // that was not a JSON object, or a disabled trigger. Replaying the
      // first would fire on the word of an unverified sender, and the others
      // were refused on purpose. Refused here, not only hidden in the UI.
      if (delivery.status === 'rejected') {
         throw new ApiError(
            409,
            'DELIVERY_NOT_REPLAYABLE',
            'This delivery was refused before it was read, so there is nothing to replay.'
         );
      }
      const replayId = await autopilots.recordDelivery({
         workspaceId,
         autopilotId: id,
         triggerId: delivery.triggerId,
         event: delivery.event,
         status: 'accepted',
         payload,
         failureReason: null,
         replayOf: deliveryId,
      });
      const outcome = await options
         .fire({
            autopilotId: id,
            source: 'replay',
            triggerId: delivery.triggerId,
            payload,
            requestedBy: context.get('user').id,
         })
         .catch(async (error: unknown) => {
            // The replay row exists already; it must not claim `accepted`
            // for a firing that never happened.
            await autopilots.linkDelivery(replayId, null, 'failed');
            return mapError(error);
         });
      await autopilots.linkDelivery(replayId, outcome.autopilotRunId, outcome.status === 'failed' ? 'failed' : 'accepted');
      return json(outcome, 202);
   });

   return [{ prefix: '/api/v1/autopilots', handler: route }];
}

export function serializeAutopilot(autopilot: Autopilot): Record<string, unknown> {
   return {
      id: autopilot.id,
      workspaceId: autopilot.workspaceId,
      name: autopilot.name,
      description: autopilot.description,
      assigneeType: autopilot.assigneeType,
      assigneeId: autopilot.assigneeId,
      promptTemplate: autopilot.promptTemplate,
      executionMode: autopilot.executionMode,
      boardId: autopilot.boardId,
      issueId: autopilot.issueId,
      status: autopilot.status,
      version: autopilot.version,
      quotaPeriod: autopilot.quotaPeriod,
      quotaMax: autopilot.quotaMax,
      createdBy: autopilot.createdBy,
      triggerKinds: autopilot.triggerKinds,
      createdAt: autopilot.createdAt,
      updatedAt: autopilot.updatedAt,
   };
}

function serializeTrigger(trigger: AutopilotTrigger): Record<string, unknown> {
   return {
      id: trigger.id,
      autopilotId: trigger.autopilotId,
      kind: trigger.kind,
      enabled: trigger.enabled,
      cronExpression: trigger.cronExpression,
      timezone: trigger.timezone,
      nextFireAt: trigger.nextFireAt,
      lastFiredAt: trigger.lastFiredAt,
      tokenHint: trigger.tokenHint,
      eventFilters: trigger.eventFilters,
      createdAt: trigger.createdAt,
      updatedAt: trigger.updatedAt,
   };
}

function secretResponse(trigger: AutopilotTrigger, secrets: WebhookSecrets, status: number): Response {
   const response = json(
      {
         trigger: serializeTrigger(trigger),
         secrets: {
            token: secrets.token,
            signingSecret: secrets.signingSecret,
            ingressPath: `/api/webhooks/autopilots/${secrets.token}`,
         },
      },
      status
   );
   response.headers.set('cache-control', 'no-store');
   return response;
}

async function readJson<T extends z.ZodType>(
   context: Context<{ Variables: AuthVariables }>,
   schema: T
): Promise<z.output<T>> {
   let raw: unknown;
   try {
      raw = await context.req.json();
   } catch {
      throw ApiError.badRequest('Request body must be one JSON object.');
   }
   const result = schema.safeParse(raw);
   if (!result.success) {
      assertValid(
         result.error.issues.map((issue) =>
            fieldError(`/${issue.path.map(String).join('/')}`, 'invalid_value', issue.message)
         )
      );
      throw ApiError.badRequest('The request is invalid.');
   }
   return result.data;
}

/** Every domain failure mapped once, here. */
function mapError(error: unknown): never {
   if (error instanceof InvalidAutopilot) {
      assertValid([fieldError(error.field, 'invalid_value', error.message)]);
   }
   if (error instanceof InvalidSchedule) {
      assertValid([fieldError('/expression', 'invalid_value', error.message)]);
   }
   if (error instanceof SealingUnavailable) {
      throw new ApiError(
         412,
         'INTEGRATIONS_NOT_CONFIGURED',
         'This server has no encryption key, so it cannot hold a webhook signing secret.'
      );
   }
   throw toApiError(error, 'Autopilot');
}
