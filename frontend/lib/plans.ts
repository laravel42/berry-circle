import { z } from 'zod';
import { BerryApiError, apiFetch } from './api';
import { newIdempotencyKey } from './api-schemas';

/**
 * Generated plans: the BerryPlan v1 IR the planner emits, the record that
 * wraps it, and the calls that move a plan from prompt to Start Plan.
 *
 * The IR is read-only here. Every array the server omits when empty
 * (`omitempty` on the Go side) defaults to `[]`, so components can map over
 * a plan without a null check per field.
 */

export const planStatusSchema = z.enum([
   'draft',
   'pendingApproval',
   'approved',
   'rejected',
   'superseded',
]);
export const generationStatusSchema = z.enum(['idle', 'running', 'succeeded', 'failed']);
export const validationStatusSchema = z.enum(['unknown', 'valid', 'invalid', 'blocked']);
export const planRiskSchema = z.enum(['low', 'medium', 'high']);

/** Pipeline stages in the order the planner runs them. */
export const PLAN_STAGES = [
   'intent',
   'context',
   'generate',
   'validate',
   'repair',
   'critic',
   'finalize',
] as const;
export type PlanStage = (typeof PLAN_STAGES)[number];

export const fieldErrorSchema = z.object({
   path: z.string(),
   code: z.string(),
   message: z.string(),
   severity: z.enum(['error', 'warning']),
   hint: z.string().nullish(),
});

export const requiredConnectionSchema = z.object({
   provider: z.string(),
   purpose: z.string(),
   connected: z.boolean(),
});

export const intentAmbiguitySchema = z.object({
   id: z.string(),
   question: z.string(),
   blocking: z.boolean(),
});

export const validationReportSchema = z.object({
   status: validationStatusSchema,
   errors: z.array(fieldErrorSchema).default([]),
   warnings: z.array(fieldErrorSchema).default([]),
   requiredConnections: z.array(requiredConnectionSchema).default([]),
   ambiguities: z.array(intentAmbiguitySchema).default([]),
   risk: planRiskSchema,
   needsAdminActivation: z.boolean(),
});

export const criticSchema = z.object({
   verdict: z.enum(['accept', 'revise']),
   problems: z
      .array(
         z.object({
            code: z.string(),
            path: z.string(),
            message: z.string(),
            severity: z.enum(['error', 'warning']),
         })
      )
      .default([]),
});

