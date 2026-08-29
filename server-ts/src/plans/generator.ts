import type { Sql } from '../db/pool.ts';
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

const GENERATE_SYSTEM = `You turn a request into a Berry plan: the tasks a team
would create to do it, and the order they depend on each other in.

Answer with JSON only — no prose, no code fence. The shape is:

{
  "goal": { "tempId": "goal-1", "title": "...", "description": "..." },
  "assumptions": [
    { "id": "a1", "description": "...", "confidence": "low|medium|high", "blocking": false }
  ],
  "issues": [
    { "tempId": "t1", "title": "...", "description": "...",
      "requiredCapabilities": ["typescript"], "dependsOn": ["t2"],
      "requiresReview": false, "requiresApproval": false, "priority": "medium" }
  ],
  "approvals": [
    { "tempId": "ap1", "title": "...", "reason": "...",
      "target": { "kind": "issue", "tempId": "t1" } }
  ]
}

Rules:
- Each task is one piece of work one agent or person could finish. Not
  "build the feature"; not "rename a variable" either.
- \`dependsOn\` names tasks in this plan by \`tempId\`, and never forms a
  circle.
- Set \`requiresApproval\` only where starting the task is a commitment a
  person should make deliberately: deleting data, spending money, or touching
  something outside the repository.
- If the request is too vague to plan, say so with a blocking assumption
  (\`"blocking": true\`) whose description is the question you need answered,
  and propose no tasks.
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

Answer with JSON only:

{ "verdict": "accept" | "revise",
  "problems": [ { "code": "...", "path": "/issues/0", "message": "...",
                  "severity": "error" | "warning" } ] }

Say "revise" only for something a person would actually send back: a task too
big for one agent to finish, a missing step the rest depends on, an ordering
that cannot work, a task that will silently do something destructive. Style,
wording and preference are "accept" with a warning at most.

An empty problem list with "accept" is a good answer, and the common one.`;

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
   apiKey: string;
   baseUrl: string;
   defaultModel: string;
   fetch?: typeof globalThis.fetch;
   timeoutMs?: number;
   /** How many times a document may be sent back to be fixed. */
   maxRepairs?: number;
   /** How many times the critic may ask for a revision. */
   maxCriticRounds?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class PlanGenerator {
   readonly #sql: Sql;
   readonly #apiKey: string;
   readonly #baseUrl: string;
   readonly #defaultModel: string;
   readonly #fetch: typeof globalThis.fetch;
   readonly #timeoutMs: number;
   readonly #maxRepairs: number;
   readonly #maxCriticRounds: number;

   constructor(options: PlanGeneratorOptions) {
      this.#sql = options.sql;
      this.#apiKey = options.apiKey;
      this.#baseUrl = options.baseUrl.replace(/\/$/, '');
      this.#defaultModel = options.defaultModel;
      this.#fetch = options.fetch ?? globalThis.fetch;
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
         : { provider: 'openrouter', model: this.#defaultModel };
   }

   /**
    * The whole pipeline.
    *
    * `onStage` is called as each stage finishes rather than at the end, so a
    * caller can write `generation.stage` and a person watching sees where the
    * plan is instead of a spinner.
    */
   async generate(input: {
      prompt: string;
      signal?: AbortSignal;
      onStage?: (stage: Stage) => void;
   }): Promise<Generated> {
      const stages: StageRecord[] = [];
      const usage = { inputTokens: 0, outputTokens: 0 };

      input.onStage?.('generate');
      const planner = await this.role('planner');
      const first = await this.#call({
         role: 'planner',
         stage: 'generate',
         model: planner,
         system: GENERATE_SYSTEM,
         user: input.prompt,
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
            const repaired = await this.#repair(plan, validation.errors, input.signal);
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
               const reviewed = await this.#critique(plan, input.signal);
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
      plan: Plan,
      problems: Array<{ path: string; code: string; message: string }>,
      signal: AbortSignal | undefined
   ) {
      const role = await this.role('repair');
      const result = await this.#call({
         role: 'repair',
         stage: 'repair',
         model: role,
         system: REPAIR_SYSTEM,
         user: `Plan:\n${JSON.stringify(plan)}\n\nProblems:\n${JSON.stringify(problems)}`,
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

   async #critique(plan: Plan, signal: AbortSignal | undefined) {
      const role = await this.role('critic');
      const result = await this.#call({
         role: 'critic',
         stage: 'critic',
         model: role,
         system: CRITIC_SYSTEM,
         user: JSON.stringify(plan),
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
      role: 'planner' | 'repair' | 'critic';
      stage: Stage;
      model: { provider: string; model: string };
      system: string;
      user: string;
      signal: AbortSignal | undefined;
   }) {
      const started = Date.now();
      const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
         method: 'POST',
         signal: input.signal ?? AbortSignal.timeout(this.#timeoutMs),
         headers: {
            authorization: `Bearer ${this.#apiKey}`,
            'content-type': 'application/json',
            'x-title': 'Berry',
         },
         body: JSON.stringify({
            model: input.model.model,
            messages: [
               { role: 'system', content: input.system },
               { role: 'user', content: input.user },
            ],
            // Asked for, not relied on: some models ignore it, which is why
            // the answer is still parsed defensively below.
            response_format: { type: 'json_object' },
         }),
      }).catch((cause: unknown) => {
         throw new PlannerUnavailable(
            `the ${input.role} could not be reached: ${String(cause)}`,
            input.stage
         );
      });

      if (!response.ok) {
         const detail = await response.text().catch(() => '');
         throw new PlannerUnavailable(
            `the ${input.role} refused the request: ${response.status} ${detail.slice(0, 200)}`,
            input.stage
         );
      }

      const body = (await response.json().catch(() => null)) as {
         choices?: Array<{ message?: { content?: unknown } }>;
         usage?: { prompt_tokens?: number; completion_tokens?: number };
      } | null;
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') {
         throw new PlannerUnavailable(`the ${input.role} returned nothing`, input.stage);
      }

      return {
         json: parseJson(content),
         inputTokens: Number(body?.usage?.prompt_tokens ?? 0),
         outputTokens: Number(body?.usage?.completion_tokens ?? 0),
         durationMs: Date.now() - started,
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

/**
 * JSON out of whatever the model said.
 *
 * Models fence their JSON, prefix it with "Here you go:", or both, however
 * firmly they are told not to. Finding the outermost braces recovers the
 * answer instead of failing a generation over punctuation.
 */
function parseJson(content: string): unknown {
   const direct = tryParse(content);
   if (direct !== undefined) return direct;

   const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
   if (fenced?.[1]) {
      const parsed = tryParse(fenced[1]);
      if (parsed !== undefined) return parsed;
   }

   const start = content.indexOf('{');
   const end = content.lastIndexOf('}');
   if (start >= 0 && end > start) {
      const parsed = tryParse(content.slice(start, end + 1));
      if (parsed !== undefined) return parsed;
   }
   return {};
}

function tryParse(text: string): unknown {
   try {
      return JSON.parse(text.trim());
   } catch {
      return undefined;
   }
}

export type { FieldProblem };
