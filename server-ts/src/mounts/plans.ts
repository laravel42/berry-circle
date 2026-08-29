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

export interface PlanOptions {
   sessions: SessionService;
   plans: PlanRepository;
   generator: PlanGenerator | null;
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
      }>(context, {
         workspaceId: 'string',
         prompt: 'string',
         goalId: 'string',
         projectId: 'string',
         boardId: 'string',
         hint: 'string',
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
            return json(
               serializePlan(
                  await plans.compile({
                     planId: record.id,
                     userId: context.get('user').id,
                     note: note || null,
                  })
               )
            );
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