export const compileReportSchema = z.object({
   status: z.enum(['running', 'succeeded', 'failed']),
   error: z.string().nullish(),
   compiledAt: z.string().nullish(),
   goalId: z.string().nullish(),
   issueIds: z.array(z.string()).default([]),
   workflowIds: z.array(z.string()).default([]),
   approvalIds: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// BerryPlan v1

const planGoalSchema = z.object({
   tempId: z.string(),
   title: z.string(),
   description: z.string().nullish(),
   projectId: z.string().nullish(),
});

export const planAssumptionSchema = z.object({
   id: z.string(),
   description: z.string(),
   confidence: z.enum(['low', 'medium', 'high']),
   userEditable: z.boolean().default(false),
   blocking: z.boolean().default(false),
});

export const planIssueSchema = z.object({
   tempId: z.string(),
   title: z.string(),
   description: z.string().nullish(),
   type: z.string().default('issue'),
   suggestedAgentId: z.string().nullish(),
   requiredCapabilities: z.array(z.string()).default([]),
   priority: z.string().nullish(),
   dependsOn: z.array(z.string()).default([]),
   requiresReview: z.boolean().default(false),
   requiresApproval: z.boolean().default(false),
   expectedArtifacts: z.array(z.string()).default([]),
   estimate: z.string().nullish(),
});

export const planTriggerSchema = z.object({
   id: z.string(),
   type: z.enum(['integration', 'schedule', 'manual', 'berry_event', 'webhook']),
   provider: z.string().nullish(),
   operation: z.string().nullish(),
   event: z.string().nullish(),
   config: z
      .object({
         cron: z.string().nullish(),
         timezone: z.string().nullish(),
         filter: z.unknown().nullish(),
      })
      .nullish(),
});

const approverSchema = z.object({
   type: z.string(),
   userId: z.string().nullish(),
   role: z.string().nullish(),
});

// The wire step is flat: the header fields sit beside the type's own fields.
const stepHeader = {
   id: z.string(),
   dependsOn: z.array(z.string()).default([]),
   onError: z.enum(['fail', 'skip']).nullish(),
};

const knownStepSchema = z.discriminatedUnion('type', [
   z.object({
      ...stepHeader,
      type: z.literal('action'),
      provider: z.string(),
      operation: z.string(),
      input: z.record(z.unknown()).default({}),
   }),
   z.object({
      ...stepHeader,
      type: z.literal('condition'),
      expression: z.unknown(),
      trueSteps: z.array(z.string()).default([]),
      falseSteps: z.array(z.string()).default([]),
   }),
   z.object({
      ...stepHeader,
      type: z.literal('switch'),
      value: z.unknown(),
      cases: z
         .array(z.object({ equals: z.unknown(), steps: z.array(z.string()).default([]) }))
         .default([]),
      defaultSteps: z.array(z.string()).default([]),
   }),
   z.object({
      ...stepHeader,
      type: z.literal('agent'),
      agentId: z.string().nullish(),
      requiredCapabilities: z.array(z.string()).default([]),
      instruction: z.string(),
      input: z.record(z.unknown()).nullish(),
      outputSchema: z.unknown().nullish(),
      issueMode: z.enum(['inline', 'issue']).nullish(),
   }),
   z.object({
      ...stepHeader,
      type: z.literal('create_issue'),
      title: z.string(),
      description: z.string().nullish(),
      assignAgentId: z.string().nullish(),
      priority: z.string().nullish(),
      goalId: z.string().nullish(),
      boardId: z.string().nullish(),
      waitForCompletion: z.boolean().default(false),
   }),
   z.object({
      ...stepHeader,
      type: z.literal('update_issue'),
      issue: z.unknown(),
      patch: z
         .object({
            status: z.string().nullish(),
            priority: z.string().nullish(),
            assignAgentId: z.string().nullish(),
            title: z.string().nullish(),
            description: z.string().nullish(),
         })
         .default({}),
   }),
   z.object({
      ...stepHeader,
      type: z.literal('approval'),
      title: z.string(),
      description: z.string().nullish(),
      approver: approverSchema,
      timeout: z.string().nullish(),
   }),
   z.object({
      ...stepHeader,
      type: z.literal('wait'),
      mode: z.enum(['duration', 'until', 'event']),
      duration: z.string().nullish(),
      until: z.string().nullish(),
      event: z
         .object({ provider: z.string(), event: z.string(), filter: z.unknown().nullish() })
         .nullish(),
   }),
   z.object({
      ...stepHeader,
      type: z.literal('foreach'),
      items: z.unknown(),
      steps: z.array(z.string()).default([]),
      maxItems: z.number().nullish(),
   }),
   z.object({
      ...stepHeader,
      type: z.literal('transform'),
      output: z.record(z.unknown()).default({}),
   }),
   z.object({
      ...stepHeader,
      type: z.literal('subworkflow'),
      workflowId: z.string(),
      input: z.record(z.unknown()).nullish(),
   }),
]);

/**
 * A step whose type this build does not know, or a known type missing a
 * required field. The validator reports the latter as an error beside it;
 * the preview still has to draw the row rather than drop the whole plan.
 */
const unknownStepSchema = z
   .object({ id: z.string(), type: z.string(), dependsOn: z.array(z.string()).default([]) })
   .passthrough()
   .transform((step) => ({
      id: step.id,
      type: 'unknown' as const,
      rawType: step.type,
      dependsOn: step.dependsOn,
   }));

export const planStepSchema = z.union([knownStepSchema, unknownStepSchema]);

export const planWorkflowSchema = z.object({
   tempId: z.string(),
   name: z.string(),
   description: z.string().nullish(),
   trigger: planTriggerSchema,
   steps: z.array(planStepSchema).default([]),
   entry: z.array(z.string()).default([]),
   activateOnApprove: z.boolean().default(false),
});

export const planApprovalSchema = z.object({
   tempId: z.string(),
   title: z.string(),
   description: z.string().nullish(),
   reason: z.string(),
   target: z.object({
      kind: z.string(),
      tempId: z.string(),
      stepId: z.string().nullish(),
   }),
   approver: approverSchema,
   timeout: z.string().nullish(),
});

export const planDependencySchema = z.object({
   from: z.string(),
   to: z.string(),
   kind: z.string(),
});

export const planSchema = z.object({
   $schema: z.string().optional(),
   version: z.string().optional(),
   goal: planGoalSchema,
   assumptions: z.array(planAssumptionSchema).default([]),
   requiredConnections: z.array(requiredConnectionSchema).default([]),
   issues: z.array(planIssueSchema).default([]),
   workflows: z.array(planWorkflowSchema).default([]),
   approvals: z.array(planApprovalSchema).default([]),
   dependencies: z.array(planDependencySchema).default([]),
   confidence: z.number().optional(),
   compiled: z
      .object({
         goalId: z.string(),
         issueIds: z.record(z.string()).default({}),
         workflowIds: z.record(z.string()).default({}),
         approvalIds: z.record(z.string()).default({}),
         compiledAt: z.string(),
      })
      .nullish(),
});

export const planRecordSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   goalId: z.string().nullish(),
   projectId: z.string().nullish(),
   status: planStatusSchema,
   source: z.string(),
   sourcePrompt: z.string().nullish(),
   irVersion: z.string().nullish(),
   version: z.number(),
   plannerVersion: z.string().nullish(),
   confidence: z.number().nullish(),
   generation: z.object({
      status: generationStatusSchema,
      error: z.string().nullish(),
      stage: z.string().nullish(),
   }),
   validation: validationReportSchema,
   // The critic's verdict is informational: a shape this build does not
   // recognise must not take the whole record down with it.
   critic: criticSchema.nullish().catch(null),
   compile: compileReportSchema.nullish(),
   plan: planSchema.nullish(),
   createdAt: z.string(),
   updatedAt: z.string(),
});

