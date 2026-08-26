import { z } from 'zod';
import { BerryApiError, apiFetch } from './api';
import { connectionSchema, newIdempotencyKey } from './api-schemas';
import { describeCron } from './cron';
import {
   describeBerryEvent,
   describePlanTrigger,
   fieldErrorSchema,
   planStepSchema,
   planTriggerSchema,
   type FieldError,
   type PlanStep,
   type PlanTrigger,
} from './plans';
import { workflowRunSchema, type WorkflowRun } from './workflow-runs';

/**
 * Workflows: a stored `WorkflowDefinition v1` — one trigger, typed steps, the
 * entry steps — with the status, revision and run summary the API keeps
 * beside it. The wire step shapes are the planner's, so a plan's workflow
 * card and a saved workflow read through the same helpers.
 */

export const workflowStatusSchema = z.enum(['draft', 'active', 'paused', 'archived']);
export const workflowTriggerTypeSchema = z.enum([
   'integration',
   'schedule',
   'manual',
   'berry_event',
   'webhook',
]);
export const workflowRiskSchema = z.enum(['low', 'medium', 'high']);

export const workflowDefinitionSchema = z.object({
   version: z.string(),
   trigger: planTriggerSchema,
   steps: z.array(planStepSchema).default([]),
   entry: z.array(z.string()).default([]),
});

const workflowRecordSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   projectId: z.string().nullish(),
   goalId: z.string().nullish(),
   name: z.string(),
   description: z.string().nullish(),
   status: workflowStatusSchema,
   version: z.number(),
   revision: z.number(),
   definition: z.unknown(),
   layout: z.record(z.unknown()).default({}),
   trigger: z.object({
      type: workflowTriggerTypeSchema,
      provider: z.string().nullish(),
      operation: z.string().nullish(),
      event: z.string().nullish(),
      cron: z.string().nullish(),
      timezone: z.string().nullish(),
   }),
   risk: workflowRiskSchema,
   engine: z.string(),
   activepiecesFlowId: z.string().nullish(),
   requiredConnections: z
      .array(z.object({ provider: z.string(), connected: z.boolean() }))
      .default([]),
   validation: z
      .object({
         errors: z.array(fieldErrorSchema).default([]),
         warnings: z.array(fieldErrorSchema).default([]),
      })
      .default({ errors: [], warnings: [] }),
   createdBy: z.object({ type: z.string(), id: z.string() }).nullish(),
   createdAt: z.string(),
   updatedAt: z.string(),
   lastRun: z.object({ id: z.string(), status: z.string(), createdAt: z.string() }).nullish(),
   runCounts: z
      .object({ total: z.number(), succeeded: z.number(), failed: z.number() })
      .default({ total: 0, succeeded: 0, failed: 0 }),
});

const workflowConnectionSchema = connectionSchema(workflowRecordSchema);

export const workflowVersionSchema = z.object({
   id: z.string(),
   version: z.number(),
   definition: z.unknown(),
   createdBy: z.string().nullish(),
   createdAt: z.string(),
});

export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;
export type WorkflowTriggerType = z.infer<typeof workflowTriggerTypeSchema>;
export type WorkflowRisk = z.infer<typeof workflowRiskSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
/**
 * A workflow as read: `definition` is the typed view every list and summary
 * renders; `definitionSource` is the same definition exactly as stored, for
 * the canvas to edit and send back. The typed view normalises a step it
 * cannot place (a known type missing a required field, or a type this build
 * does not know) into an `unknown` row, which is right for reading and wrong
 * for writing — a draft with a validation error must round-trip untouched.
 */
export type Workflow = Omit<z.infer<typeof workflowRecordSchema>, 'definition'> & {
   definition: WorkflowDefinition;
   definitionSource: WorkflowDefinitionInput;
};
export type WorkflowVersion = z.infer<typeof workflowVersionSchema>;
export type WorkflowStep = PlanStep;
export type WorkflowTrigger = PlanTrigger;

// ---------------------------------------------------------------------------
// What a definition looks like on the way out

export interface WorkflowTriggerInput {
   id: string;
   type: WorkflowTriggerType;
   provider?: string;
   operation?: string;
   event?: string;
   config?: { cron?: string; timezone?: string; filter?: unknown };
}

/** A step as written: the header plus whatever the type needs. */
export type WorkflowStepInput = {
   id: string;
   type: string;
   dependsOn?: string[];
   onError?: 'fail' | 'skip' | null;
} & Record<string, unknown>;

const editableStepSchema = z
   .object({
      id: z.string(),
      type: z.string(),
      dependsOn: z.array(z.string()).optional(),
      onError: z.enum(['fail', 'skip']).nullish(),
   })
   .passthrough();

