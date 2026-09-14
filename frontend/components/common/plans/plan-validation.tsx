'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { Button } from '@/components/ui/button';
import {
   PLAN_STAGES,
   describeGenerationError,
   describePlanPath,
   describePlanStage,
   type FieldError,
   type PlanRecord,
} from '@/lib/plans';
import { cn } from '@/lib/utils';
import { useCreatePlanStore } from '@/store/create-plan-store';
import { usePlanStore } from '@/store/plan-store';

/**
 * Where generation is, as a stage trail. Repair is skipped when the first
 * draft validates, so a stage the pipeline has passed is only "done" when it
 * sits before the one in flight; nothing is invented for stages it skipped.
 */
export function PlanGenerationProgress({ record }: { record: PlanRecord }) {
   // Still set while generation runs — the plan is only taken once it can
   // actually start — so it says truthfully what happens when this finishes.
   const willAutoStart = usePlanStore((state) => Boolean(state.autoStart[record.id]));
   if (record.generation.status !== 'running') return null;
   const current = record.generation.stage ?? 'intent';
   const currentIndex = PLAN_STAGES.indexOf(current as (typeof PLAN_STAGES)[number]);
   return (
      <div
         role="status"
         aria-live="polite"
         className="mt-5 rounded-md border border-border/60 bg-background px-4 py-3"
      >
         <div className="flex items-center gap-2">
            <BerryMark size="sm" tone="working" pulse />
            <span className="font-medium">Berry is {describePlanStage(current)}</span>
         </div>
         <ol className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
            {PLAN_STAGES.map((stage, index) => {
               const done = currentIndex > index;
               const active = stage === current;
               return (
                  <li
                     key={stage}
                     className={cn(
                        'flex items-center gap-1.5',
                        active && 'text-foreground',
                        !done && !active && 'opacity-60'
                     )}
                     aria-current={active ? 'step' : undefined}
                  >
                     <BerryMark
                        size="sm"
                        tone={done ? 'complete' : active ? 'working' : 'neutral'}
                        state={done || active ? 'solid' : 'hollow'}
                        className="size-3"
                     />
                     {stage}
                  </li>
               );
            })}
         </ol>
         <p className="mt-2 text-muted-foreground">
            Usually a minute or two.{' '}
            {willAutoStart
               ? 'This project is led by the AI workflow, so its tasks are created as soon as the plan is ready.'
               : 'Nothing is created until you press Start Plan.'}
         </p>
      </div>
   );
}

/** Generation ended without a plan, or ran out of repairs. */
export function PlanGenerationFailure({ record }: { record: PlanRecord }) {
   const openCreatePlan = useCreatePlanStore((state) => state.openModal);
   if (record.generation.status !== 'failed') return null;
   // The pipeline keeps the last version it produced. When that version
   // passes validation the server lets it start, so the panel must not tell
   // the person to throw it away.
   const kept = Boolean(record.plan);
   const usable =
      kept && record.validation.status === 'valid' && record.validation.errors.length === 0;
   const consequence = usable
      ? 'The last version Berry produced is shown below and passes validation, so you can still start it, or ask for a new plan.'
      : kept
        ? 'The last attempt is kept below for reference. Ask for a new plan.'
        : 'Nothing was produced. Ask for a new plan.';
   return (
      <div
         role="alert"
         className="mt-5 flex items-start gap-3 rounded-md border border-border/60 bg-background px-4 py-3"
      >
         <BerryMark size="sm" tone={usable ? 'attention' : 'danger'} className="mt-1" />
         <div className="min-w-0 flex-1">
            <p className="font-medium">{describeGenerationError(record.generation.error)}</p>
            <p className="text-muted-foreground">{consequence}</p>
            <div className="mt-2 flex flex-wrap gap-2">
               <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => openCreatePlan({ prompt: record.sourcePrompt ?? undefined })}
               >
                  Plan again
               </Button>
            </div>
         </div>
      </div>
   );
}