export const planEventSchema = z.object({
   id: z.string(),
   sequence: z.number(),
   stage: z.string(),
   role: z.string().nullish(),
   promptVersion: z.string().nullish(),
   modelProvider: z.string().nullish(),
   modelName: z.string().nullish(),
   inputTokens: z.number().nullish(),
   outputTokens: z.number().nullish(),
   costMicros: z.number().nullish(),
   durationMs: z.number().nullish(),
   outcome: z.string(),
   detail: z.unknown(),
   occurredAt: z.string(),
});

export type PlanStatus = z.infer<typeof planStatusSchema>;
export type PlanRisk = z.infer<typeof planRiskSchema>;
export type FieldError = z.infer<typeof fieldErrorSchema>;
export type RequiredConnection = z.infer<typeof requiredConnectionSchema>;
export type IntentAmbiguity = z.infer<typeof intentAmbiguitySchema>;
export type ValidationReport = z.infer<typeof validationReportSchema>;
export type CompileReport = z.infer<typeof compileReportSchema>;
export type Plan = z.infer<typeof planSchema>;
export type PlanAssumption = z.infer<typeof planAssumptionSchema>;
export type PlanIssue = z.infer<typeof planIssueSchema>;
export type PlanWorkflow = z.infer<typeof planWorkflowSchema>;
export type PlanTrigger = z.infer<typeof planTriggerSchema>;
export type PlanStep = z.infer<typeof planStepSchema>;
export type PlanApproval = z.infer<typeof planApprovalSchema>;
export type PlanRecord = z.infer<typeof planRecordSchema>;
export type PlanEvent = z.infer<typeof planEventSchema>;

// ---------------------------------------------------------------------------
// Calls

function parseRecord(json: unknown): PlanRecord {
   const parsed = planRecordSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Plan response was not recognized');
   }
   return parsed.data;
}

export interface GeneratePlanInput {
   workspaceId: string;
   prompt: string;
   goalId?: string;
   projectId?: string;
   boardId?: string;
   hint?: 'issue' | 'workflow' | 'auto';
}

/**
 * Ask the planner for a plan. Resolves as soon as the record exists, with
 * `generation.status` still `running`; the caller follows it with `getPlan`.
 * Throws the server's `BerryApiError` (`PLAN_FORBIDDEN`, `PLANNER_UNAVAILABLE`,
 * `PLAN_OPEN_EXISTS`, `BOARD_REQUIRED`) so the dialog can say why.
 */
