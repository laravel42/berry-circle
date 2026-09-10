import type { Sql } from '../db/pool.ts';
import { z } from 'zod';
import { CompletionInvalid, type RuntimeCompletion } from '../runtime/completion.ts';
import { readPlan, validatePlan, type FieldProblem, type Plan, type ValidationReport } from './schema.ts';

/**
 * Turning a sentence into a plan, and then into a better one.
 *
 * Four stages, three of which are a model and one of which is not:
 *
 *   1. **generate** — the planner role turns the request into a document.
 *   2. **validate** — deterministic. No model, no judgement: are the
 *      dependencies real, is the graph acyclic, does every approval gate
 *      something. This is what makes a plan the same verdict every time it is
 *      read.
 *   3. **repair** — when the validator found errors, the repair role is shown
 *      the document *and the errors* and asked to fix exactly those. Bounded,
 *      because a model that cannot fix its own graph in two attempts will not
 *      fix it in ten, and each attempt is paid for.
 *   4. **critic** — when the document is valid, the critic role is asked
 *      whether it is any *good*: is a task too big to finish, is something
 *      missing, does an ordering make no sense. A revision verdict becomes one
 *      more repair round.
 *
 * The split between 2 and 4 is the important one. The validator answers
 * "could this be compiled" and must never change its mind; the critic answers
 * "should it be" and is allowed to be wrong. Only the first can block a plan.
 */

const GENERATE_SYSTEM = `You turn a request into a Berry plan: the milestones a
team would deliver it in, the tasks that reach each milestone, and the order
they depend on each other in.

The shape of the answer is:

{
  "goal": { "tempId": "goal-1", "title": "...", "description": "..." },
  "milestones": [
    { "tempId": "m1", "title": "...", "description": "..." }
  ],
  "assumptions": [
    { "id": "a1", "description": "...", "confidence": "low|medium|high", "blocking": false,
      "options": [ { "id": "a1-o1", "label": "...", "detail": "..." } ] }
  ],
  "issues": [
    { "tempId": "t1", "title": "...", "description": "...", "milestone": "m1",
      "requiredCapabilities": ["typescript"], "dependsOn": ["t2"],
      "requiresReview": false, "requiresApproval": false, "priority": "medium" }
  ],
  "approvals": [
    { "tempId": "ap1", "title": "...", "reason": "...",
      "target": { "kind": "issue", "tempId": "t1" } }
  ]
}

Rules:
- The goal is the whole request in one line. It is not a milestone and it
  has no tasks of its own.
- Decompose the request into 2 to 6 milestones, in delivery order. Each
  milestone is an outcome somebody could see working on its own — "people
  can sign in", "a ticket can be created and assigned" — not a layer of the
  system, not a phase name like "backend" or "testing". Do not restate the
  request as a single milestone: if the request has several parts, it has
  several milestones.
- Every task belongs to exactly one milestone, named in \`milestone\` by its
  \`tempId\`, and every milestone has 3 to 8 tasks.
- Each task has one responsibility: one thing to build, change or decide, so
  that finishing it can be checked without asking what "done" meant. Not
  "build the feature"; not "rename a variable" either. A task that needs
  "and" to describe is usually two tasks.
- Order the milestones so that each one builds on the ones before it, and
  keep dependencies inside a milestone where you can; a task that waits on
  an earlier milestone names the specific task it waits on.
- \`dependsOn\` names tasks in this plan by \`tempId\`, and never forms a
  circle.
- Set \`requiresApproval\` only where starting the task is a commitment a
  person should make deliberately: deleting data, spending money, or touching
  something outside the repository.
- If the request is too vague to plan, say so with a blocking assumption
  (\`"blocking": true\`) whose description is the question you need answered,
  and propose no tasks.
- Every blocking assumption MUST carry 2-4 \`options\`: the concrete answers you
  would accept, mutually exclusive, in the vocabulary of the request rather
  than of software. "Nightly batch" and "Real-time (under 500ms)" are options;
  "Yes" and "No" to a question that is not yes-or-no are not. Add \`detail\`
  only where the label alone would not tell someone what they are choosing.
  Someone is going to pick one of these without being able to ask you what you
  meant, so do not offer an option you could not plan from.
- Offer options on a non-blocking assumption too when there is a real choice
  behind it. You are guessing either way; the options are how someone corrects
  the guess without having to know they needed to.
- Berry has no rules engine. A condition that must be respected goes in the
  task's description, where the agent doing the work will read it.`;

const REPAIR_SYSTEM = `You are fixing a Berry plan that failed its checks.

You will be given the plan as JSON and the problems found in it. Return the
whole corrected plan as JSON — same shape, no prose, no code fence.

Fix exactly the problems listed. Do not restructure the plan, rename tasks that
are fine, or add work nobody asked for: someone is going to read the difference
between what they asked for and what you produced.

The paths in the problems are JSON pointers into the plan you were given.`;