/** The stored definition with every field kept, whether or not this build knows it. */
export const editableDefinitionSchema = z.object({
   version: z.string(),
   trigger: planTriggerSchema.passthrough(),
   steps: z.array(editableStepSchema).default([]),
   entry: z.array(z.string()).default([]),
});

export interface WorkflowDefinitionInput {
   version: '1';
   trigger: WorkflowTriggerInput;
   steps: WorkflowStepInput[];
   entry: string[];
}

/** The outbox topics a `berry_event` trigger may subscribe to, with their labels. */
export const BERRY_EVENTS: { topic: string; label: string }[] = [
   { topic: 'issue.created', label: 'a task is created' },
   { topic: 'issue.updated', label: 'a task changes' },
   { topic: 'issue.assigned', label: 'a task is assigned' },
   { topic: 'issue.started', label: 'a task is started' },
   { topic: 'issue.completed', label: 'a task is completed' },
   { topic: 'issue.deleted', label: 'a task is deleted' },
   { topic: 'goal.created', label: 'a goal is created' },
   { topic: 'goal.started', label: 'a goal is started' },
   { topic: 'goal.completed', label: 'a goal is completed' },
   { topic: 'goal.cancelled', label: 'a goal is cancelled' },
   { topic: 'run.completed', label: 'an agent run completes' },
   { topic: 'run.failed', label: 'an agent run fails' },
   { topic: 'run.cancelled', label: 'an agent run is cancelled' },
   { topic: 'agent.started', label: 'an agent starts working' },
   { topic: 'agent.completed', label: 'an agent finishes its work' },
   { topic: 'agent.failed', label: 'an agent fails' },
   { topic: 'approval.requested', label: 'an approval is requested' },
   { topic: 'approval.approved', label: 'an approval is granted' },
   { topic: 'approval.rejected', label: 'an approval is refused' },
   { topic: 'approval.expired', label: 'an approval expires' },
   { topic: 'artifact.created', label: 'a run produces an artifact' },
   { topic: 'integration.webhook.received', label: 'an integration webhook arrives' },
   { topic: 'plan.updated', label: 'a plan changes' },
];

export function describeWorkflowEvent(topic: string): string {
   return BERRY_EVENTS.find((entry) => entry.topic === topic)?.label ?? describeBerryEvent(topic);
}

// ---------------------------------------------------------------------------
// Calls

function toDefinitionInput(
   source: z.infer<typeof editableDefinitionSchema>
): WorkflowDefinitionInput {
   const { config, ...trigger } = source.trigger;
   const triggerInput: WorkflowTriggerInput = {
      ...trigger,
      id: trigger.id,
      type: trigger.type,
      provider: trigger.provider ?? undefined,
      operation: trigger.operation ?? undefined,
      event: trigger.event ?? undefined,
   };
   if (config) {
      triggerInput.config = {
         cron: config.cron ?? undefined,
         timezone: config.timezone ?? undefined,
         filter: config.filter ?? undefined,
      };
   }
   return {
      version: '1',
      trigger: triggerInput,
      steps: source.steps.map((step) => ({ ...step })),
      entry: source.entry.slice(),
   };
}

/** Both views of a record's definition, or undefined when it is not a definition at all. */
function fromRecord(record: z.infer<typeof workflowRecordSchema>): Workflow | undefined {
   const typed = workflowDefinitionSchema.safeParse(record.definition);
   const source = editableDefinitionSchema.safeParse(record.definition);
   if (!typed.success || !source.success) return undefined;
   return { ...record, definition: typed.data, definitionSource: toDefinitionInput(source.data) };
}

function parseWorkflow(json: unknown): Workflow {
   const parsed = workflowRecordSchema.safeParse(json);
   const workflow = parsed.success ? fromRecord(parsed.data) : undefined;
   if (!workflow) {
      throw new Error('Workflow response was not recognized');
   }
   return workflow;
}

export interface WorkflowsQuery {
   status?: WorkflowStatus;
   triggerType?: WorkflowTriggerType;
   goalId?: string;
   projectId?: string;
   query?: string;
   first?: number;
}