export async function generatePlan(input: GeneratePlanInput): Promise<PlanRecord> {
   const body: Record<string, string> = {
      workspaceId: input.workspaceId,
      prompt: input.prompt,
   };
   if (input.goalId) body.goalId = input.goalId;
   if (input.projectId) body.projectId = input.projectId;
   if (input.boardId) body.boardId = input.boardId;
   if (input.hint) body.hint = input.hint;

   const json: unknown = await apiFetch('/api/v1/plans/generate', {
      method: 'POST',
      headers: { 'Idempotency-Key': newIdempotencyKey() },
      body: JSON.stringify(body),
   });
   return parseRecord(json);
}

export async function getPlan(planId: string, signal?: AbortSignal): Promise<PlanRecord> {
   const json: unknown = await apiFetch(`/api/v1/plans/${encodeURIComponent(planId)}`, undefined, {
      signal,
   });
   return parseRecord(json);
}

/** Re-run the deterministic checks on the stored IR. */
export async function validatePlan(planId: string): Promise<PlanRecord> {
   const json: unknown = await apiFetch(`/api/v1/plans/${encodeURIComponent(planId)}/validate`, {
      method: 'POST',
   });
   return parseRecord(json);
}

/**
 * Start Plan. A member approving a high-risk plan gets the record back in
 * `pendingApproval` rather than compiled; the caller reads `status` to tell.
 * Throws `PLAN_INVALID`, `PLAN_BUSY`, `PLAN_NOT_OPEN`, `PLAN_COMPILE_FAILED`.
 */
export async function approvePlan(planId: string, note?: string): Promise<PlanRecord> {
   const json: unknown = await apiFetch(`/api/v1/plans/${encodeURIComponent(planId)}/approve`, {
      method: 'POST',
      headers: { 'Idempotency-Key': newIdempotencyKey() },
      body: JSON.stringify(note ? { note } : {}),
   });
   return parseRecord(json);
}

/** Retry a compile that failed after approval. */
export async function compilePlan(planId: string): Promise<PlanRecord> {
   const json: unknown = await apiFetch(`/api/v1/plans/${encodeURIComponent(planId)}/compile`, {
      method: 'POST',
      headers: { 'Idempotency-Key': newIdempotencyKey() },
      body: '{}',
   });
   return parseRecord(json);
}

/** Close an open plan; a draft goal it created with no issues is archived. */
export async function rejectPlan(planId: string, note?: string): Promise<PlanRecord> {
   const json: unknown = await apiFetch(`/api/v1/plans/${encodeURIComponent(planId)}/reject`, {
      method: 'POST',
      body: JSON.stringify(note ? { note } : {}),
   });
   return parseRecord(json);
}

/** Pipeline stage records: counts, codes and ids, never prompt text. */
export async function listPlanEvents(planId: string): Promise<PlanEvent[]> {
   const json: unknown = await apiFetch(`/api/v1/plans/${encodeURIComponent(planId)}/events`);
   const parsed = z.object({ nodes: z.array(planEventSchema) }).safeParse(json);
   if (!parsed.success) return [];
   return parsed.data.nodes;
}

// ---------------------------------------------------------------------------
// Reading a record

export function isPlanGenerating(record: PlanRecord): boolean {
   return record.generation.status === 'running';
}

export function isPlanCompiling(record: PlanRecord): boolean {
   return record.compile?.status === 'running';
}

export function isPlanOpen(record: PlanRecord): boolean {
   return record.status === 'draft' || record.status === 'pendingApproval';
}

/** Why Start Plan is disabled, or null when it can be pressed. */
export function startPlanBlocker(record: PlanRecord): string | null {
   if (record.status === 'pendingApproval') return 'An admin has to approve this plan first.';
   if (record.status === 'approved') return 'This plan has already started.';
   if (!isPlanOpen(record)) return 'This plan is no longer open.';
   if (isPlanGenerating(record)) return 'Berry is still planning.';
   if (record.generation.status === 'failed' && !record.plan) return 'Planning failed.';
   if (record.validation.status === 'blocked') {
      return 'Berry needs answers to its questions before this plan can start.';
   }
   if (record.validation.status === 'invalid' || record.validation.errors.length > 0) {
      return 'Fix the problems below before starting the plan.';
   }
   if (!record.plan) return 'There is no plan to start yet.';
   return null;
}