const CRITIC_SYSTEM = `You are reviewing a Berry plan before a person is asked
to start it. The plan is already known to be structurally valid; your job is
whether it is any good.

The shape of the answer is:

{ "verdict": "accept" | "revise",
  "problems": [ { "code": "...", "path": "/issues/0", "message": "...",
                  "severity": "error" | "warning" } ] }

Say "revise" only for something a person would actually send back: a task too
big for one agent to finish, a task that does two unrelated things, a request
with several parts squeezed into one milestone, a milestone that is a layer or
a phase rather than an outcome, a missing step the rest depends on, an
ordering that cannot work, a task that will silently do something
destructive. Style, wording and preference are "accept" with a warning at
most.

An empty problem list with "accept" is a good answer, and the common one.`;

/**
 * The shape the planner and the repair role answer in.
 *
 * Top-level keys are named so the model's structured-output tool advertises
 * them — an open object tempted it to wrap the plan under a key of its own.
 * Everything inside stays loose on purpose: `readPlan` reads leniently and
 * names what is wrong, and the repair loop is built on those names. A strict
 * schema here would refuse the document the repair role exists to fix.
 */
const PLAN_SHAPE = z.looseObject({
   goal: z.looseObject({}).optional(),
   milestones: z.array(z.looseObject({})).optional(),
   assumptions: z.array(z.looseObject({})).optional(),
   issues: z.array(z.looseObject({})).optional(),
   approvals: z.array(z.looseObject({})).optional(),
});

const CRITIQUE_SHAPE = z.looseObject({
   verdict: z.string().optional(),
   problems: z.array(z.looseObject({})).optional(),
});

export type Stage = 'generate' | 'validate' | 'repair' | 'critic';

export interface Critique {
   verdict: 'accept' | 'revise';
   problems: Array<{ code: string; path: string; message: string; severity: 'error' | 'warning' }>;
}

export interface StageRecord {
   stage: Stage;
   role: 'planner' | 'repair' | 'critic' | null;
   provider: string | null;
   model: string | null;
   inputTokens: number;
   outputTokens: number;
   durationMs: number;
   outcome: 'ok' | 'invalid' | 'error';
   detail: Record<string, unknown>;
}

export interface Generated {
   plan: Plan;
   validation: ValidationReport;
   critique: Critique | null;
   usage: { inputTokens: number; outputTokens: number };
   model: string;
   provider: string;
   stages: StageRecord[];
   /** Set when the bounded repairs ran out. The last document is still kept. */
   exhausted: boolean;
}

export class PlannerUnavailable extends Error {
   override readonly name = 'PlannerUnavailable';
   /** The stage that could not run, for `<code> at <stage>`. */
   readonly stage: Stage;
   constructor(message: string, stage: Stage = 'generate') {
      super(message);
      this.stage = stage;
   }
}