export async function listWorkspaceWorkflows(
   workspaceId: string,
   query: WorkflowsQuery = {}
): Promise<Workflow[]> {
   const collected: Workflow[] = [];
   const limit = query.first ?? 200;
   let after: string | undefined;
   for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ workspaceId, first: String(Math.min(limit, 100)) });
      if (query.status) params.set('status', query.status);
      if (query.triggerType) params.set('triggerType', query.triggerType);
      if (query.goalId) params.set('goalId', query.goalId);
      if (query.projectId) params.set('projectId', query.projectId);
      if (query.query) params.set('query', query.query);
      if (after) params.set('after', after);
      const json: unknown = await apiFetch(`/api/v1/workflows?${params.toString()}`);
      const parsed = workflowConnectionSchema.safeParse(json);
      if (!parsed.success) {
         throw new Error('Workflow list was not recognized');
      }
      for (const node of parsed.data.nodes) {
         const workflow = fromRecord(node);
         if (workflow) collected.push(workflow);
      }
      const { hasNextPage, endCursor } = parsed.data.pageInfo;
      if (!hasNextPage || !endCursor || parsed.data.nodes.length === 0) break;
      if (collected.length >= limit) break;
      after = endCursor;
   }
   return collected.slice(0, limit);
}

/** Workflows for the store; a failed read leaves the list empty. */
export async function loadWorkspaceWorkflows(workspaceId: string): Promise<Workflow[]> {
   if (!workspaceId) return [];
   try {
      return await listWorkspaceWorkflows(workspaceId);
   } catch {
      return [];
   }
}

export async function getWorkflow(workflowId: string, signal?: AbortSignal): Promise<Workflow> {
   const json: unknown = await apiFetch(
      `/api/v1/workflows/${encodeURIComponent(workflowId)}`,
      undefined,
      { signal }
   );
   return parseWorkflow(json);
}

export interface CreateWorkflowInput {
   workspaceId: string;
   name: string;
   description?: string;
   projectId?: string;
   goalId?: string;
   definition: WorkflowDefinitionInput;
   layout?: Record<string, { x: number; y: number }>;
}

/**
 * Creates a draft. Throws `DEFINITION_INVALID` with `details.fields[]`
 * (JSON pointers under `/definition`) when the definition does not validate
 * against the workspace's tool catalog; `definitionFieldErrors` reads them.
 */
export async function createWorkflow(input: CreateWorkflowInput): Promise<Workflow> {
   const body: Record<string, unknown> = {
      workspaceId: input.workspaceId,
      name: input.name,
      definition: input.definition,
   };
   if (input.description) body.description = input.description;
   if (input.projectId) body.projectId = input.projectId;
   if (input.goalId) body.goalId = input.goalId;
   if (input.layout) body.layout = input.layout;
   const json: unknown = await apiFetch('/api/v1/workflows', {
      method: 'POST',
      headers: { 'Idempotency-Key': newIdempotencyKey() },
      body: JSON.stringify(body),
   });
   return parseWorkflow(json);
}

export interface WorkflowPatch {
   name?: string;
   description?: string | null;
   definition?: WorkflowDefinitionInput;
   layout?: Record<string, { x: number; y: number }>;
   goalId?: string | null;
   projectId?: string | null;
   /** The revision the caller read; the server refuses a stale one. */
   revision: number;
}

