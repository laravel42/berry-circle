import { z } from 'zod';
import { BerryApiError, apiFetch } from './api';
import { connectionSchema } from './api-schemas';
import { formatInstant } from './cron';
import { streamWorkflowRunEvents, type EventEnvelope } from './events';
import { formatRunDuration } from './runs';

/**
 * Workflow runs: one execution of a workflow definition, its step attempts,
 * and the ledger stream that narrates it. Runs are read separately from
 * tasks on purpose — a run may create tasks, but it is not one.
 */

export const workflowRunStatusSchema = z.enum([
   'pending',
   'running',
   'waiting',
   'succeeded',
   'failed',
   'cancelled',
]);

export const runFailureSchema = z.object({
   code: z.string(),
   message: z.string(),
});

export const stepRunSchema = z.object({
   id: z.string(),
   stepId: z.string(),
   stepType: z.string(),
   attempt: z.number(),
   status: z.string(),
   input: z.unknown(),
   output: z.unknown(),
   failure: runFailureSchema.nullish(),
   runId: z.string().nullish(),
   issueId: z.string().nullish(),
   approvalId: z.string().nullish(),
   usage: z.unknown(),
   startedAt: z.string().nullish(),
   completedAt: z.string().nullish(),
});

export const workflowRunSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   workflowId: z.string(),
   workflowVersion: z.number(),
   goalId: z.string().nullish(),
   status: workflowRunStatusSchema,
   triggerType: z.string(),
   triggerPayload: z.unknown(),
   currentStepId: z.string().nullish(),
   waitingOn: z.string().nullish(),
   failure: runFailureSchema.nullish(),
   usage: z.object({
      inputTokens: z.number().default(0),
      outputTokens: z.number().default(0),
      costMicros: z.number().nullish(),
   }),
   /** Set on a run a `subworkflow` step started. */
   parentRunId: z.string().nullish(),
   parentStepRunId: z.string().nullish(),
   /** 0 for a run a trigger started; a child run is one deeper than its parent. */
   depth: z.number().default(0),
   createdAt: z.string(),
   startedAt: z.string().nullish(),
   completedAt: z.string().nullish(),
   /** Present on a single read only. */
   steps: z.array(stepRunSchema).optional(),
});

const runConnectionSchema = connectionSchema(workflowRunSchema);

export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;
export type WorkflowRun = z.infer<typeof workflowRunSchema>;
export type WorkflowStepRun = z.infer<typeof stepRunSchema>;

export { streamWorkflowRunEvents };

function parseRun(json: unknown): WorkflowRun {
   const parsed = workflowRunSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Workflow run response was not recognized');
   }
   return parsed.data;
}

async function collectRuns(
   path: string,
   params: URLSearchParams,
   limit: number
): Promise<WorkflowRun[]> {
   const collected: WorkflowRun[] = [];
   let after: string | undefined;
   for (let page = 0; page < 20; page += 1) {
      params.set('first', String(Math.min(limit, 100)));
      if (after) params.set('after', after);
      const json: unknown = await apiFetch(`${path}?${params.toString()}`);
      const parsed = runConnectionSchema.safeParse(json);
      if (!parsed.success) {
         throw new Error('Workflow run list was not recognized');
      }
      collected.push(...parsed.data.nodes);
      const { hasNextPage, endCursor } = parsed.data.pageInfo;
      if (!hasNextPage || !endCursor || parsed.data.nodes.length === 0) break;
      if (collected.length >= limit) break;
      after = endCursor;
   }
   return collected.slice(0, limit);
}

export interface WorkflowRunsQuery {
   status?: WorkflowRunStatus;
   workflowId?: string;
   first?: number;
}

/** Runs of one workflow, newest first, without steps. */
export function listWorkflowRuns(
   workflowId: string,
   query: WorkflowRunsQuery = {}
): Promise<WorkflowRun[]> {
   const params = new URLSearchParams();
   if (query.status) params.set('status', query.status);
   return collectRuns(
      `/api/v1/workflows/${encodeURIComponent(workflowId)}/runs`,
      params,
      query.first ?? 100
   );
}