export interface PlanCounts {
   tasks: number;
   workflows: number;
   approvals: number;
}

/**
 * What the plan would create. Approvals count both explicit entries and the
 * tasks and steps that ask for one, since those become approvals at compile.
 */
export function planCounts(plan: Plan | null | undefined): PlanCounts {
   if (!plan) return { tasks: 0, workflows: 0, approvals: 0 };
   const explicit = new Set(plan.approvals.map((approval) => approval.tempId));
   let approvals = explicit.size;
   for (const issue of plan.issues) {
      if (issue.requiresApproval && !plan.approvals.some((a) => a.target.tempId === issue.tempId)) {
         approvals += 1;
      }
   }
   for (const workflow of plan.workflows) {
      for (const step of workflow.steps) {
         if (step.type === 'approval') approvals += 1;
      }
   }
   return { tasks: plan.issues.length, workflows: plan.workflows.length, approvals };
}

export function describePlanCounts(counts: PlanCounts): string {
   const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
   return [
      plural(counts.tasks, 'task'),
      plural(counts.workflows, 'workflow'),
      plural(counts.approvals, 'approval'),
   ].join(' · ');
}

/** Progress copy for the stage in flight, lowercase like the rest of the shell. */
export function describePlanStage(stage: string | null | undefined): string {
   switch (stage) {
      case 'intent':
         return 'reading your request…';
      case 'context':
         return 'gathering workspace context…';
      case 'generate':
         return 'planning…';
      case 'validate':
         return 'validating…';
      case 'repair':
         return 'repairing…';
      case 'critic':
         return 'reviewing…';
      case 'finalize':
         return 'finishing…';
      default:
         return 'planning…';
   }
}

export function describePlanStatus(status: PlanStatus): string {
   switch (status) {
      case 'draft':
         return 'Draft';
      case 'pendingApproval':
         return 'Waiting for admin approval';
      case 'approved':
         return 'Started';
      case 'rejected':
         return 'Rejected';
      case 'superseded':
         return 'Superseded';
   }
}

/**
 * Human wording for a generation error. The server stores codes such as
 * `timeout at generate` or `ROLE_RATE_LIMITED at planner`; the person needs
 * to know whether to try again or to ask an admin.
 */
export function describeGenerationError(error: string | null | undefined): string {
   if (!error) return 'Planning failed.';
   const [code, , stage] = error.split(' ');
   const where = stage ? ` while ${describePlanStage(stage).replace(/…$/, '')}` : '';
   switch (code) {
      case 'PLAN_INVALID':
         return 'Berry could not produce a plan that passes validation.';
      case 'shutdown':
         return 'The server restarted mid-planning.';
      case 'timeout':
         return `Planning timed out${where}.`;
      case 'ROLE_RATE_LIMITED':
         return `The model was rate limited${where}; try again in a few minutes.`;
      case 'PLANNER_UNAVAILABLE':
         return 'The planner is not available on this deployment.';
      case 'REQUEST_TOO_LARGE':
         return 'The request was too large for the planner; try a shorter prompt.';
      case 'INTENT_INVALID':
         return 'Berry could not make sense of the request; try rephrasing it.';
      default:
         return `Planning failed${where}: ${error}`;
   }
}

/** Human wording for a refused plan call. */
export function describePlanFailure(error: unknown): string {
   if (error instanceof BerryApiError) {
      switch (error.code) {
         case 'PLAN_FORBIDDEN':
            return 'Viewers cannot plan work in this workspace.';
         case 'PLANNER_UNAVAILABLE':
            return 'The planner is not available on this deployment.';
         case 'PLAN_OPEN_EXISTS':
            return 'This goal already has an open plan. Reject it first.';
         case 'BOARD_REQUIRED':
            return 'The workspace has no board to plan onto.';
         case 'PLAN_BUSY':
            return 'The plan is still being worked on. Try again in a moment.';
         case 'PLAN_INVALID':
            return 'The plan has problems that must be fixed before it can start.';
         case 'PLAN_NOT_OPEN':
            return 'This plan is no longer open.';
         case 'PLAN_COMPILE_FAILED': {
            const details = error.details as { message?: string } | null;
            return details?.message
               ? `Starting the plan failed: ${details.message}`
               : 'Starting the plan failed. You can retry.';
         }
         default:
            return error.message;
      }
   }
   return 'The plan request failed.';
}