/** Throws `REVISION_CONFLICT`, `WORKFLOW_ACTIVE`, `DEFINITION_INVALID`. */
export async function patchWorkflow(workflowId: string, patch: WorkflowPatch): Promise<Workflow> {
   const json: unknown = await apiFetch(`/api/v1/workflows/${encodeURIComponent(workflowId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
   });
   return parseWorkflow(json);
}

/** Archives; runs and versions stay readable. */
export async function archiveWorkflow(workflowId: string): Promise<void> {
   await apiFetch(`/api/v1/workflows/${encodeURIComponent(workflowId)}`, { method: 'DELETE' });
}

/** Throws `CONNECTIONS_MISSING`, `WORKFLOW_ENGINE_DISABLED`, `FORBIDDEN`, `DEFINITION_INVALID`. */
export async function activateWorkflow(workflowId: string): Promise<Workflow> {
   const json: unknown = await apiFetch(
      `/api/v1/workflows/${encodeURIComponent(workflowId)}/activate`,
      { method: 'POST' }
   );
   return parseWorkflow(json);
}

/** Throws `WORKFLOW_NOT_ACTIVE`. */
export async function pauseWorkflow(workflowId: string): Promise<Workflow> {
   const json: unknown = await apiFetch(
      `/api/v1/workflows/${encodeURIComponent(workflowId)}/pause`,
      { method: 'POST' }
   );
   return parseWorkflow(json);
}

/**
 * Run now. Any trigger type may be run by hand; the input becomes
 * `trigger.input` in the run. Throws `WORKFLOW_NOT_ACTIVE`, `FORBIDDEN`,
 * `WORKFLOWS_DISABLED`.
 */
export async function runWorkflow(workflowId: string, input?: unknown): Promise<WorkflowRun> {
   const json: unknown = await apiFetch(
      `/api/v1/workflows/${encodeURIComponent(workflowId)}/runs`,
      {
         method: 'POST',
         headers: { 'Idempotency-Key': newIdempotencyKey() },
         body: JSON.stringify(input === undefined ? {} : { input }),
      }
   );
   const parsed = workflowRunSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Workflow run response was not recognized');
   }
   return parsed.data;
}

export async function listWorkflowVersions(workflowId: string): Promise<WorkflowVersion[]> {
   const json: unknown = await apiFetch(
      `/api/v1/workflows/${encodeURIComponent(workflowId)}/versions`
   );
   const parsed = z.object({ nodes: z.array(workflowVersionSchema) }).safeParse(json);
   if (!parsed.success) return [];
   return parsed.data.nodes;
}

export interface WebhookSecret {
   url: string;
   secret: string;
}

/** Rotates the hook token; the secret is returned this once and never again. */
export async function rotateWorkflowWebhook(workflowId: string): Promise<WebhookSecret> {
   const json: unknown = await apiFetch(
      `/api/v1/workflows/${encodeURIComponent(workflowId)}/webhook`,
      { method: 'POST' }
   );
   const parsed = z.object({ url: z.string(), secret: z.string() }).safeParse(json);
   if (!parsed.success) {
      throw new Error('Webhook response was not recognized');
   }
   return parsed.data;
}

// ---------------------------------------------------------------------------
// Reading a workflow

export function describeWorkflowStatus(status: string): string {
   switch (status) {
      case 'draft':
         return 'Draft';
      case 'active':
         return 'Active';
      case 'paused':
         return 'Paused';
      case 'archived':
         return 'Archived';
      default:
         return status;
   }
}

/**
 * "When a task is completed", "Run by hand", "When a webhook arrives",
 * "Every weekday at 09:00 · Europe/Rome", "GitHub · issues.opened". The
 * provider's display name comes from the caller, which has the catalog.
 */
export function describeWorkflowTrigger(
   trigger: {
      type: string;
      provider?: string | null;
      operation?: string | null;
      event?: string | null;
      cron?: string | null;
      timezone?: string | null;
      config?: { cron?: string | null; timezone?: string | null } | null;
   },
   options: { providerName?: string | null } = {}
): string {
   if (trigger.type === 'berry_event') {
      return `When ${describeWorkflowEvent(trigger.event ?? '')}`;
   }
   if (trigger.type === 'manual') return 'Run by hand';
   if (trigger.type === 'schedule') {
      const cron = trigger.cron ?? trigger.config?.cron ?? '';
      const timezone = trigger.timezone ?? trigger.config?.timezone;
      return describeCron(cron, timezone);
   }
   if (trigger.type === 'integration') {
      const what = trigger.operation ?? trigger.event ?? '';
      const who = options.providerName ?? trigger.provider ?? 'integration';
      return what ? `${who} · ${what}` : who;
   }
   const planTrigger = planTriggerSchema.safeParse({
      id: 'trigger',
      type: trigger.type,
      provider: trigger.provider,
      operation: trigger.operation,
      event: trigger.event,
      config: {
         cron: trigger.cron ?? trigger.config?.cron,
         timezone: trigger.timezone ?? trigger.config?.timezone,
      },
   });
   return planTrigger.success ? describePlanTrigger(planTrigger.data) : trigger.type;
}

/** Where a workflow's hook deliveries go; the token is the part only a rotation reveals. */
export function workflowHookPath(workflowId: string, token = '{token}'): string {
   return `/api/v1/hooks/workflows/${encodeURIComponent(workflowId)}/${token}`;
}

/** The fields a webhook delivery becomes under `trigger`, in the order the contract lists them. */
export const WEBHOOK_DELIVERY_FIELDS: { field: string; meaning: string }[] = [
   { field: 'trigger.input', meaning: 'the JSON body, or null when the body is empty' },
   { field: 'trigger.query', meaning: 'the query string, first value per parameter' },
   { field: 'trigger.contentType', meaning: 'the Content-Type header' },
   {
      field: 'trigger.deliveryId',
      meaning: 'the X-Berry-Delivery-Id header, which makes a redelivery idempotent',
   },
   { field: 'trigger.receivedAt', meaning: 'when the delivery arrived' },
];

/** A definition may be changed while it is a draft or paused. */
export function isWorkflowEditable(workflow: Pick<Workflow, 'status'>): boolean {
   return workflow.status === 'draft' || workflow.status === 'paused';
}

export function canRunWorkflow(workflow: Pick<Workflow, 'status'>): boolean {
   return workflow.status === 'active';
}

/**
 * Why Activate is disabled, or null when it can be pressed. The server
 * decides for real; this only spares a person a round trip for the reasons
 * the record already shows.
 */
export function activationBlocker(
   workflow: Pick<Workflow, 'status' | 'requiredConnections' | 'validation' | 'risk'>,
   options: { isAdmin?: boolean } = {}
): string | null {
   if (workflow.status === 'active') return 'This workflow is already active.';
   if (workflow.status === 'archived') return 'An archived workflow cannot be activated.';
   const missing = workflow.requiredConnections
      .filter((connection) => !connection.connected)
      .map((connection) => connection.provider);
   if (missing.length > 0) return `Connect ${missing.join(', ')} first.`;
   if (workflow.validation.errors.length > 0) return 'Fix the definition first.';
   if (workflow.risk === 'high' && options.isAdmin === false) {
      return 'An admin has to activate a high-risk workflow.';
   }
   return null;
}

/** The validator's field errors from a refused create or patch, if any. */
export function definitionFieldErrors(error: unknown): FieldError[] {
   if (!(error instanceof BerryApiError)) return [];
   if (error.code !== 'DEFINITION_INVALID' && error.code !== 'VALIDATION_FAILED') return [];
   const details = error.details as { fields?: unknown } | null;
   const parsed = z
      .array(
         z.object({
            path: z.string(),
            code: z.string(),
            message: z.string(),
            severity: z.enum(['error', 'warning']).default('error'),
            hint: z.string().nullish(),
         })
      )
      .safeParse(details?.fields);
   return parsed.success ? parsed.data : [];
}

/** Human wording for a refused workflow call. */
export function describeWorkflowFailure(error: unknown): string {
   if (error instanceof BerryApiError) {
      switch (error.code) {
         case 'DEFINITION_INVALID': {
            const fields = definitionFieldErrors(error);
            return fields.length > 0
               ? `The definition has ${fields.length} problem${fields.length === 1 ? '' : 's'}: ${fields[0].message}`
               : 'The workflow definition is invalid.';
         }
         case 'VALIDATION_FAILED': {
            const fields = definitionFieldErrors(error);
            return fields[0]?.message ?? error.message;
         }
         case 'REVISION_CONFLICT':
            return 'Someone else changed this workflow. Reload it and try again.';
         case 'WORKFLOW_ACTIVE':
            return 'Pause the workflow before changing its definition.';
         case 'WORKFLOW_NOT_ACTIVE':
            return 'Only an active workflow can run. Activate it first.';
         case 'WORKFLOW_ENGINE_DISABLED':
            return 'This deployment has no workflow engine for external flows.';
         case 'WORKFLOWS_DISABLED':
            return 'This deployment does not run workflows.';
         case 'CONNECTIONS_MISSING': {
            const details = error.details as { providers?: string[] } | null;
            const providers = details?.providers?.join(', ');
            return providers
               ? `Connect ${providers} before activating.`
               : 'A connection is missing.';
         }
         case 'FORBIDDEN': {
            const details = error.details as { reason?: string } | null;
            if (details?.reason === 'destructive_actions') {
               return 'An admin has to activate a workflow with destructive actions.';
            }
            return 'You are not allowed to do that to this workflow.';
         }
         case 'NOT_FOUND':
            return 'The workflow could not be found.';
         default:
            return error.message;
      }
   }
   return 'The workflow request failed.';
}

/**
 * Turn a validator path (`/definition/steps/0/title`) into words: which
 * step, which field. Returns the step index so a form can show the message
 * beside the row it belongs to.
 */
export function describeDefinitionPath(path: string): {
   scope: 'trigger' | 'step' | 'entry' | 'definition';
   stepIndex: number | null;
   field: string;
} {
   const segments = path.split('/').filter(Boolean);
   if (segments[0] === 'definition') segments.shift();
   const [head, indexText, ...rest] = segments;
   if (head === 'trigger') {
      return {
         scope: 'trigger',
         stepIndex: null,
         field: [indexText, ...rest].filter(Boolean).join(' › '),
      };
   }
   if (head === 'steps') {
      const index = Number.parseInt(indexText ?? '', 10);
      return {
         scope: 'step',
         stepIndex: Number.isNaN(index) ? null : index,
         field: rest.join(' › '),
      };
   }
   if (head === 'entry') {
      return { scope: 'entry', stepIndex: null, field: '' };
   }
   return { scope: 'definition', stepIndex: null, field: segments.join(' › ') };
}
