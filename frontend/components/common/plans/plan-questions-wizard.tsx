'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
   describePlanFailure,
   type PlanAnswerInput,
   type PlanAssumption,
   type PlanRecord,
} from '@/lib/plans';
import { usePlanStore } from '@/store/plan-store';
import { Check } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

/**
 * The questions the planner could not answer for itself.
 *
 * A blocked plan is not a broken one — Berry raised a question and proposed no
 * tasks because the answer would change what it proposed. Before this existed
 * the only way forward was to reject the plan and retype the prompt with the
 * answer buried in it.
 *
 * Blocking questions come first and must be answered: leaving one would
 * regenerate the same blocked plan, which reads as the wizard having done
 * nothing. The rest follow as skippable, because a guess a person did not
 * correct is a legitimate assumption and the plan already says so.
 */

/** What the wizard is holding for one question before it is submitted. */
interface Draft {
   optionId: string | null;
   text: string;
}

function ordered(assumptions: PlanAssumption[]): PlanAssumption[] {
   // Blocking first, otherwise the order the planner asked in — which is the
   // order it thought about them, and reordering would lose that.
   return [
      ...assumptions.filter((entry) => entry.blocking),
      ...assumptions.filter((entry) => !entry.blocking),
   ];
}

/** Whether this draft is a complete answer to its question. */
function answered(draft: Draft | undefined): boolean {
   if (!draft) return false;
   return draft.optionId !== null || draft.text.trim() !== '';
}

export function PlanQuestionsWizard({
   record,
   open,
   onOpenChange,
}: {
   record: PlanRecord;
   open: boolean;
   onOpenChange: (open: boolean) => void;
}) {
   const answerPlan = usePlanStore((state) => state.answerPlan);
   const questions = useMemo(() => ordered(record.plan?.assumptions ?? []), [record.plan]);

   const [step, setStep] = useState(0);
   const [drafts, setDrafts] = useState<Record<string, Draft>>({});
   const [pending, setPending] = useState(false);

   // Reopening starts over rather than resuming: the questions come from the
   // plan document, and a regeneration replaces it, so a half-finished set of
   // answers could belong to questions that are no longer being asked.
   useEffect(() => {
      if (!open) return;
      setStep(0);
      setDrafts({});
      setPending(false);
   }, [open, record.version]);

   const question = questions[step];
   if (!question) return null;

   const draft = drafts[question.id];
   const last = step === questions.length - 1;
   const canContinue = question.blocking ? answered(draft) : true;

   const set = (next: Partial<Draft>) => {
      setDrafts((current) => ({
         ...current,
         [question.id]: {
            optionId: next.optionId !== undefined ? next.optionId : (current[question.id]?.optionId ?? null),
            text: next.text !== undefined ? next.text : (current[question.id]?.text ?? ''),
         },
      }));
   };

   const submit = async (finalDrafts: Record<string, Draft>) => {
      const answers: PlanAnswerInput[] = [];
      for (const entry of questions) {
         const value = finalDrafts[entry.id];
         if (!answered(value)) continue;
         answers.push(
            value!.optionId
               ? { assumptionId: entry.id, optionId: value!.optionId }
               : { assumptionId: entry.id, text: value!.text.trim() }
         );
      }
      setPending(true);
      try {
         await answerPlan(record.id, answers);
         onOpenChange(false);
         toast.success('Planning again with your answers');
      } catch (error) {
         // The dialog stays open on failure: the answers are still in it, and
         // closing would make a person type them a second time.
         toast.error(describePlanFailure(error));
      } finally {
         setPending(false);
      }
   };

   const advance = (skipped = false) => {
      const next = skipped
         ? Object.fromEntries(Object.entries(drafts).filter(([id]) => id !== question.id))
         : drafts;
      if (skipped) setDrafts(next);
      if (last) {
         void submit(next);
         return;
      }
      setStep((current) => current + 1);
   };

   return (
      <Dialog open={open} onOpenChange={pending ? () => undefined : onOpenChange}>
         <DialogContent className="sm:max-w-lg">
            <DialogHeader>
               <div className="flex items-center gap-2">
                  <BerryMark size="sm" tone="attention" state="hollow" />
                  <DialogTitle>Berry needs an answer</DialogTitle>
               </div>
               <DialogDescription>
                  {questions.length > 1
                     ? `Question ${step + 1} of ${questions.length}${question.blocking ? '' : ' · optional'}`
                     : 'One question, then Berry plans again.'}
               </DialogDescription>
            </DialogHeader>

            <div className="min-w-0">
               <p className="font-medium leading-6">{question.description}</p>

               {question.options.length > 0 && (
                  <ul className="mt-3 space-y-1.5">
                     {question.options.map((option) => {
                        const chosen = draft?.optionId === option.id;
                        return (
                           <li key={option.id}>
                              <button
                                 type="button"
                                 aria-pressed={chosen}
                                 onClick={() => set({ optionId: chosen ? null : option.id, text: '' })}
                                 className={cn(
                                    'flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left',
                                    chosen
                                       ? 'border-primary bg-primary/5'
                                       : 'border-border/60 hover:bg-muted/40'
                                 )}
                              >
                                 <Check
                                    className={cn(
                                       'mt-0.5 size-4 shrink-0',
                                       chosen ? 'opacity-100' : 'opacity-0'
                                    )}
                                 />
                                 <span className="min-w-0 flex-1">
                                    <span className="block leading-6">{option.label}</span>
                                    {option.detail && (
                                       <span className="block text-muted-foreground">
                                          {option.detail}
                                       </span>
                                    )}
                                 </span>
                              </button>
                           </li>
                        );
                     })}
                  </ul>
               )}

               {/* Always offered, never only offered: the planner's options are
                   its best guesses at the shape of the answer, and the one
                   that matters is often the one it did not think of. */}
               <Textarea
                  value={draft?.text ?? ''}
                  onChange={(event) => set({ text: event.target.value, optionId: null })}
                  placeholder={
                     question.options.length > 0 ? 'Or answer in your own words…' : 'Your answer…'
                  }
                  className="mt-3 min-h-20"
               />
            </div>

            <DialogFooter className="sm:justify-between">
               <Button
                  variant="ghost"
                  size="sm"
                  disabled={step === 0 || pending}
                  onClick={() => setStep((current) => current - 1)}
               >
                  Back
               </Button>
               <div className="flex items-center gap-2">
                  {!question.blocking && (
                     <Button variant="ghost" size="sm" disabled={pending} onClick={() => advance(true)}>
                        Skip
                     </Button>
                  )}
                  <Button size="sm" disabled={!canContinue || pending} onClick={() => advance()}>
                     {pending ? 'Planning again…' : last ? 'Plan again' : 'Continue'}
                  </Button>
               </div>
            </DialogFooter>
         </DialogContent>
      </Dialog>
   );
}
