import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { assertValid, decodeBody, fieldError } from '../http/body.ts';
import { ApiError } from '../http/errors.ts';
import { idempotent } from '../http/idempotent.ts';
import type { IdempotencyStore } from '../http/idempotency.ts';
import type { Mount } from '../http/registry.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import type { BoardRepository } from '../core/boards.ts';
import type { Sql } from '../db/pool.ts';
import type { Logger } from '../observability/log.ts';
import { PlannerUnavailable, type PlanGenerator } from '../plans/generator.ts';
import {
   resolveAnswers,
   unansweredBlockers,
   UnansweredQuestion,
   UnknownQuestion,
   type PlanAnswerRepository,
   type SubmittedAnswer,
} from '../plans/answers.ts';
import { TriageUnavailable, type PlanTriage } from '../plans/triage.ts';
import type { RunRepository } from '../runs/repository.ts';
import {
   OpenPlanExists,
   PlanBusy,
   PlanInvalid,
   PlanNotOpen,
   type PlanRecord,
   type PlanRepository,
} from '../plans/repository.ts';
import { pathId } from './shared.ts';

/**
 * `/api/v1/plans`.
 *
 * A plan is a proposal: Berry reads a sentence, says what it would create, and
 * creates none of it until a person presses Start Plan. That gap is the point
 * — it is where someone can disagree before anything exists on a board.
 *
 * Generation is asynchronous by construction, not by convenience: the row is
 * written first, so `POST /generate` answers with an id and a caller polls or
 * follows the stream. A request that held a connection open for a minute would
 * lose the plan when the connection dropped.
 */

const MAX_PROMPT = 20_000;
const MAX_NOTE = 2_000;
const MAX_ANSWERS = 20;

export interface PlanOptions {
   sessions: SessionService;
   plans: PlanRepository;
   generator: PlanGenerator | null;
   /** Absent without a model credential: nothing routes, and tasks stay unowned. */
   triage: PlanTriage | null;
   /** How a routed task becomes a run. Absent means assign but never start. */
   runs: RunRepository | null;
   /** What a person answered when the planner asked. */
   answers: PlanAnswerRepository;
   boards: BoardRepository;
   idempotency: IdempotencyStore;
   sql: Sql;
   logger: Logger;
}

