import { z } from 'zod';
import { BerryApiError, apiFetch } from './api';
import { newIdempotencyKey } from './api-schemas';
import type { EventEnvelope } from './events';

/**
 * Autopilots: an agent, a prompt, and what makes it run — a schedule, a
 * signed webhook, or a person pressing "run now". Each firing becomes one
 * agent task. Shapes mirror `server-ts/src/mounts/autopilots.ts`.
 */

export const ASSIGNEE_TYPES = ['agent', 'squad'] as const;
export const EXECUTION_MODES = ['create_issue', 'fixed_issue'] as const;
export const QUOTA_PERIODS = ['none', 'hour', 'day', 'week'] as const;

export const autopilotSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   name: z.string(),
   description: z.string().nullable(),
   assigneeType: z.enum(ASSIGNEE_TYPES),
   assigneeId: z.string(),
   promptTemplate: z.string(),
   executionMode: z.enum(EXECUTION_MODES),
   boardId: z.string().nullable(),
   issueId: z.string().nullable(),
   status: z.enum(['active', 'paused', 'archived']),
   version: z.number(),
   quotaPeriod: z.enum(QUOTA_PERIODS),
   quotaMax: z.number().nullable(),
   createdBy: z.string().nullable(),
   /** What makes it run, without fetching each autopilot's triggers in turn. */
   triggerKinds: z.array(z.enum(['cron', 'webhook'])).default([]),
   createdAt: z.string(),
   updatedAt: z.string(),
});

export const autopilotTriggerSchema = z.object({
   id: z.string(),
   autopilotId: z.string(),
   kind: z.enum(['cron', 'webhook']),
   enabled: z.boolean(),
   cronExpression: z.string().nullable(),
   timezone: z.string().nullable(),
   nextFireAt: z.string().nullable(),
   lastFiredAt: z.string().nullable(),
   tokenHint: z.string().nullable(),
   eventFilters: z.array(z.string()),
   createdAt: z.string(),
   updatedAt: z.string(),
});

export const autopilotDetailSchema = autopilotSchema.extend({
   triggers: z.array(autopilotTriggerSchema),
   members: z.array(
      z.object({
         userId: z.string(),
         role: z.enum(['collaborator', 'subscriber']),
         createdAt: z.string(),
      })
   ),
});

export const webhookSecretsSchema = z.object({
   token: z.string(),
   signingSecret: z.string(),
   ingressPath: z.string(),
});

export const autopilotRunSchema = z.object({
   id: z.string(),
   autopilotId: z.string(),
   autopilotVersion: z.number(),
   triggerId: z.string().nullable(),
   source: z.enum(['cron', 'webhook', 'manual', 'replay']),
   status: z.enum(['pending', 'enqueued', 'skipped', 'failed']),
   reasonCode: z.string().nullable(),
   reasonMessage: z.string().nullable(),
   issueId: z.string().nullable(),
   runId: z.string().nullable(),
   taskStatus: z.string().nullable(),
   slot: z.string().nullable(),
   requestedBy: z.string().nullable(),
   createdAt: z.string(),
});

export const webhookDeliverySchema = z.object({
   id: z.string(),
   autopilotId: z.string(),
   triggerId: z.string().nullable(),
   event: z.string().nullable(),
   status: z.enum(['accepted', 'filtered', 'rejected', 'failed']),
   failureReason: z.string().nullable(),
   autopilotRunId: z.string().nullable(),
   replayOf: z.string().nullable(),
   receivedAt: z.string(),
});

export const fireOutcomeSchema = z.object({
   autopilotRunId: z.string(),
   status: z.enum(['enqueued', 'skipped', 'failed']),
   reasonCode: z.string().nullable(),
   runId: z.string().nullable(),
   issueId: z.string().nullable(),
});

export type Autopilot = z.infer<typeof autopilotSchema>;
export type AutopilotDetail = z.infer<typeof autopilotDetailSchema>;
export type AutopilotTrigger = z.infer<typeof autopilotTriggerSchema>;
export type AutopilotRun = z.infer<typeof autopilotRunSchema>;
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;
export type WebhookSecrets = z.infer<typeof webhookSecretsSchema>;
export type FireOutcome = z.infer<typeof fireOutcomeSchema>;

