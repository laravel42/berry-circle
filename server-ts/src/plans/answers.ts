import type { Sql } from '../db/pool.ts';
import type { AnsweredQuestion } from './generator.ts';
import type { Plan, PlanAssumption } from './schema.ts';

/**
 * Answers to the questions a plan was blocked on.
 *
 * A blocked plan is not a broken one — the planner raised a question it could
 * not answer for itself. This is the record of what was asked, what was
 * answered, and who answered it, kept outside `plans.ir` because answering
 * regenerates the plan and regeneration replaces the IR.
 *
 * The rows are the input to the next generation and the audit trail of why it
 * came out differently, which is the same fact read two ways.
 */

export interface PlanAnswer {
   assumptionId: string;
   question: string;
   answer: string;
   chosenOption: string | null;
   forVersion: number;
   answeredBy: string;
   answeredAt: string;
}

/** One answer as it arrives from a client, before it is checked against the plan. */
export interface SubmittedAnswer {
   assumptionId: string;
   /** The option picked, or null when the answer was typed. */
   optionId?: string | null;
   /** Free text, required when no option was picked. */
   text?: string | null;
}

export class UnknownQuestion extends Error {
   override readonly name = 'UnknownQuestion';
   readonly assumptionId: string;
   constructor(assumptionId: string) {
      super(`This plan is not asking "${assumptionId}".`);
      this.assumptionId = assumptionId;
   }
}

export class UnansweredQuestion extends Error {
   override readonly name = 'UnansweredQuestion';
   readonly assumptionId: string;
   constructor(assumptionId: string) {
      super(`"${assumptionId}" has no answer.`);
      this.assumptionId = assumptionId;
   }
}

const MAX_ANSWER = 4_000;

/**
 * Turns what a client submitted into what will be stored.
 *
 * Resolved against the plan rather than trusted: the answer text for a picked
 * option is the option's own label, taken from the document, so a client
 * cannot record that someone chose "nightly batch" while the plan is told
 * "real-time". The typed case is the only one whose words come from outside,
 * and it is the case where they should.
 */
export function resolveAnswers(
   plan: Plan,
   submitted: SubmittedAnswer[]
): Array<{ assumption: PlanAssumption; answer: string; chosenOption: string | null }> {
   const byId = new Map(plan.assumptions.map((assumption) => [assumption.id, assumption]));
   const resolved = [];
   const seen = new Set<string>();

   for (const entry of submitted) {
      const assumption = byId.get(entry.assumptionId);
      if (!assumption) throw new UnknownQuestion(entry.assumptionId);
      // A question answered twice in one submission is a client bug, and
      // taking the last would silently discard the other.
      if (seen.has(assumption.id)) throw new UnknownQuestion(entry.assumptionId);
      seen.add(assumption.id);

      const optionId = (entry.optionId ?? '').trim();
      if (optionId) {
         const option = assumption.options.find((candidate) => candidate.id === optionId);
         if (!option) throw new UnknownQuestion(entry.assumptionId);
         resolved.push({
            assumption,
            // The label, plus its detail: the detail is what distinguishes two
            // options a planner deliberately worded alike, and dropping it
            // here would hand the planner back a thinner answer than the
            // person gave.
            answer: option.detail ? `${option.label} — ${option.detail}` : option.label,
            chosenOption: option.id,
         });
         continue;
      }

      const typed = (entry.text ?? '').trim().slice(0, MAX_ANSWER);
      if (typed === '') throw new UnansweredQuestion(entry.assumptionId);
      resolved.push({ assumption, answer: typed, chosenOption: null });
   }

   return resolved;
}

/**
 * Every blocking question this plan is waiting on that was not answered.
 *
 * Skipping an optional question is a legitimate answer — the assumption simply
 * stands. Skipping a blocking one is not, because the plan would regenerate
 * into the same blocked state and look like the wizard did nothing.
 */
export function unansweredBlockers(plan: Plan, answeredIds: Set<string>): PlanAssumption[] {
   return plan.assumptions.filter(
      (assumption) => assumption.blocking && !answeredIds.has(assumption.id)
   );
}

export class PlanAnswerRepository {
   readonly #sql: Sql;

   constructor(sql: Sql) {
      this.#sql = sql;
   }

   /**
    * Stores a round of answers.
    *
    * `ON CONFLICT DO NOTHING` against `plan_answers_round_key`: a resubmitted
    * round — a double-clicked wizard, a retried request — is the same answers
    * arriving twice, and must not become two rows the planner then reads as
    * contradicting itself.
    */
   async record(input: {
      workspaceId: string;
      planId: string;
      forVersion: number;
      answeredBy: string;
      answers: Array<{ assumption: PlanAssumption; answer: string; chosenOption: string | null }>;
   }): Promise<void> {
      if (input.answers.length === 0) return;
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         for (const entry of input.answers) {
            await tx`
               INSERT INTO plan_answers (workspace_id, plan_id, assumption_id, question, answer,
                                         chosen_option, answered_by, for_version)
               VALUES (${input.workspaceId}, ${input.planId}, ${entry.assumption.id},
                       ${entry.assumption.description || entry.assumption.id},
                       ${entry.answer}, ${entry.chosenOption},
                       ${input.answeredBy}, ${input.forVersion})
               ON CONFLICT (plan_id, for_version, assumption_id) DO NOTHING`;
         }
      });
   }

   /** Every answer this plan has been given, oldest first. */
   async list(planId: string): Promise<PlanAnswer[]> {
      const rows = await this.#sql`
         SELECT assumption_id, question, answer, chosen_option, for_version,
                answered_by, answered_at
           FROM plan_answers WHERE plan_id = ${planId}
          ORDER BY answered_at ASC, assumption_id ASC`;
      return rows.map((row) => ({
         assumptionId: row.assumption_id as string,
         question: row.question as string,
         answer: row.answer as string,
         chosenOption: (row.chosen_option as string | null) ?? null,
         forVersion: Number(row.for_version),
         answeredBy: row.answered_by as string,
         answeredAt: row.answered_at as string,
      }));
   }

   /** What the planner is shown: the questions and their answers, nothing else. */
   async forPrompt(planId: string): Promise<AnsweredQuestion[]> {
      const answers = await this.list(planId);
      return answers.map((entry) => ({ question: entry.question, answer: entry.answer }));
   }
}