export function planMounts(options: PlanOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));
   const { plans } = options;

   /**
    * The provisioned model roles.
    *
    * Answered honestly: this build runs one of them. The others are listed
    * with what an operator configured, because that is what the table says and
    * a settings page showing nothing would read as "not configured".
    */
   route.get('/roles', async (context) => {
      const user = context.get('user');
      if (!user.currentWorkspaceId) throw ApiError.notFound('Workspace');
      await authorizeWorkspace(context, options, user.currentWorkspaceId, 'settings.write');

      const rows = await options.sql`
         SELECT role, model_provider, model_name, prompt_version, status, max_tokens,
                max_llm_tokens_per_hour, last_synced_at
           FROM model_role_agents ORDER BY role ASC`;
      return json({
         enabled: options.generator !== null,
         roles: rows.map((row) => ({
            role: row.role as string,
            provider: row.model_provider as string,
            model: row.model_name as string,
            promptVersion: row.prompt_version as string,
            status: row.status as string,
            maxTokens: row.max_tokens === null ? null : Number(row.max_tokens),
            maxLLMTokensPerHour:
               row.max_llm_tokens_per_hour === null ? null : Number(row.max_llm_tokens_per_hour),
            lastSyncedAt: row.last_synced_at ?? null,
         })),
      });
   });

   route.post('/generate', idempotent(options.idempotency), async (context) => {
      const { value: body } = await decodeBody<{
         workspaceId?: string;
         prompt?: string;
         goalId?: string;
         projectId?: string;
         boardId?: string;
         hint?: string;
         autoGate?: boolean;
      }>(context, {
         workspaceId: 'string',
         prompt: 'string',
         goalId: 'string',
         projectId: 'string',
         boardId: 'string',
         hint: 'string',
         // Sent by the create-project dialog. Refusing it as an unknown field
         // was how "create a project" failed at the planning step.
         autoGate: 'boolean',
      });

      const problems = [];
      if (!body.workspaceId) {
         problems.push(fieldError('/workspaceId', 'required', 'workspaceId is required.'));
      }
      const prompt = (body.prompt ?? '').trim();
      if (prompt === '') problems.push(fieldError('/prompt', 'required', 'prompt is required.'));
      if (prompt.length > MAX_PROMPT) {
         problems.push(fieldError('/prompt', 'too_long', `prompt is at most ${MAX_PROMPT} characters.`));
      }
      if (body.hint !== undefined && body.hint !== 'issue' && body.hint !== 'auto') {
         problems.push(fieldError('/hint', 'invalid_value', 'hint is issue or auto.'));
      }
      if (problems.length > 0) assertValid(problems);

      await authorizeWorkspace(context, options, body.workspaceId!, 'product.write');
      if (!options.generator) {
         throw new ApiError(
            412,
            'PLANNER_UNAVAILABLE',
            'This deployment has no model credential, so it cannot plan.'
         );
      }

      // The oldest board, when none was named: a plan has to land somewhere,
      // and the workspace's first board is the one a person means.
      const boardId = body.boardId ?? (await oldestBoard(options.sql, body.workspaceId!));
      if (!boardId) {
         throw new ApiError(409, 'BOARD_REQUIRED', 'This workspace has no board to plan into.');
      }

      let record: PlanRecord;
      try {
         record = await plans.open({
            workspaceId: body.workspaceId!,
            goalId: body.goalId ?? null,
            projectId: body.projectId ?? null,
            boardId,
            prompt,
            createdBy: context.get('user').id,
            ...(body.autoGate === undefined ? {} : { autoGate: body.autoGate }),
         });
      } catch (error) {
         if (error instanceof OpenPlanExists) {
            throw new ApiError(409, 'PLAN_OPEN_EXISTS', 'This goal already has an open plan.', {
               planId: error.planId,
            });
         }
         // A project in another workspace, or one that is gone.
         if (error instanceof NotFound) throw ApiError.notFound('Project');
         throw error;
      }

      // Deliberately not awaited. The row is durable and the caller has its
      // id; holding the request open for a model call would lose the plan the
      // moment the connection dropped.
      void generate(options, record, prompt, context.get('user').id);

      const response = json(serializePlan(record), 202);
      response.headers.set('Location', `/api/v1/plans/${record.id}`);
      return response;
   });

   route.get('/:planId', async (context) => {
      const record = await load(context.req.param('planId'));
      await authorizeWorkspace(context, options, record.workspaceId, 'product.read');
      return json(serializePlan(record));
   });

   route.get('/:planId/versions', async (context) => {
      const record = await load(context.req.param('planId'));
      await authorizeWorkspace(context, options, record.workspaceId, 'product.read');
      return json({ nodes: await plans.versions(record.id) });
   });

   route.get('/:planId/events', async (context) => {
      const record = await load(context.req.param('planId'));
      await authorizeWorkspace(context, options, record.workspaceId, 'product.read');
      return json({ nodes: await plans.events(record.id) });
   });

   route.post('/:planId/validate', async (context) => {
      const record = await load(context.req.param('planId'));
      await authorizeWorkspace(context, options, record.workspaceId, 'product.write');
      try {
         return json(serializePlan(await plans.revalidate(record.id)));
      } catch (error) {
         if (error instanceof PlanBusy) {
            throw new ApiError(409, 'PLAN_BUSY', 'This plan has nothing to check yet.');
         }
         throw error;
      }
   });

   for (const path of ['/:planId/approve', '/:planId/compile'] as const) {
      route.post(path, idempotent(options.idempotency), async (context) => {
         const record = await load(context.req.param('planId'));
         await authorizeWorkspace(context, options, record.workspaceId, 'product.write');
         const { value } = await decodeBody<{ note?: string }>(context, { note: 'string' });
         const note = (value.note ?? '').trim();
         if (note.length > MAX_NOTE) {
            assertValid([fieldError('/note', 'too_long', `note is at most ${MAX_NOTE} characters.`)]);
         }

         if (record.compile?.status === 'succeeded') {
            // Starting a started plan again is a no-op, not a conflict: the
            // caller wanted it started, and it is.
            return json(serializePlan(record));
         }

         try {
            const compiled = await plans.compile({
               planId: record.id,
               userId: context.get('user').id,
               note: note || null,
            });

            // Deliberately not awaited, for the reason generation is not: this
            // is a model call, and holding the request open for it would lose
            // the routing the moment the connection dropped. The tasks are
            // already durable; what follows only decides who holds them.
            void routeCompiled(options, compiled, context.get('user').id);

            return json(serializePlan(compiled));
         } catch (error) {
            if (error instanceof PlanInvalid) {
               throw new ApiError(409, 'PLAN_INVALID', 'This plan cannot be started as it stands.', {
                  fields: error.report.errors,
               });
            }
            if (error instanceof PlanNotOpen) {
               throw new ApiError(409, 'PLAN_NOT_OPEN', 'This plan is closed.');
            }
            if (error instanceof PlanBusy) {
               throw new ApiError(409, 'PLAN_BUSY', 'This plan is still being generated.');
            }
            // The plan stays approved with a failed compile, so a person can
            // retry rather than start again from the prompt.
            const message = error instanceof Error ? error.message : String(error);
            await plans.recordCompileFailure(record.id, message).catch(() => undefined);
            options.logger.error('plan compile failed', { planId: record.id, error: message });
            throw new ApiError(409, 'PLAN_COMPILE_FAILED', 'Starting this plan failed.', {
               stage: 'compile',
               message,
            });
         }
      });
   }

   /**
    * Answers the questions a blocked plan is waiting on, and plans again.
    *
    * The plan regenerates in place: same row, same id, same URL, with the
    * previous version kept in `plan_versions`. A blocking question could have
    * changed the shape of the whole plan, so the answers go back to the
    * planner rather than to the repair role, which would only fill in the
    * blanks it was already given.
    *
    * 202, for the reason `/generate` is: what follows is a model call, and a
    * request held open for it would lose the work when the connection dropped.
    */
   route.post('/:planId/answers', idempotent(options.idempotency), async (context) => {
      const record = await load(context.req.param('planId'));
      await authorizeWorkspace(context, options, record.workspaceId, 'product.write');

      const { value } = await decodeBody<{ answers?: unknown }>(context, { answers: 'raw' });
      // `raw` and then checked here: the shape is a list of records, which the
      // body decoder's vocabulary does not describe, and `resolveAnswers`
      // has to check the contents against the plan regardless.
      const submitted: SubmittedAnswer[] = Array.isArray(value.answers)
         ? value.answers.flatMap((entry) =>
              entry !== null && typeof entry === 'object' && !Array.isArray(entry)
                 ? [entry as SubmittedAnswer]
                 : []
           )
         : [];
      if (Array.isArray(value.answers) && value.answers.length !== submitted.length) {
         assertValid([fieldError('/answers', 'invalid_type', 'Each answer is an object.')]);
      }
      if (submitted.length === 0) {
         assertValid([fieldError('/answers', 'required', 'answers is required.')]);
      }
      if (submitted.length > MAX_ANSWERS) {
         assertValid([
            fieldError('/answers', 'too_many', `answers holds at most ${MAX_ANSWERS} entries.`),
         ]);
      }

      if (!options.generator) {
         throw new ApiError(
            412,
            'PLANNER_UNAVAILABLE',
            'This deployment has no model credential, so it cannot plan.'
         );
      }
      // Answering a plan that has already started would regenerate underneath
      // tasks that exist and agents that are working on them.
      if (record.compile?.status === 'succeeded') {
         throw new ApiError(409, 'PLAN_NOT_OPEN', 'This plan has already started.');
      }
      if (!record.plan) {
         throw new ApiError(409, 'PLAN_BUSY', 'This plan has no questions to answer yet.');
      }

      let resolved;
      try {
         resolved = resolveAnswers(record.plan, submitted);
      } catch (error) {
         if (error instanceof UnknownQuestion) {
            assertValid([
               fieldError('/answers', 'unknown_reference', `This plan is not asking "${error.assumptionId}".`),
            ]);
         }
         if (error instanceof UnansweredQuestion) {
            assertValid([
               fieldError('/answers', 'required', `"${error.assumptionId}" needs an answer.`),
            ]);
         }
         throw error;
      }

      // A blocking question left unanswered would regenerate into the same
      // blocked plan, which reads as the wizard having done nothing.
      const answered = new Set(resolved!.map((entry) => entry.assumption.id));
      const missing = unansweredBlockers(record.plan, answered);
      if (missing.length > 0) {
         assertValid(
            missing.map((assumption) =>
               fieldError('/answers', 'required', `"${assumption.description || assumption.id}" needs an answer.`)
            )
         );
      }

      await options.answers.record({
         workspaceId: record.workspaceId,
         planId: record.id,
         forVersion: record.version,
         answeredBy: context.get('user').id,
         answers: resolved!,
      });

      // Claimed before the answers are acted on: two wizards submitted at once
      // must produce one regeneration, not two racing to write a version.
      if (!(await plans.reopenForGeneration(record.id))) {
         throw new ApiError(409, 'PLAN_BUSY', 'This plan is already being planned again.');
      }

      void regenerate(options, record, context.get('user').id);

      const response = json(serializePlan(await plans.get(record.id)), 202);
      response.headers.set('Location', `/api/v1/plans/${record.id}`);
      return response;
   });

   route.post('/:planId/reject', async (context) => {
      const record = await load(context.req.param('planId'));
      await authorizeWorkspace(context, options, record.workspaceId, 'product.write');
      const { value } = await decodeBody<{ note?: string }>(context, { note: 'string' });
      return json(serializePlan(await plans.close(record.id, (value.note ?? '').trim() || null)));
   });

   return [{ prefix: '/api/v1/plans', handler: route }];

   async function load(raw: string | undefined): Promise<PlanRecord> {
      return plans.get(pathId(raw, 'Plan')).catch(() => {
         throw ApiError.notFound('Plan');
      });
   }
}