export interface AutopilotDraft {
   name: string;
   description: string | null;
   assigneeType: (typeof ASSIGNEE_TYPES)[number];
   assigneeId: string;
   promptTemplate: string;
   executionMode: (typeof EXECUTION_MODES)[number];
   boardId: string | null;
   issueId: string | null;
   quotaPeriod: (typeof QUOTA_PERIODS)[number];
   quotaMax: number | null;
}

export type AutopilotPatch = Partial<AutopilotDraft> & { status?: 'active' | 'paused' };

function parse<T extends z.ZodTypeAny>(schema: T, json: unknown, what: string): z.infer<T> {
   const parsed = schema.safeParse(json);
   if (!parsed.success) throw new Error(`${what} was not recognized`);
   return parsed.data;
}

const base = '/api/v1/autopilots';
const at = (id: string) => `${base}/${encodeURIComponent(id)}`;

function send(method: string, body: unknown, idempotent = false): RequestInit {
   return {
      method,
      headers: {
         'content-type': 'application/json',
         ...(idempotent ? { 'Idempotency-Key': newIdempotencyKey() } : {}),
      },
      body: JSON.stringify(body),
   };
}

export async function listAutopilots(workspaceId: string): Promise<Autopilot[]> {
   const json: unknown = await apiFetch(`${base}?workspaceId=${encodeURIComponent(workspaceId)}`);
   return parse(z.object({ nodes: z.array(autopilotSchema) }), json, 'Autopilot list').nodes;
}

export async function getAutopilot(id: string, signal?: AbortSignal): Promise<AutopilotDetail> {
   const json: unknown = await apiFetch(at(id), undefined, { signal });
   return parse(autopilotDetailSchema, json, 'Autopilot');
}

export async function createAutopilot(
   workspaceId: string,
   draft: AutopilotDraft
): Promise<Autopilot> {
   const json: unknown = await apiFetch(base, send('POST', { workspaceId, ...draft }, true));
   return parse(autopilotSchema, json, 'Created autopilot');
}

export async function updateAutopilot(id: string, patch: AutopilotPatch): Promise<Autopilot> {
   const json: unknown = await apiFetch(at(id), send('PATCH', patch));
   return parse(autopilotSchema, json, 'Updated autopilot');
}

export async function archiveAutopilot(id: string): Promise<void> {
   await apiFetch(at(id), { method: 'DELETE' });
}

export async function runAutopilot(id: string): Promise<FireOutcome> {
   const json: unknown = await apiFetch(`${at(id)}/run`, send('POST', {}, true));
   return parse(fireOutcomeSchema, json, 'Run');
}

export async function previewCron(
   expression: string,
   timezone: string,
   count = 5
): Promise<string[]> {
   const params = new URLSearchParams({ expression, timezone, count: String(count) });
   const json: unknown = await apiFetch(`${base}/cron-preview?${params.toString()}`);
   return parse(z.object({ times: z.array(z.string()) }), json, 'Schedule preview').times;
}

export async function addCronTrigger(
   id: string,
   input: { expression: string; timezone: string }
): Promise<AutopilotTrigger> {
   const json: unknown = await apiFetch(
      `${at(id)}/triggers`,
      send('POST', { kind: 'cron', ...input })
   );
   return parse(z.object({ trigger: autopilotTriggerSchema }), json, 'Schedule').trigger;
}

/** The secrets come back once. The caller must show them now; nothing can fetch them again. */
export async function addWebhookTrigger(
   id: string,
   eventFilters: string[]
): Promise<{ trigger: AutopilotTrigger; secrets: WebhookSecrets }> {
   const json: unknown = await apiFetch(
      `${at(id)}/triggers`,
      send('POST', { kind: 'webhook', eventFilters })
   );
   return parse(
      z.object({ trigger: autopilotTriggerSchema, secrets: webhookSecretsSchema }),
      json,
      'Webhook'
   );
}

export async function updateTrigger(
   id: string,
   triggerId: string,
   patch: { enabled?: boolean; expression?: string; timezone?: string; eventFilters?: string[] }
): Promise<AutopilotTrigger> {
   const json: unknown = await apiFetch(
      `${at(id)}/triggers/${encodeURIComponent(triggerId)}`,
      send('PATCH', patch)
   );
   return parse(autopilotTriggerSchema, json, 'Trigger');
}