export interface PlanGeneratorOptions {
   sql: Sql;
   defaultModel: string;
   /** Runs each call as a completion task on the runtime (ADR-0014). */
   completion: Pick<RuntimeCompletion, 'structured'>;
   timeoutMs?: number;
   /** How many times a document may be sent back to be fixed. */
   maxRepairs?: number;
   /** How many times the critic may ask for a revision. */
   maxCriticRounds?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class PlanGenerator {
   readonly #sql: Sql;
   readonly #completion: Pick<RuntimeCompletion, 'structured'>;
   readonly #defaultModel: string;
   readonly #timeoutMs: number;
   readonly #maxRepairs: number;
   readonly #maxCriticRounds: number;

   constructor(options: PlanGeneratorOptions) {
      this.#sql = options.sql;
      this.#completion = options.completion;
      this.#defaultModel = options.defaultModel;
      this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      this.#maxRepairs = options.maxRepairs ?? 2;
      this.#maxCriticRounds = options.maxCriticRounds ?? 1;
   }

   /**
    * The model provisioned for a role, or the deployment's default.
    *
    * `model_role_agents` is where an operator says which model does what.
    * Falling back rather than refusing means a deployment that never filled
    * that table can still plan, which is the more useful failure.
    */
   async role(name: 'planner' | 'repair' | 'critic'): Promise<{ provider: string; model: string }> {
      const [row] = await this.#sql`
         SELECT model_provider, model_name FROM model_role_agents
          WHERE role = ${name} AND status <> 'offline'
          ORDER BY updated_at DESC LIMIT 1`;
      return row
         ? { provider: row.model_provider as string, model: row.model_name as string }
         : { provider: 'bedrock', model: this.#defaultModel };
   }

   /**
    * The whole pipeline.
    *
    * `onStage` is called as each stage finishes rather than at the end, so a
    * caller can write `generation.stage` and a person watching sees where the
    * plan is instead of a spinner.
    */
   async generate(input: {
      /** The workspace the plan is for; its completion tasks run there. */
      workspaceId: string;
      prompt: string;
      /**
       * What the asker has already answered, when this is a second attempt.
       *
       * Appended to the request rather than merged into it: the original
       * prompt is what someone typed, and rewriting it to contain answers
       * would leave no record of what was asked versus what was learned.
       */
      answers?: AnsweredQuestion[];
      signal?: AbortSignal;
      onStage?: (stage: Stage) => void;
   }): Promise<Generated> {
      const stages: StageRecord[] = [];
      const usage = { inputTokens: 0, outputTokens: 0 };

      input.onStage?.('generate');
      const planner = await this.role('planner');
      const first = await this.#call({
         workspaceId: input.workspaceId,
         role: 'planner',
         stage: 'generate',
         model: planner,
         system: GENERATE_SYSTEM,
         user: withAnswers(input.prompt, input.answers ?? []),
         shape: PLAN_SHAPE,
         signal: input.signal,
      });
      account(usage, first);

      let { plan, problems } = readPlan(first.json);
      let validation = validatePlan(plan, { seed: problems });
      stages.push(
         stageOf('generate', 'planner', planner, first, validation, { issues: plan.issues.length })
      );
      input.onStage?.('validate');

      // A plan waiting on an answer is not a broken plan, and sending it to
      // the repair role would have it invent the answer.
      if (validation.status !== 'blocked') {
         let repairs = 0;
         while (validation.status === 'invalid' && repairs < this.#maxRepairs) {
            repairs += 1;
            input.onStage?.('repair');
            const repaired = await this.#repair(input.workspaceId, plan, validation.errors, input.signal);
            account(usage, repaired.result);
            plan = repaired.plan;
            validation = repaired.validation;
            stages.push(repaired.record);
         }

         if (validation.status === 'valid') {
            let rounds = 0;
            while (rounds < this.#maxCriticRounds) {
               rounds += 1;
               input.onStage?.('critic');
               const reviewed = await this.#critique(input.workspaceId, plan, input.signal);
               account(usage, reviewed.result);
               stages.push(reviewed.record);
               if (reviewed.critique.verdict === 'accept') {
                  return {
                     plan,
                     validation,
                     critique: reviewed.critique,
                     usage,
                     model: planner.model,
                     provider: planner.provider,
                     stages,
                     exhausted: false,
                  };
               }

               input.onStage?.('repair');
               const repaired = await this.#repair(
                  input.workspaceId,
                  plan,
                  reviewed.critique.problems.map((problem) => ({
                     path: problem.path,
                     code: problem.code,
                     message: problem.message,
                  })),
                  input.signal
               );
               account(usage, repaired.result);
               stages.push(repaired.record);
               // A revision that breaks the document is worse than the
               // document that was merely criticised, so the valid one wins.
               if (repaired.validation.status === 'valid') {
                  plan = repaired.plan;
                  validation = repaired.validation;
               }
            }
            return {
               plan,
               validation,
               critique: { verdict: 'accept', problems: [] },
               usage,
               model: planner.model,
               provider: planner.provider,
               stages,
               exhausted: false,
            };
         }
      }

      return {
         plan,
         validation,
         critique: null,
         usage,
         model: planner.model,
         provider: planner.provider,
         stages,
         // The last document is kept either way: a plan with named errors is
         // something a person can fix, and throwing it away would leave them
         // with the prompt and nothing else.
         exhausted: validation.status === 'invalid',
      };
   }

   async #repair(
      workspaceId: string,
      plan: Plan,
      problems: Array<{ path: string; code: string; message: string }>,
      signal: AbortSignal | undefined
   ) {
      const role = await this.role('repair');
      const result = await this.#call({
         workspaceId,
         role: 'repair',
         stage: 'repair',
         model: role,
         system: REPAIR_SYSTEM,
         user: `Plan:\n${JSON.stringify(plan)}\n\nProblems:\n${JSON.stringify(problems)}`,
         shape: PLAN_SHAPE,
         signal,
      });
      const { plan: repaired, problems: readingProblems } = readPlan(result.json);
      const validation = validatePlan(repaired, { seed: readingProblems });
      return {
         plan: repaired,
         validation,
         result,
         record: stageOf('repair', 'repair', role, result, validation, {
            fixing: problems.length,
         }),
      };
   }

   async #critique(workspaceId: string, plan: Plan, signal: AbortSignal | undefined) {
      const role = await this.role('critic');
      const result = await this.#call({
         workspaceId,
         role: 'critic',
         stage: 'critic',
         model: role,
         system: CRITIC_SYSTEM,
         user: JSON.stringify(plan),
         shape: CRITIQUE_SHAPE,
         signal,
      });
      const critique = readCritique(result.json);
      return {
         critique,
         result,
         record: {
            stage: 'critic' as const,
            role: 'critic' as const,
            provider: role.provider,
            model: role.model,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            durationMs: result.durationMs,
            outcome: 'ok' as const,
            detail: { verdict: critique.verdict, problems: critique.problems.length },
         },
      };
   }

   async #call(input: {
      workspaceId: string;
      role: 'planner' | 'repair' | 'critic';
      stage: Stage;
      model: { provider: string; model: string };
      system: string;
      user: string;
      shape: z.ZodType;
      signal: AbortSignal | undefined;
   }) {
      const result = await this.#completion
         .structured({
            workspaceId: input.workspaceId,
            purpose: input.role,
            model: input.model.model,
            system: input.system,
            user: input.user,
            schema: input.shape,
            ...(input.signal ? { signal: input.signal } : {}),
         })
         .catch((cause: unknown) => {
            if (cause instanceof CompletionInvalid) {
               throw new PlannerUnavailable(`the ${input.role} did not answer with a plan`, input.stage);
            }
            throw new PlannerUnavailable(
               `the ${input.role} could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
               input.stage
            );
         });

      return {
         json: result.value,
         inputTokens: result.inputTokens,
         outputTokens: result.outputTokens,
         durationMs: result.durationMs,
      };
   }
}