// ------------------------------------------------------------------ helpers

/**
 * Runs the generation behind the response.
 *
 * Every failure is recorded on the plan rather than raised: nobody is waiting
 * on this promise, so a rejection here would be an unhandled one and the plan
 * would sit at `running` forever.
 */
async function generate(
   options: PlanOptions,
   record: PlanRecord,
   prompt: string,
   userId: string
): Promise<void> {
   const started = Date.now();
   try {
      const generated = await options.generator!.generate({
         workspaceId: record.workspaceId,
         prompt,
         // Written as each stage begins, so a person watching sees where the
         // plan is rather than a spinner. Failing to write it must not fail
         // the generation.
         onStage: (stage) => {
            void options.plans.markStage(record.id, stage).catch(() => undefined);
         },
      });
      await options.plans.recordGeneration({
         planId: record.id,
         workspaceId: record.workspaceId,
         plan: generated.plan,
         validation: generated.validation,
         critique: generated.critique,
         stages: generated.stages,
         usage: generated.usage,
         model: generated.model,
         provider: generated.provider,
         exhausted: generated.exhausted,
         durationMs: Date.now() - started,
         createdBy: userId,
      });
      options.logger.info('plan generated', {
         planId: record.id,
         issues: generated.plan.issues.length,
         validation: generated.validation.status,
         stages: generated.stages.map((stage) => stage.stage).join('→'),
         ...(generated.exhausted ? { exhausted: true } : {}),
      });
   } catch (error) {
      // `<code> at <stage>`, as the contract words it: knowing the critic
      // timed out is different from knowing the planner was never reachable.
      const message =
         error instanceof PlannerUnavailable
            ? `${error.message} at ${error.stage}`
            : error instanceof Error
              ? error.message
              : String(error);
      await options.plans
         .recordGenerationFailure({
            planId: record.id,
            workspaceId: record.workspaceId,
            message,
            durationMs: Date.now() - started,
         })
         .catch(() => undefined);
      options.logger.error('plan generation failed', { planId: record.id, error: message });
   }
}