/**
 * The questions the planner stopped on, and the way to answer them.
 *
 * The list stays even though the wizard opens itself: it is what the page
 * says when someone comes back to a plan they dismissed the wizard on, and
 * "Berry needs answers" with no visible questions is not a state worth having.
 */
export function PlanBlockedQuestions({
   record,
   onAnswer,
}: {
   record: PlanRecord;
   onAnswer?: () => void;
}) {
   if (record.validation.status !== 'blocked') return null;
   const questions = record.validation.ambiguities.filter((ambiguity) => ambiguity.blocking);
   return (
      <div role="alert" className="mt-5 rounded-md border border-border/60 bg-background px-4 py-3">
         <div className="flex items-center gap-2">
            <BerryMark size="sm" tone="attention" state="hollow" />
            <span className="font-medium">Berry needs a few answers before it can plan this</span>
         </div>
         <ol className="mt-2 list-decimal space-y-1 pl-6">
            {questions.map((ambiguity) => (
               <li key={ambiguity.id}>{ambiguity.question}</li>
            ))}
            {questions.length === 0 && <li>The request is ambiguous.</li>}
         </ol>
         {onAnswer && (
            <div className="mt-3">
               <Button size="xs" onClick={onAnswer}>
                  Answer questions
               </Button>
            </div>
         )}
      </div>
   );
}

function FindingRow({
   finding,
   record,
   tone,
}: {
   finding: FieldError;
   record: PlanRecord;
   tone: 'danger' | 'attention';
}) {
   return (
      <li className="flex items-start gap-3 rounded-md border border-border/60 bg-background px-3 py-2">
         <BerryMark size="sm" tone={tone} className="mt-1" />
         <div className="min-w-0 flex-1">
            <p className="font-medium">{finding.message}</p>
            <p className="text-muted-foreground">
               {describePlanPath(finding.path, record.plan)} · {finding.code}
            </p>
            {finding.hint && <p className="mt-0.5 text-muted-foreground">{finding.hint}</p>}
         </div>
      </li>
   );
}

/**
 * What the validator found. Errors stop Start Plan and are announced;
 * warnings are shown but do not interrupt, since the plan can start with
 * them. The critic's revise-problems are listed as warnings too: they are
 * advice a valid plan is allowed to ignore.
 */
export function PlanFindings({ record }: { record: PlanRecord }) {
   const { warnings } = record.validation;
   // The blocked panel already asks the questions; repeating each as an
   // error row would say the same thing twice on one screen.
   const errors =
      record.validation.status === 'blocked'
         ? record.validation.errors.filter((finding) => finding.code !== 'AMBIGUITY_BLOCKING')
         : record.validation.errors;
   const critic =
      record.critic?.verdict === 'revise'
         ? record.critic.problems.map<FieldError>((problem) => ({ ...problem, hint: null }))
         : [];
   if (errors.length === 0 && warnings.length === 0 && critic.length === 0) return null;
   return (
      <div className="mt-5 space-y-3">
         {errors.length > 0 && (
            <div>
               <h3 className="font-medium text-status-danger">
                  {errors.length === 1 ? '1 problem' : `${errors.length} problems`} to fix
               </h3>
               <ul role="alert" className="mt-1.5 space-y-1.5">
                  {errors.map((finding, index) => (
                     <FindingRow
                        key={`${finding.path}-${finding.code}-${index}`}
                        finding={finding}
                        record={record}
                        tone="danger"
                     />
                  ))}
               </ul>
            </div>
         )}
         {(warnings.length > 0 || critic.length > 0) && (
            <div>
               <h3 className="font-medium">
                  {warnings.length + critic.length === 1
                     ? '1 thing'
                     : `${warnings.length + critic.length} things`}{' '}
                  to know
               </h3>
               <ul role="status" className="mt-1.5 space-y-1.5">
                  {[...warnings, ...critic].map((finding, index) => (
                     <FindingRow
                        key={`${finding.path}-${finding.code}-${index}`}
                        finding={finding}
                        record={record}
                        tone="attention"
                     />
                  ))}
               </ul>
            </div>
         )}
      </div>
   );
}