// ------------------------------------------------------------------ helpers

function account(
   usage: { inputTokens: number; outputTokens: number },
   result: { inputTokens: number; outputTokens: number }
): void {
   // Summed across stages: a plan that needed two repairs cost all of them,
   // and reporting only the last would make the pipeline look free.
   usage.inputTokens += result.inputTokens;
   usage.outputTokens += result.outputTokens;
}

/** A question the planner asked and the answer it was given. */
export interface AnsweredQuestion {
   question: string;
   answer: string;
}

/**
 * The request, with what has since been answered.
 *
 * The answers are named as answers rather than folded into the prose so the
 * planner cannot mistake them for more of the original request — and so it is
 * told, in as many words, not to ask them again. A planner that re-asks an
 * answered question blocks the plan a second time on the thing the person
 * just resolved, which reads as the feature not working at all.
 */
export function withAnswers(prompt: string, answers: AnsweredQuestion[]): string {
   if (answers.length === 0) return prompt;
   const answered = answers
      .map((entry, index) => `${index + 1}. ${entry.question}\n   ${entry.answer}`)
      .join('\n');
   return `${prompt}

---

You asked these questions and they have been answered. Treat each answer as
settled fact and plan accordingly. Do not raise them again as assumptions, and
do not block on them:

${answered}`;
}

function stageOf(
   stage: Stage,
   role: 'planner' | 'repair',
   model: { provider: string; model: string },
   result: { inputTokens: number; outputTokens: number; durationMs: number },
   validation: ValidationReport,
   detail: Record<string, unknown>
): StageRecord {
   return {
      stage,
      role,
      provider: model.provider,
      model: model.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      durationMs: result.durationMs,
      // The column's vocabulary is narrower than the validator's, so `blocked`
      // is recorded as `invalid` and the detail carries the difference.
      outcome: validation.status === 'valid' ? 'ok' : 'invalid',
      detail: { ...detail, validation: validation.status, errors: validation.errors.length },
   };
}

/**
 * The critic's verdict, read defensively.
 *
 * An unreadable critique is `accept`, not a failure: the plan already passed
 * the checks that decide whether it can be compiled, and losing a valid plan
 * because a reviewer answered badly would be the wrong trade.
 */
function readCritique(raw: unknown): Critique {
   if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { verdict: 'accept', problems: [] };
   }
   const source = raw as Record<string, unknown>;
   const problems = Array.isArray(source.problems) ? source.problems : [];
   return {
      verdict: source.verdict === 'revise' ? 'revise' : 'accept',
      problems: problems.flatMap((entry) => {
         if (typeof entry !== 'object' || entry === null) return [];
         const item = entry as Record<string, unknown>;
         const message = typeof item.message === 'string' ? item.message : '';
         if (message === '') return [];
         return [
            {
               code: typeof item.code === 'string' ? item.code : 'critic',
               path: typeof item.path === 'string' ? item.path : '/',
               message,
               severity: item.severity === 'error' ? ('error' as const) : ('warning' as const),
            },
         ];
      }),
   };
}

export type { FieldProblem };