/**
 * Plans again with the answers, then carries on into the work.
 *
 * The continuation runs here rather than in the browser deliberately. Auto-start
 * has until now lived in a React effect, so closing the tab after asking for a
 * plan silently cancelled it — no error, because nothing failed. Answering a
 * question is a commitment, and a commitment that a closed laptop revokes is
 * not one. Once the answers are in, this sees it through.
 *
 * Nothing is awaited by a caller, so every failure lands on the plan or in the
 * log rather than becoming an unhandled rejection.
 */
async function regenerate(options: PlanOptions, record: PlanRecord, userId: string): Promise<void> {
   const started = Date.now();
   let compiled: PlanRecord;
   try {
      const answers = await options.answers.forPrompt(record.id);
      const generated = await options.generator!.generate({
         workspaceId: record.workspaceId,
         prompt: record.sourcePrompt ?? '',
         answers,
         onStage: (stage) => {
            void options.plans.markStage(record.id, stage).catch(() => undefined);
         },
      });
      await options.plans.recordGeneration({
         planId: record.id,
         workspaceId: record.workspaceId,
         plan: generated.plan,
         validation: generated.validation,
         critique: generated.critique,
         stages: generated.stages,
         usage: generated.usage,
         model: generated.model,
         provider: generated.provider,
         exhausted: generated.exhausted,
         durationMs: Date.now() - started,
         createdBy: userId,
      });
      options.logger.info('plan regenerated from answers', {
         planId: record.id,
         answers: answers.length,
         issues: generated.plan.issues.length,
         validation: generated.validation.status,
      });

      // Still blocked means the planner asked something new rather than
      // re-asking what was answered. That is a legitimate outcome and the
      // wizard opens again; it is not a failure to record.
      if (generated.validation.status !== 'valid') return;
   } catch (error) {
      const message =
         error instanceof PlannerUnavailable
            ? `${error.message} at ${error.stage}`
            : error instanceof Error
              ? error.message
              : String(error);
      await options.plans
         .recordGenerationFailure({
            planId: record.id,
            workspaceId: record.workspaceId,
            message,
            durationMs: Date.now() - started,
         })
         .catch(() => undefined);
      options.logger.error('plan regeneration failed', { planId: record.id, error: message });
      return;
   }

   // Compiling is what the answers were for. It is outside the try above so a
   // compile failure is recorded as a compile failure: a plan that generated
   // fine and failed to start is a different thing to fix than one that never
   // planned, and reporting the first as the second sends someone to the
   // wrong place.
   try {
      compiled = await options.plans.compile({ planId: record.id, userId, note: null });
   } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await options.plans.recordCompileFailure(record.id, message).catch(() => undefined);
      options.logger.error('plan compile after answers failed', {
         planId: record.id,
         error: message,
      });
      return;
   }

   await routeCompiled(options, compiled, userId);
}

