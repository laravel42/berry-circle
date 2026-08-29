import { randomUUID } from 'node:crypto';
import { toRFC3339, type Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import type { StageRecord } from './generator.ts';
import { inDependencyOrder, validatePlan, type Plan, type ValidationReport } from './schema.ts';

/**
 * Plans: the proposal, and the one transaction that turns it into work.
 *
 * Compilation is the interesting part. It creates a goal's worth of tasks,
 * their dependency edges, their labels and their gates — and it does all of it
 * or none of it. A half-compiled plan would be a board with tasks whose
 * blockers were never written, which reads as ready-to-start work that is not.
 */

/**
 * The wire vocabulary. The column is snake_case and has no `compiled`: a
 * started plan is `approved` with `compile.status = 'succeeded'`, which is
 * also what the contract says, so the two agree without a translation table
 * beyond the one below.
 */
export type PlanStatus = 'draft' | 'pendingApproval' | 'approved' | 'rejected' | 'superseded';

export interface PlanRecord {
   id: string;
   workspaceId: string;
   goalId: string | null;
   projectId: string | null;
   boardId: string | null;
   autoGate: boolean;
   status: PlanStatus;
   /** The column's own spelling, for the checks that compare against it. */
   rawStatus: string;
   source: string;
   sourcePrompt: string | null;
   irVersion: string | null;
   version: number;
   plannerVersion: string | null;
   confidence: number | null;
   generation: { status: string; error: string | null; stage: string | null };
   validation: ValidationReport;
   critic: unknown;
   compile: {
      status: string;
      error: string | null;
      compiledAt: string | null;
      goalId: string | null;
      issueIds: string[];
      approvalIds: string[];
   } | null;
   plan: Plan | null;
   createdAt: string;
   updatedAt: string;
}

export class PlanNotOpen extends Error {
   override readonly name = 'PlanNotOpen';
   constructor() {
      super('this plan is not open');
   }
}

export class PlanBusy extends Error {
   override readonly name = 'PlanBusy';
   constructor() {
      super('this plan is still generating or compiling');
   }
}

export class PlanInvalid extends Error {
   override readonly name = 'PlanInvalid';
   readonly report: ValidationReport;
   constructor(report: ValidationReport) {
      super('this plan cannot be compiled as it stands');
      this.report = report;
   }
}

export class OpenPlanExists extends Error {
   override readonly name = 'OpenPlanExists';
   readonly planId: string;
   constructor(planId: string) {
      super('this goal already has an open plan');
      this.planId = planId;
   }
}

const COLUMNS = `id, workspace_id, goal_id, project_id, board_id, auto_gate, status, source,
   source_prompt, ir, ir_version, current_version, planner_version, confidence,
   generation_status, generation_error, generation_stage, validation_status, compile_status, compile_error,
   compiled_at, created_at, updated_at`;

/** Statuses a person can still act on, as the column spells them. */
const OPEN = new Set(['draft', 'pending_approval', 'approved']);

function toWireStatus(status: string): PlanStatus {
   return status === 'pending_approval' ? 'pendingApproval' : (status as PlanStatus);
}

export class PlanRepository {
   readonly #sql: Sql;
   readonly #newId: () => string;
   readonly #clock: () => Date;

   constructor(sql: Sql, options: { newId?: () => string; clock?: () => Date } = {}) {
      this.#sql = sql;
      this.#newId = options.newId ?? randomUUID;
      this.#clock = options.clock ?? (() => new Date());
   }

   async get(planId: string): Promise<PlanRecord> {
      const [row] = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)} FROM plans WHERE id = ${planId}`;
      if (!row) throw new NotFound();
      return await this.#hydrate(row);
   }

   /**
    * Creates the row a generation will fill in.
    *
    * The row exists before the model is asked, which is what lets the request
    * answer 202 with an id: the plan is a durable thing being worked on rather
    * than a promise the caller has to hold open.
    */
   async open(input: {
      workspaceId: string;
      goalId: string | null;
      projectId: string | null;
      boardId: string;
      prompt: string;
      createdBy: string;
   }): Promise<PlanRecord> {
      const id = this.#newId();
      return this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         if (input.goalId) {
            const [existing] = await tx`
               SELECT id FROM plans
                WHERE goal_id = ${input.goalId} AND status IN ('draft', 'pending_approval', 'approved')
                LIMIT 1`;
            // Two open plans for one goal would be two answers to one
            // question, and nothing in the product says which wins.
            if (existing) throw new OpenPlanExists(existing.id as string);
         }

         // A plan always hangs off a goal, created here when none was named.
         // The table requires it (`plans_scope_ck`), and so does the product:
         // a plan proposes work *for* something, and a plan with nothing to
         // serve is a list of tasks nobody asked for.
         const goalId =
            input.goalId ??
            ((
               await tx`
                  INSERT INTO goals (workspace_id, title, description, status, created_by)
                  VALUES (${input.workspaceId}, ${goalTitle(input.prompt)},
                          ${input.prompt}, 'draft', ${input.createdBy})
                  RETURNING id`
            )[0]!.id as string);

         await tx`
            INSERT INTO plans (id, workspace_id, goal_id, project_id, board_id, status, source,
                               source_prompt, generation_status, created_by)
            VALUES (${id}, ${input.workspaceId}, ${goalId}, NULL,
                    ${input.boardId}, 'draft', 'ai', ${input.prompt}, 'running',
                    ${input.createdBy})`;
         // `proposed_by` is deliberately left null: it references `agents`,
         // and the thing that asked for this plan was a person.
         const [row] = await tx`SELECT ${tx.unsafe(COLUMNS)} FROM plans WHERE id = ${id}`;
         return await this.#hydrate(row!, tx);
      }) as Promise<PlanRecord>;
   }

   /** The stage in flight, so a person watching sees where the plan is. */
   async markStage(planId: string, stage: string): Promise<void> {
      await this.#sql`
         UPDATE plans SET generation_stage = ${stage}, updated_at = ${this.#clock().toISOString()}
          WHERE id = ${planId} AND generation_status = 'running'`;
   }

   /** Records a finished generation: the document, its verdict, and every stage that ran. */
   async recordGeneration(input: {
      planId: string;
      workspaceId: string;
      plan: Plan;
      validation: ValidationReport;
      critique: unknown;
      stages: StageRecord[];
      usage: { inputTokens: number; outputTokens: number };
      model: string;
      provider: string;
      exhausted: boolean;
      durationMs: number;
      createdBy: string;
   }): Promise<void> {
      const now = this.#clock().toISOString();
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const [row] = await tx`
            UPDATE plans
               SET ir = ${tx.json(input.plan as never)}, ir_version = '1',
                   current_version = current_version + 1,
                   generation_status = 'succeeded',
                   -- The contract's wording. Bounded repairs that ran out is
                   -- not a failed generation: the document exists and its
                   -- errors are named, which is something a person can fix.
                   generation_error = ${input.exhausted ? 'PLAN_INVALID' : null},
                   generation_stage = NULL,
                   validation_status = ${input.validation.status},
                   confidence = ${input.plan.confidence ?? null},
                   planner_version = ${input.model},
                   updated_at = ${now}
             WHERE id = ${input.planId}
             RETURNING current_version`;

         await tx`
            INSERT INTO plan_versions (workspace_id, plan_id, version, origin, ir, ir_version,
                                       validation, critic, created_by_type, created_by)
            VALUES (${input.workspaceId}, ${input.planId}, ${Number(row!.current_version)},
                    'generated', ${tx.json(input.plan as never)}, '1',
                    ${tx.json(input.validation as never)},
                    ${input.critique === null ? null : tx.json(input.critique as never)},
                    'user', ${input.createdBy})`;

         // One row per stage, in the order they ran: what a person opens when
         // they want to know why a plan came out the way it did.
         for (const stage of input.stages) {
            await appendEvent(tx, {
               workspaceId: input.workspaceId,
               planId: input.planId,
               stage: stage.stage,
               ...(stage.role ? { role: stage.role } : {}),
               ...(stage.provider ? { provider: stage.provider } : {}),
               ...(stage.model ? { model: stage.model } : {}),
               inputTokens: stage.inputTokens,
               outputTokens: stage.outputTokens,
               durationMs: stage.durationMs,
               outcome: stage.outcome,
               detail: stage.detail,
            });
         }
      });
   }

   async recordGenerationFailure(input: {
      planId: string;
      workspaceId: string;
      message: string;
      durationMs: number;
   }): Promise<void> {
      const now = this.#clock().toISOString();
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         await tx`
            UPDATE plans
               SET generation_status = 'failed', generation_error = ${input.message},
                generation_stage = NULL, updated_at = ${now}
             WHERE id = ${input.planId}`;
         await appendEvent(tx, {
            workspaceId: input.workspaceId,
            planId: input.planId,
            stage: 'generate',
            role: 'planner',
            durationMs: input.durationMs,
            outcome: 'error',
            detail: { message: input.message },
         });
      });
   }

   /** Re-runs the deterministic checks on the stored document. */
   async revalidate(planId: string): Promise<PlanRecord> {
      const record = await this.get(planId);
      if (!record.plan) throw new PlanBusy();
      const validation = validatePlan(record.plan);
      await this.#sql`
         UPDATE plans SET validation_status = ${validation.status}, updated_at = ${this.#clock().toISOString()}
          WHERE id = ${planId}`;
      return { ...record, validation };
   }

   async close(planId: string, note: string | null): Promise<PlanRecord> {
      const now = this.#clock().toISOString();
      await this.#sql`
         UPDATE plans SET status = 'rejected', decision_note = ${note}, updated_at = ${now}
          WHERE id = ${planId} AND status IN ('draft', 'pending_approval', 'approved')`;
      return this.get(planId);
   }

   /**
    * Start Plan.
    *
    * One transaction, in dependency order: the goal is promoted, each task is
    * created with the status its dependencies and gates imply, capabilities
    * become labels, edges are written, and gated tasks get their approval.
    *
    * A task's status is decided here rather than by a later pass because the
    * database refuses to move a gated task to `todo` at all — creating them
    * all as `todo` and fixing them afterwards would fail on the first gate.
    */
   async compile(input: {
      planId: string;
      userId: string;
      note: string | null;
   }): Promise<PlanRecord> {
      const now = this.#clock().toISOString();
      const record = await this.get(input.planId);

      if (record.generation.status === 'running') throw new PlanBusy();
      if (!OPEN.has(record.rawStatus)) throw new PlanNotOpen();
      if (!record.plan) throw new PlanBusy();

      const validation = validatePlan(record.plan);
      if (validation.status !== 'valid') throw new PlanInvalid(validation);

      const plan = record.plan;
      const boardId = record.boardId;
      if (!boardId) throw new PlanInvalid(validation);

      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;

         const goalId = record.goalId!;
         await tx`
            UPDATE goals SET status = 'planned', updated_at = ${now}
             WHERE id = ${goalId} AND status = 'draft'`;

         const labelIds = await ensureLabels(tx, record.workspaceId, plan, input.userId);
         const issueIds = new Map<string, string>();
         const approvalIds: string[] = [];

         for (const issue of inDependencyOrder(plan.issues)) {
            const issueId = this.#newId();
            const blocked = issue.dependsOn.length > 0;
            const status = issue.requiresApproval ? 'backlog' : blocked ? 'blocked' : 'todo';

            const [counter] = await tx`
               UPDATE boards SET issue_counter = issue_counter + 1
                WHERE id = ${boardId} RETURNING issue_counter`;
            await tx`
               INSERT INTO issues (id, board_id, number, title, description, status, priority,
                                   created_by, assignee_type, assignee_id)
               VALUES (${issueId}, ${boardId}, ${Number(counter!.issue_counter)}, ${issue.title},
                       ${issue.description ?? null}, ${status}::issue_status,
                       ${issue.priority ?? 'medium'}, ${input.userId},
                       -- Null, not a third enum value: unassigned is the
                       -- absence of an assignee, which is what the column
                       -- being nullable already says.
                       ${issue.suggestedAgentId ? 'agent' : null},
                       ${issue.suggestedAgentId ?? null})`;
            issueIds.set(issue.tempId, issueId);

            await tx`
               INSERT INTO goal_issues (workspace_id, goal_id, issue_id)
               VALUES (${record.workspaceId}, ${goalId}, ${issueId})
               ON CONFLICT (issue_id) DO NOTHING`;
            await tx`
               INSERT INTO plan_issues (workspace_id, issue_id, plan_id)
               VALUES (${record.workspaceId}, ${issueId}, ${input.planId})
               ON CONFLICT (issue_id) DO NOTHING`;

            for (const capability of issue.requiredCapabilities) {
               const labelId = labelIds.get(capability);
               if (!labelId) continue;
               await tx`
                  INSERT INTO issue_label_memberships (workspace_id, issue_id, label_id, assigned_by)
                  VALUES (${record.workspaceId}, ${issueId}, ${labelId}, ${input.userId})
                  ON CONFLICT (workspace_id, issue_id, label_id) DO NOTHING`;
            }

            // After the row exists, and only for dependencies already created
            // — which the ordering guarantees.
            for (const dependency of issue.dependsOn) {
               const blockerId = issueIds.get(dependency);
               if (!blockerId) continue;
               await tx`
                  INSERT INTO issue_dependencies (workspace_id, issue_id, depends_on_issue_id, created_by)
                  VALUES (${record.workspaceId}, ${issueId}, ${blockerId}, ${input.userId})
                  ON CONFLICT (issue_id, depends_on_issue_id) DO NOTHING`;
            }

            if (issue.requiresApproval) {
               const approvalId = this.#newId();
               await tx`
                  INSERT INTO approvals (id, workspace_id, kind, risk, title, description, issue_id,
                                         plan_id, goal_id, requested_from_role, requested_by_type,
                                         requested_by, status)
                  VALUES (${approvalId}, ${record.workspaceId}, 'issue_start', 'medium',
                          ${`Start "${issue.title}"?`},
                          ${plan.approvals.find((a) => a.target.tempId === issue.tempId)?.reason ?? null},
                          ${issueId}, ${input.planId}, ${goalId}, 'admin', 'user',
                          ${input.userId}, 'pending')`;
               approvalIds.push(approvalId);
            }
         }

         // `approved` with a succeeded compile, not a `compiled` status: the
         // column has no such value, and the contract already distinguishes
         // the two through `compile.status`.
         await tx`
            UPDATE plans
               SET status = 'approved', approved_by = ${input.userId},
                   approved_at = ${now}, decision_note = ${input.note},
                   compile_status = 'succeeded', compile_error = NULL, compiled_at = ${now},
                   updated_at = ${now}
             WHERE id = ${input.planId}`;

         await appendEvent(tx, {
            workspaceId: record.workspaceId,
            planId: input.planId,
            stage: 'compile',
            outcome: 'ok',
            detail: { issues: issueIds.size, approvals: approvalIds.length },
         });
      });

      return this.get(input.planId);
   }

   /**
    * A compile that failed leaves the plan where a retry can reach it.
    *
    * The status is left alone: `plans_approval_complete_ck` requires an
    * approver beside `approved`, and a compile that never got that far has
    * none. `compile_status` carries the failure, which is what `POST /compile`
    * reads.
    */
   async recordCompileFailure(planId: string, message: string): Promise<void> {
      await this.#sql`
         UPDATE plans
            SET compile_status = 'failed', compile_error = ${message},
                updated_at = ${this.#clock().toISOString()}
          WHERE id = ${planId}`;
   }

   async versions(planId: string, limit = 50) {
      const rows = await this.#sql`
         SELECT id, version, origin, ir, validation, critic, patch, created_by, created_at
           FROM plan_versions WHERE plan_id = ${planId}
          ORDER BY version DESC LIMIT ${limit}`;
      return rows.map((row) => ({
         id: row.id as string,
         version: Number(row.version),
         origin: row.origin as string,
         plan: row.ir,
         validation: row.validation,
         critic: row.critic ?? null,
         patch: row.patch ?? null,
         createdBy: (row.created_by as string | null) ?? null,
         createdAt: toRFC3339(row.created_at as string)!,
      }));
   }

   async events(planId: string, limit = 200) {
      const rows = await this.#sql`
         SELECT id, sequence, stage, role, prompt_version, model_provider, model_name,
                input_tokens, output_tokens, cost_micros, duration_ms, outcome, detail, occurred_at
           FROM planner_events WHERE plan_id = ${planId}
          ORDER BY sequence ASC LIMIT ${limit}`;
      return rows.map((row) => ({
         id: row.id as string,
         sequence: Number(row.sequence),
         stage: row.stage as string,
         role: (row.role as string | null) ?? null,
         promptVersion: (row.prompt_version as string | null) ?? null,
         modelProvider: (row.model_provider as string | null) ?? null,
         modelName: (row.model_name as string | null) ?? null,
         inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
         outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
         costMicros: row.cost_micros === null ? null : Number(row.cost_micros),
         durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
         outcome: row.outcome as string,
         detail: row.detail,
         occurredAt: toRFC3339(row.occurred_at as string)!,
      }));
   }

   async #hydrate(row: Record<string, unknown>, tx?: Sql): Promise<PlanRecord> {
      const sql = tx ?? this.#sql;
      const plan = (row.ir ?? null) as Plan | null;
      const compiled = row.compile_status !== 'not_started';

      const [latest] = await sql`
         SELECT critic FROM plan_versions
          WHERE plan_id = ${row.id as string} ORDER BY version DESC LIMIT 1`;
      const critique = latest?.critic ?? null;

      let issueIds: string[] = [];
      let approvalIds: string[] = [];
      if (compiled) {
         const issues = await sql`
            SELECT issue_id FROM plan_issues WHERE plan_id = ${row.id as string}`;
         issueIds = issues.map((entry) => entry.issue_id as string);
         const approvals = await sql`
            SELECT id FROM approvals WHERE plan_id = ${row.id as string}`;
         approvalIds = approvals.map((entry) => entry.id as string);
      }

      return {
         id: row.id as string,
         workspaceId: row.workspace_id as string,
         goalId: (row.goal_id as string | null) ?? null,
         projectId: (row.project_id as string | null) ?? null,
         boardId: (row.board_id as string | null) ?? null,
         autoGate: Boolean(row.auto_gate),
         status: toWireStatus(row.status as string),
         rawStatus: row.status as string,
         source: row.source as string,
         sourcePrompt: (row.source_prompt as string | null) ?? null,
         irVersion: (row.ir_version as string | null) ?? null,
         version: Number(row.current_version),
         plannerVersion: (row.planner_version as string | null) ?? null,
         confidence: row.confidence === null ? null : Number(row.confidence),
         generation: {
            status: row.generation_status as string,
            error: (row.generation_error as string | null) ?? null,
            stage:
               row.generation_status === 'running'
                  ? ((row.generation_stage as string | null) ?? 'generate')
                  : null,
         },
         // Recomputed on every read rather than stored: the plan is checked
         // against the workspace as it is now, not as it was when generated.
         validation: plan
            ? validatePlan(plan)
            : {
                 status: (row.validation_status as ValidationReport['status']) ?? 'unknown',
                 errors: [],
                 warnings: [],
                 requiredConnections: [],
                 ambiguities: [],
                 risk: 'low',
                 needsAdminActivation: false,
              },
         // From the latest version rather than a column: the critique belongs
         // to the document it reviewed, and a plan regenerated would otherwise
         // carry the previous one's verdict.
         critic: critique,
         compile: compiled
            ? {
                 status: row.compile_status as string,
                 error: (row.compile_error as string | null) ?? null,
                 compiledAt: toRFC3339(row.compiled_at as string | null),
                 goalId: (row.goal_id as string | null) ?? null,
                 issueIds,
                 approvalIds,
              }
            : null,
         plan,
         createdAt: toRFC3339(row.created_at as string)!,
         updatedAt: toRFC3339(row.updated_at as string)!,
      };
   }
}

// ------------------------------------------------------------------ helpers

/** The first line of the request, as the draft goal's name. */
function goalTitle(prompt: string): string {
   const firstLine = prompt.split('\n')[0]!.trim();
   return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine || 'Untitled plan';
}

/**
 * A label per required capability, created once and reused.
 *
 * The unique index is on `lower(name)` and only over live rows, so the
 * conflict target has to name both — `ON CONFLICT DO NOTHING` alone would not
 * match it. Written as an upsert rather than read-then-write because two
 * plans compiled at the same moment would both find no label and both create
 * one.
 */
async function ensureLabels(
   tx: Sql,
   workspaceId: string,
   plan: Plan,
   userId: string
): Promise<Map<string, string>> {
   const wanted = [...new Set(plan.issues.flatMap((issue) => issue.requiredCapabilities))];
   const ids = new Map<string, string>();
   for (const capability of wanted) {
      const [row] = await tx`
         INSERT INTO issue_labels (workspace_id, name, color, created_by)
         VALUES (${workspaceId}, ${capability}, '#6366f1', ${userId})
         ON CONFLICT (workspace_id, lower(name)) WHERE archived_at IS NULL
         DO UPDATE SET updated_at = now()
         RETURNING id`;
      if (row) ids.set(capability, row.id as string);
   }
   return ids;
}

async function appendEvent(
   tx: Sql,
   input: {
      workspaceId: string;
      planId: string;
      stage: string;
      role?: string;
      provider?: string;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      durationMs?: number;
      outcome: string;
      detail: Record<string, unknown>;
   }
): Promise<void> {
   await tx`
      INSERT INTO planner_events (workspace_id, plan_id, sequence, stage, role, model_provider,
                                  model_name, input_tokens, output_tokens, duration_ms, outcome, detail)
      SELECT ${input.workspaceId}, ${input.planId},
             COALESCE(MAX(sequence), -1) + 1, ${input.stage}, ${input.role ?? null},
             ${input.provider ?? null}, ${input.model ?? null},
             ${input.inputTokens ?? null}, ${input.outputTokens ?? null},
             ${input.durationMs ?? null}, ${input.outcome}, ${tx.json(input.detail as never)}
        FROM planner_events WHERE plan_id = ${input.planId}`;
}