/** Every run in the workspace, newest first, without steps. */
export function listWorkspaceWorkflowRuns(
   workspaceId: string,
   query: WorkflowRunsQuery = {}
): Promise<WorkflowRun[]> {
   const params = new URLSearchParams({ workspaceId });
   if (query.status) params.set('status', query.status);
   if (query.workflowId) params.set('workflowId', query.workflowId);
   return collectRuns('/api/v1/workflow-runs', params, query.first ?? 200);
}

export async function loadWorkspaceWorkflowRuns(
   workspaceId: string,
   query: WorkflowRunsQuery = {}
): Promise<WorkflowRun[]> {
   if (!workspaceId) return [];
   try {
      return await listWorkspaceWorkflowRuns(workspaceId, query);
   } catch {
      return [];
   }
}

export async function getWorkflowRun(runId: string, signal?: AbortSignal): Promise<WorkflowRun> {
   const json: unknown = await apiFetch(
      `/api/v1/workflow-runs/${encodeURIComponent(runId)}`,
      undefined,
      { signal }
   );
   return parseRun(json);
}

export async function cancelWorkflowRun(runId: string): Promise<WorkflowRun> {
   const json: unknown = await apiFetch(
      `/api/v1/workflow-runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST' }
   );
   return parseRun(json);
}

// ---------------------------------------------------------------------------
// Reading a run

export function isTerminalWorkflowRunStatus(status: string): boolean {
   return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function isTerminalWorkflowRunEvent(type: string): boolean {
   return (
      type === 'workflow.run.succeeded' ||
      type === 'workflow.run.failed' ||
      type === 'workflow.run.cancelled'
   );
}

export function workflowRunDurationMs(
   run: Pick<WorkflowRun, 'startedAt' | 'completedAt'>
): number | null {
   if (!run.startedAt) return null;
   const end = run.completedAt ?? new Date().toISOString();
   return Math.max(0, new Date(end).getTime() - new Date(run.startedAt).getTime());
}

export function describeWorkflowRunDuration(
   run: Pick<WorkflowRun, 'startedAt' | 'completedAt'>
): string | null {
   const ms = workflowRunDurationMs(run);
   if (ms === null) return null;
   if (ms < 1000) return `${ms}ms`;
   return formatRunDuration(ms);
}

export function describeRunStatus(status: string): string {
   switch (status) {
      case 'pending':
         return 'Pending';
      case 'running':
         return 'Running';
      case 'waiting':
         return 'Waiting';
      case 'succeeded':
         return 'Succeeded';
      case 'failed':
         return 'Failed';
      case 'cancelled':
         return 'Cancelled';
      case 'skipped':
         return 'Skipped';
      default:
         return status;
   }
}

export function describeTriggerType(type: string): string {
   switch (type) {
      case 'manual':
         return 'Run by hand';
      case 'berry_event':
         return 'Berry event';
      case 'webhook':
         return 'Webhook';
      case 'schedule':
         return 'Schedule';
      case 'integration':
         return 'Integration';
      default:
         return type;
   }
}

/** Short noun for a step's kind, matching the plan preview's wording. */
export function describeStepType(stepType: string): string {
   switch (stepType) {
      case 'create_issue':
         return 'Create task';
      case 'update_issue':
         return 'Update task';
      case 'agent':
         return 'Ask an agent';
      case 'condition':
         return 'If';
      case 'switch':
         return 'Switch';
      case 'approval':
         return 'Approval';
      case 'wait':
         return 'Wait';
      case 'action':
         return 'Action';
      case 'foreach':
         return 'For each';
      case 'transform':
         return 'Transform';
      case 'subworkflow':
         return 'Run workflow';
      default:
         return stepType;
   }
}

/** What a waiting run is waiting for, in words: `approval:<id>` → "an approval". */
export function describeWaitingOn(waitingOn: string | null | undefined): string | null {
   if (!waitingOn) return null;
   const [kind, rest] = waitingOn.split(':', 2);
   switch (kind) {
      case 'approval':
         return 'waiting for an approval';
      case 'run':
         return 'waiting for a run';
      case 'issue':
         return 'waiting for a task to finish';
      case 'timer':
         return 'waiting for a timer';
      case 'event':
         return rest ? `waiting for ${rest}` : 'waiting for an event';
      default:
         return `waiting on ${waitingOn}`;
   }
}

/** Where the thing a run waits on lives, when it has a page. */
export function waitingOnHref(waitingOn: string | null | undefined, orgId: string): string | null {
   if (!waitingOn) return null;
   const [kind, id] = waitingOn.split(':', 2);
   if (!id) return null;
   switch (kind) {
      case 'approval':
         return `/${orgId}/approvals?approval=${encodeURIComponent(id)}`;
      case 'run':
         return `/${orgId}/runs?run=${encodeURIComponent(id)}`;
      default:
         return null;
   }
}

/** One line of the run ledger, for the transcript. */
export function describeRunEvent(event: EventEnvelope): string {
   const step = event.stepId ? `step ${event.stepId}` : 'step';
   switch (event.type) {
      case 'workflow.run.started':
         return 'run started';
      case 'workflow.run.waiting': {
         const waitingOn = payloadString(event.payload, 'waitingOn');
         return describeWaitingOn(waitingOn) ?? 'run waiting';
      }
      case 'workflow.run.resumed':
         return 'run resumed';
      case 'workflow.run.succeeded':
         return 'run succeeded';
      case 'workflow.run.failed': {
         const message = payloadFailureMessage(event.payload);
         return message ? `run failed: ${message}` : 'run failed';
      }
      case 'workflow.run.cancelled':
         return 'run cancelled';
      case 'workflow.step.started':
         return `${step} started`;
      case 'workflow.step.succeeded':
         return `${step} succeeded`;
      case 'workflow.step.failed': {
         const message = payloadFailureMessage(event.payload);
         return message ? `${step} failed: ${message}` : `${step} failed`;
      }
      case 'workflow.step.skipped':
         return `${step} skipped`;
      case 'workflow.step.waiting': {
         const waitingOn = payloadString(event.payload, 'waitingOn');
         return `${step} ${describeWaitingOn(waitingOn) ?? 'waiting'}`;
      }
      default:
         return event.type;
   }
}

function payloadString(payload: unknown, key: string): string | undefined {
   if (typeof payload !== 'object' || payload === null) return undefined;
   const value = (payload as Record<string, unknown>)[key];
   return typeof value === 'string' ? value : undefined;
}

function payloadFailureMessage(payload: unknown): string | undefined {
   if (typeof payload !== 'object' || payload === null) return undefined;
   const record = payload as Record<string, unknown>;
   for (const key of ['run', 'step']) {
      const entity = record[key];
      if (typeof entity !== 'object' || entity === null) continue;
      const failure = (entity as { failure?: unknown }).failure;
      if (typeof failure === 'object' && failure !== null) {
         const message = (failure as { message?: unknown }).message;
         if (typeof message === 'string') return message;
      }
   }
   return undefined;
}

/** Human wording for a refused run call. */
export function describeWorkflowRunFailure(error: unknown): string {
   if (error instanceof BerryApiError) {
      switch (error.code) {
         case 'RUN_TERMINAL':
            return 'This run has already finished.';
         case 'FORBIDDEN':
            return 'You are not allowed to cancel runs.';
         case 'NOT_FOUND':
            return 'The run could not be found.';
         default:
            return error.message;
      }
   }
   return 'The run request failed.';
}

/** A short handle for a run in crumbs and lists: the first 8 hex characters. */
export function shortRunId(runId: string): string {
   return runId.slice(0, 8);
}

// ---------------------------------------------------------------------------
// What started a run, and what a run started

const STEP_RUN_ID = /^([a-z][a-z0-9_]{0,63})(?:\[([0-9]{1,3})\])?$/;

/** `note[2]` → the body step `note` and iteration 2; a plain id has no index. */
export function splitStepRunId(stepId: string): { base: string; index: number | null } {
   const match = STEP_RUN_ID.exec(stepId);
   if (!match) return { base: stepId, index: null };
   return { base: match[1], index: match[2] === undefined ? null : Number(match[2]) };
}

function recordOf(value: unknown): Record<string, unknown> | null {
   return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
}

function stringAt(value: unknown, key: string): string | null {
   const record = recordOf(value);
   const found = record?.[key];
   return typeof found === 'string' ? found : null;
}

export interface RunParent {
   workflowId: string;
   runId: string;
   stepRunId: string | null;
   stepId: string | null;
}

/** The subworkflow step that started this run, from its trigger payload, or null. */
export function runParent(
   run: Pick<WorkflowRun, 'triggerPayload' | 'parentRunId'>
): RunParent | null {
   const parent = recordOf(recordOf(run.triggerPayload)?.parent);
   const runId = stringAt(parent, 'runId') ?? run.parentRunId ?? null;
   const workflowId = stringAt(parent, 'workflowId');
   if (!runId || !workflowId) return null;
   return {
      workflowId,
      runId,
      stepRunId: stringAt(parent, 'stepRunId'),
      stepId: stringAt(parent, 'stepId'),
   };
}

export interface ChildRunRef {
   runId: string;
   workflowId: string;
}

/** The child run a `subworkflow` step started, from its output, or null. */
export function childRunOf(step: Pick<WorkflowStepRun, 'stepType' | 'output'>): ChildRunRef | null {
   if (step.stepType !== 'subworkflow') return null;
   const runId = stringAt(step.output, 'childRunId');
   const workflowId = stringAt(step.output, 'workflowId');
   return runId && workflowId ? { runId, workflowId } : null;
}

export interface RunTriggerSummary {
   /** The kind, as a short noun: "Schedule", "GitHub", "Run by hand". */
   kind: string;
   /** The instance: the fire instant, the event, the calling step; null when there is none. */
   detail: string | null;
}

/**
 * What started a run, read from its trigger payload: a schedule's instant
 * on its own wall clock, an integration's provider and event, the parent
 * step of a child run. A Berry event's payload is the fact itself, so the
 * caller passes the workflow's event when it knows it.
 */
export function describeRunTrigger(
   run: Pick<WorkflowRun, 'triggerType' | 'triggerPayload'>,
   options: { providerName?: (provider: string) => string | undefined; event?: string | null } = {}
): RunTriggerSummary {
   const payload = recordOf(run.triggerPayload);
   switch (run.triggerType) {
      case 'schedule': {
         const timezone = stringAt(payload, 'timezone');
         const at = stringAt(payload, 'scheduledAt');
         return {
            kind: 'Schedule',
            detail: at ? `${formatInstant(at, timezone)}${timezone ? ` ${timezone}` : ''}` : null,
         };
      }
      case 'integration': {
         const provider = stringAt(payload, 'provider') ?? 'integration';
         return {
            kind: options.providerName?.(provider) ?? provider,
            detail: stringAt(payload, 'event'),
         };
      }
      case 'manual': {
         const parent = recordOf(payload?.parent);
         if (parent) {
            const stepId = stringAt(parent, 'stepId');
            return { kind: 'Child run', detail: stepId ? `from step ${stepId}` : null };
         }
         return { kind: 'Run by hand', detail: null };
      }
      case 'webhook':
         return { kind: 'Webhook', detail: stringAt(payload, 'deliveryId') };
      case 'berry_event':
         return { kind: 'Berry event', detail: options.event ?? null };
      default:
         return { kind: describeTriggerType(run.triggerType), detail: null };
   }
}