/**
 * Turn a validator path (`/workflows/0/steps/0/provider`) into words a person
 * can find on the page. Falls back to the raw pointer for anything unknown.
 */
export function describePlanPath(path: string, plan: Plan | null | undefined): string {
   if (!path) return 'Plan';
   const segments = path.split('/').filter(Boolean);
   if (segments.length === 0) return 'Plan';
   const [collection, indexText, ...rest] = segments;
   const index = Number.parseInt(indexText ?? '', 10);
   const tail = rest.length > 0 ? ` › ${rest.join(' › ')}` : '';
   if (collection === 'goal')
      return `Goal${indexText ? ` › ${segments.slice(1).join(' › ')}` : ''}`;
   if (!plan || Number.isNaN(index)) return path;
   switch (collection) {
      case 'issues': {
         const issue = plan.issues[index];
         return issue ? `Task "${issue.title}"${tail}` : path;
      }
      case 'workflows': {
         const workflow = plan.workflows[index];
         if (!workflow) return path;
         if (rest[0] === 'steps') {
            const step = workflow.steps[Number.parseInt(rest[1] ?? '', 10)];
            const after = rest.slice(2);
            return `Workflow "${workflow.name}" › step ${step?.id ?? rest[1]}${
               after.length > 0 ? ` › ${after.join(' › ')}` : ''
            }`;
         }
         return `Workflow "${workflow.name}"${tail}`;
      }
      case 'approvals': {
         const approval = plan.approvals[index];
         return approval ? `Approval "${approval.title}"${tail}` : path;
      }
      case 'assumptions': {
         const assumption = plan.assumptions[index];
         return assumption ? `Assumption ${assumption.id}${tail}` : path;
      }
      default:
         return path;
   }
}

const BERRY_EVENT_LABELS: Record<string, string> = {
   'issue.created': 'a task is created',
   'issue.updated': 'a task changes',
   'issue.assigned': 'a task is assigned',
   'issue.started': 'a task is started',
   'issue.completed': 'a task is completed',
   'issue.deleted': 'a task is deleted',
   'comment.created': 'a comment is posted',
   'goal.completed': 'a goal is completed',
   'approval.approved': 'an approval is granted',
   'approval.rejected': 'an approval is rejected',
   'agent.completed': 'an agent finishes a run',
   'agent.failed': 'an agent run fails',
};

/** "When a task is completed", "Stripe · payment_succeeded", "Every … (cron)". */
export function describePlanTrigger(trigger: PlanTrigger): string {
   switch (trigger.type) {
      case 'berry_event': {
         const event = trigger.event ?? '';
         return `When ${BERRY_EVENT_LABELS[event] ?? event}`;
      }
      case 'schedule': {
         const cron = trigger.config?.cron;
         const timezone = trigger.config?.timezone;
         return `On a schedule${cron ? ` · ${cron}` : ''}${timezone ? ` ${timezone}` : ''}`;
      }
      case 'integration': {
         const what = trigger.operation ?? trigger.event ?? '';
         return `${trigger.provider ?? 'integration'}${what ? ` · ${what}` : ''}`;
      }
      case 'manual':
         return 'Run manually';
      case 'webhook':
         return 'When a webhook arrives';
   }
}

export interface PlanStepSummary {
   /** Short noun for the row's kind. */
   label: string;
   /** What the step does, one line. */
   text: string;
   /** True when the step reaches outside Berry. */
   external: boolean;
   /** True when a person has to decide before the run continues. */
   approval: boolean;
}

function templateText(value: unknown): string {
   if (typeof value === 'string') return value;
   if (typeof value === 'object' && value !== null && 'ref' in value) {
      const ref = (value as { ref?: unknown }).ref;
      return typeof ref === 'string' ? `{{${ref}}}` : '';
   }
   if (value === null || value === undefined) return '';
   return String(value);
}

