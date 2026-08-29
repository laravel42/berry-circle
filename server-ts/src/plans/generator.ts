import type { Sql } from '../db/pool.ts';
import { readPlan, validatePlan, type Plan, type ValidationReport } from './schema.ts';

/**
 * Turning a sentence into a plan.
 *
 * One model call, not a pipeline. The contract describes a longer one —
 * classifier, planner, repair rounds, critic rounds — and this build does not
 * implement it; `plan_versions` records what was produced and `planner_events`
 * records the one stage that ran, so the shape is there for the rest when it
 * arrives. Saying so plainly is better than a `stage: 'critic'` that never
 * happens.
 *
 * The model is asked for JSON and its answer is *read* rather than trusted:
 * `readPlan` takes whatever shape came back and the deterministic validator
 * decides whether it could be compiled. A model that returns prose, or a plan
 * whose tasks wait on each other in a circle, becomes a plan with errors on it
 * rather than an exception.
 */

const SYSTEM = `You turn a request into a Berry plan: the tasks a team would
create to do it, and the order they depend on each other in.

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

export interface Generated {
   plan: Plan;
   validation: ValidationReport;
   usage: { inputTokens: number; outputTokens: number };
   model: string;
   provider: string;
}

export class PlannerUnavailable extends Error {
   override readonly name = 'PlannerUnavailable';
   constructor(message: string) {
      super(message);
   }
}

export interface PlanGeneratorOptions {
   sql: Sql;
   apiKey: string;
   baseUrl: string;
   defaultModel: string;
   fetch?: typeof globalThis.fetch;
   timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class PlanGenerator {
   readonly #sql: Sql;
   readonly #apiKey: string;
   readonly #baseUrl: string;
   readonly #defaultModel: string;
   readonly #fetch: typeof globalThis.fetch;
   readonly #timeoutMs: number;

   constructor(options: PlanGeneratorOptions) {
      this.#sql = options.sql;
      this.#apiKey = options.apiKey;
      this.#baseUrl = options.baseUrl.replace(/\/$/, '');
      this.#defaultModel = options.defaultModel;
      this.#fetch = options.fetch ?? globalThis.fetch;
      this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
   }

   /**
    * The model provisioned for planning, or the deployment's default.
    *
    * `model_role_agents` is where an operator says which model plans; falling
    * back rather than refusing means a deployment that never filled that table
    * can still plan, which is the more useful failure.
    */
   async role(): Promise<{ provider: string; model: string }> {
      const [row] = await this.#sql`
         SELECT model_provider, model_name FROM model_role_agents
          WHERE role = 'planner' AND status <> 'offline'
          ORDER BY updated_at DESC LIMIT 1`;
      return row
         ? { provider: row.model_provider as string, model: row.model_name as string }
         : { provider: 'openrouter', model: this.#defaultModel };
   }

   async generate(input: { prompt: string; signal?: AbortSignal }): Promise<Generated> {
      const role = await this.role();
      const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
         method: 'POST',
         signal: input.signal ?? AbortSignal.timeout(this.#timeoutMs),
         headers: {
            authorization: `Bearer ${this.#apiKey}`,
            'content-type': 'application/json',
            'x-title': 'Berry',
         },
         body: JSON.stringify({
            model: role.model,
            messages: [
               { role: 'system', content: SYSTEM },
               { role: 'user', content: input.prompt },
            ],
            // Asked for, not relied on: some models ignore it, which is why
            // the answer is still parsed defensively below.
            response_format: { type: 'json_object' },
         }),
      }).catch((cause: unknown) => {
         throw new PlannerUnavailable(`the planner could not be reached: ${String(cause)}`);
      });

      if (!response.ok) {
         const detail = await response.text().catch(() => '');
         throw new PlannerUnavailable(
            `the planner refused the request: ${response.status} ${detail.slice(0, 200)}`
         );
      }

      const body = (await response.json().catch(() => null)) as {
         choices?: Array<{ message?: { content?: unknown } }>;
         usage?: { prompt_tokens?: number; completion_tokens?: number };
      } | null;
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') {
         throw new PlannerUnavailable('the planner returned nothing');
      }

      const { plan, problems } = readPlan(parseJson(content));
      return {
         plan,
         // The reader's problems are seeded into the validator rather than
         // thrown: a plan that came back malformed is a plan with errors a
         // person can see, not a request that failed.
         validation: validatePlan(plan, { seed: problems }),
         usage: {
            inputTokens: Number(body?.usage?.prompt_tokens ?? 0),
            outputTokens: Number(body?.usage?.completion_tokens ?? 0),
         },
         model: role.model,
         provider: role.provider,
      };
   }
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