export async function deleteTrigger(id: string, triggerId: string): Promise<void> {
   await apiFetch(`${at(id)}/triggers/${encodeURIComponent(triggerId)}`, { method: 'DELETE' });
}

export async function rotateWebhook(
   id: string,
   triggerId: string
): Promise<{ trigger: AutopilotTrigger; secrets: WebhookSecrets }> {
   const json: unknown = await apiFetch(
      `${at(id)}/triggers/${encodeURIComponent(triggerId)}/rotate`,
      send('POST', {})
   );
   return parse(
      z.object({ trigger: autopilotTriggerSchema, secrets: webhookSecretsSchema }),
      json,
      'Rotated webhook'
   );
}

/**
 * Who is kept in the loop. A collaborator may change the autopilot; a
 * subscriber only hears about it. The list replaces what was there.
 */
export async function setAutopilotMembers(
   id: string,
   members: Array<{ userId: string; role: 'collaborator' | 'subscriber' }>
): Promise<void> {
   await apiFetch(`${at(id)}/members`, send('PUT', { members }));
}

export async function listAutopilotRuns(id: string): Promise<AutopilotRun[]> {
   const json: unknown = await apiFetch(`${at(id)}/runs`);
   return parse(z.object({ nodes: z.array(autopilotRunSchema) }), json, 'Runs').nodes;
}

export async function listWebhookDeliveries(id: string): Promise<WebhookDelivery[]> {
   const json: unknown = await apiFetch(`${at(id)}/deliveries`);
   return parse(z.object({ nodes: z.array(webhookDeliverySchema) }), json, 'Deliveries').nodes;
}

export const webhookDeliveryDetailSchema = webhookDeliverySchema.extend({ payload: z.unknown() });
export type WebhookDeliveryDetail = z.infer<typeof webhookDeliveryDetailSchema>;

export async function getWebhookDelivery(
   id: string,
   deliveryId: string
): Promise<WebhookDeliveryDetail> {
   const json: unknown = await apiFetch(`${at(id)}/deliveries/${encodeURIComponent(deliveryId)}`);
   return parse(webhookDeliveryDetailSchema, json, 'Delivery');
}

export async function replayDelivery(id: string, deliveryId: string): Promise<FireOutcome> {
   const json: unknown = await apiFetch(
      `${at(id)}/deliveries/${encodeURIComponent(deliveryId)}/replay`,
      send('POST', {}, true)
   );
   return parse(fireOutcomeSchema, json, 'Replay');
}

/** A message a person can act on; the thrown error keeps the detail. */
export function describeAutopilotFailure(error: unknown): string {
   if (error instanceof BerryApiError) {
      if (error.status === 404) return 'This autopilot does not exist, or is in another workspace.';
      if (error.status === 403) return 'Your role cannot change autopilots in this workspace.';
      if (error.code === 'INTEGRATIONS_NOT_CONFIGURED') {
         return 'This server has no encryption key, so it cannot keep a webhook secret.';
      }
      return error.message;
   }
   return error instanceof Error ? error.message : 'Something went wrong.';
}

/** Whether a stream frame is about autopilots — and, given an id, about that one. */
export function isAutopilotEvent(event: EventEnvelope, autopilotId?: string): boolean {
   if (!event.type.startsWith('autopilot.')) return false;
   if (!autopilotId) return true;
   const payload = event.payload;
   if (typeof payload !== 'object' || payload === null) return false;
   return (payload as { autopilotId?: unknown }).autopilotId === autopilotId;
}

/** Reads a stored reason code the way the run history shows it. */
export function describeReason(code: string | null): string {
   switch (code) {
      case null:
         return '';
      case 'PAUSED':
         return 'Paused';
      case 'ARCHIVED':
         return 'Archived';
      case 'QUOTA_EXCEEDED':
         return 'Over quota';
      case 'SQUAD_UNAVAILABLE':
         return 'No squad leader';
      case 'TARGET_MISSING':
         return 'Task or board gone';
      case 'ENQUEUE_FAILED':
         return 'Could not queue';
      default:
         return code;
   }
}