export function describePlanStep(step: PlanStep): PlanStepSummary {
   switch (step.type) {
      case 'action': {
         const inputs = Object.entries(step.input)
            .map(([key, value]) => `${key}: ${templateText(value)}`)
            .filter((entry) => !entry.endsWith(': '));
         return {
            label: `${step.provider} · ${step.operation}`,
            text: inputs.join(' · '),
            external: step.provider !== 'berry',
            approval: false,
         };
      }
      case 'condition':
         return {
            label: 'If',
            text: `true → ${step.trueSteps.join(', ') || '—'}${
               step.falseSteps.length > 0 ? ` · false → ${step.falseSteps.join(', ')}` : ''
            }`,
            external: false,
            approval: false,
         };
      case 'switch':
         return {
            label: 'Switch',
            text: `${step.cases.length} case${step.cases.length === 1 ? '' : 's'}${
               step.defaultSteps.length > 0 ? ` · default → ${step.defaultSteps.join(', ')}` : ''
            }`,
            external: false,
            approval: false,
         };
      case 'agent':
         return {
            label: step.issueMode === 'issue' ? 'Agent task' : 'Ask an agent',
            text: step.instruction,
            external: false,
            approval: false,
         };
      case 'create_issue':
         return { label: 'Create task', text: step.title, external: false, approval: false };
      case 'update_issue': {
         const fields = Object.entries(step.patch)
            .filter(([, value]) => value !== null && value !== undefined)
            .map(([key, value]) => `${key} → ${String(value)}`);
         return {
            label: 'Update task',
            text: `${templateText(step.issue)}${fields.length > 0 ? ` · ${fields.join(', ')}` : ''}`,
            external: false,
            approval: false,
         };
      }
      case 'approval':
         return {
            label: 'Approval',
            text: `${step.title} · ${describeApprover(step.approver)}`,
            external: false,
            approval: true,
         };
      case 'wait':
         return {
            label: 'Wait',
            text:
               step.mode === 'duration'
                  ? `for ${step.duration ?? '…'}`
                  : step.mode === 'until'
                    ? `until ${step.until ?? '…'}`
                    : `for ${step.event ? `${step.event.provider} · ${step.event.event}` : 'an event'}`,
            external: false,
            approval: false,
         };
      case 'foreach':
         return {
            label: 'For each',
            text: `${templateText(step.items)} → ${step.steps.join(', ')}`,
            external: false,
            approval: false,
         };
      case 'transform':
         return {
            label: 'Transform',
            text: Object.keys(step.output).join(', '),
            external: false,
            approval: false,
         };
      case 'subworkflow':
         return {
            label: 'Run workflow',
            text: step.workflowId,
            external: false,
            approval: false,
         };
      case 'unknown':
         return { label: step.rawType, text: '', external: false, approval: false };
   }
}

export function describeApprover(approver: {
   type: string;
   userId?: string | null;
   role?: string | null;
}): string {
   if (approver.type === 'role') return `any ${approver.role ?? 'member'}`;
   return approver.userId ? `user ${approver.userId}` : 'a person';
}

/**
 * Steps in a sensible reading order: entry steps first, then whatever they
 * branch or depend into, then anything left in declaration order. A step is
 * listed once, however many paths reach it.
 */
export function orderPlanSteps(workflow: PlanWorkflow): PlanStep[] {
   const byId = new Map(workflow.steps.map((step) => [step.id, step]));
   const seen = new Set<string>();
   const ordered: PlanStep[] = [];
   const visit = (id: string) => {
      const step = byId.get(id);
      if (!step || seen.has(id)) return;
      seen.add(id);
      ordered.push(step);
      for (const next of successors(step)) visit(next);
   };
   for (const id of workflow.entry) visit(id);
   for (const step of workflow.steps) {
      if (step.dependsOn.length === 0) visit(step.id);
   }
   for (const step of workflow.steps) visit(step.id);
   return ordered;
}

function successors(step: PlanStep): string[] {
   switch (step.type) {
      case 'condition':
         return [...step.trueSteps, ...step.falseSteps];
      case 'switch':
         return [...step.cases.flatMap((entry) => entry.steps), ...step.defaultSteps];
      case 'foreach':
         return step.steps;
      default:
         return [];
   }
}