export function serializePlan(record: PlanRecord): Record<string, unknown> {
   return {
      id: record.id,
      workspaceId: record.workspaceId,
      goalId: record.goalId,
      projectId: record.projectId,
      autoGate: record.autoGate,
      status: record.status,
      source: record.source,
      sourcePrompt: record.sourcePrompt,
      irVersion: record.irVersion,
      version: record.version,
      plannerVersion: record.plannerVersion,
      confidence: record.confidence,
      generation: record.generation,
      validation: record.validation,
      critic: record.critic,
      compile: record.compile,
      plan: record.plan,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
   };
}

async function oldestBoard(sql: Sql, workspaceId: string): Promise<string | null> {
   const [row] = await sql`
      SELECT id FROM boards WHERE workspace_id = ${workspaceId}
       ORDER BY created_at ASC, id ASC LIMIT 1`;
   return row ? (row.id as string) : null;
}

async function authorizeWorkspace(
   context: { get: (key: 'user') => { id: string } },
   options: PlanOptions,
   workspaceId: string,
   permission: 'product.read' | 'product.write' | 'settings.write'
): Promise<void> {
   await options.boards
      .authorizeWorkspace(context.get('user').id, workspaceId, permission)
      .catch((error: unknown) => {
         if (error instanceof NotFound) throw ApiError.notFound('Workspace');
         if (error instanceof Forbidden) {
            throw new ApiError(403, 'PLAN_FORBIDDEN', 'You cannot change plans in this workspace.');
         }
         throw error;
      });
}

/**
 * Route and start what a compile just created.
 *
 * Failing here leaves tasks that exist and are owned by nobody, which is
 * recoverable by hand — so it is logged and swallowed rather than allowed to
 * reject into a background promise nobody is holding.
 */
async function routeCompiled(
   options: PlanOptions,
   plan: { id: string; workspaceId: string; boardId: string | null },
   userId: string
): Promise<void> {
   // A plan with no board has nowhere to put a run, and compile would not have
   // produced tasks without one — but the column is nullable, so this is a
   // narrowing rather than a claim about what can happen.
   if (!options.triage || !options.runs || !plan.boardId) return;
   const runs = options.runs;
   const boardId = plan.boardId;
   try {
      const result = await options.triage.triage({
         planId: plan.id,
         workspaceId: plan.workspaceId,
         admit: async (task) => {
            await runs.admit({
               issueId: task.issueId,
               boardId,
               workspaceId: plan.workspaceId,
               agentId: task.agentId,
               instructions: task.instructions,
               requestedBy: userId,
            });
         },
      });
      options.logger.info('plan routed', {
         planId: plan.id,
         assigned: result.assigned,
         started: result.started,
         unassigned: result.unassigned.length,
      });
   } catch (error) {
      options.logger.error('plan routing failed', {
         planId: plan.id,
         error: error instanceof TriageUnavailable ? error.message : String(error),
      });
   }
}
