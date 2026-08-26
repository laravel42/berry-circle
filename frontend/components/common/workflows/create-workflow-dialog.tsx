'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { DescriptionTextarea } from '@/components/common/editor/description-textarea';
import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WORKSPACE_NAME, WORKSPACE_SLUG } from '@/lib/config';
import { loadProviders } from '@/lib/integrations';
import type { FieldError } from '@/lib/plans';
import {
   BERRY_EVENTS,
   createWorkflow,
   definitionFieldErrors,
   describeDefinitionPath,
   describeWorkflowFailure,
} from '@/lib/workflows';
import { cn } from '@/lib/utils';
import { useCreateWorkflowStore } from '@/store/create-workflow-store';
import { useGoalsStore } from '@/store/goals-store';
import { useProvidersStore } from '@/store/providers-store';
import { useSessionStore } from '@/store/session-store';
import { useWorkflowsStore } from '@/store/workflows-store';
import { ChevronRight, Plus, X, Zap } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
   STEP_KINDS,
   StepEditor,
   buildDefinition,
   newStepDraft,
   stepDraftLineProblem,
   stepDraftProblem,
   toTriggerInput,
   triggerInputProblem,
   type SiblingStep,
   type StepDraft,
   type StepKind,
   type TriggerDraft,
} from './create-workflow-steps';
import { IntegrationTriggerFields } from './integration-trigger-fields';
import { ScheduleFields, defaultSchedule } from './schedule-fields';
import { WebhookTriggerNotes } from './webhook-trigger-notes';

const TRIGGERS: { type: TriggerDraft['type']; label: string; hint: string }[] = [
   { type: 'manual', label: 'By hand', hint: 'Run now from the workflow page' },
   {
      type: 'berry_event',
      label: 'A Berry event',
      hint: 'When something happens in this workspace',
   },
   { type: 'schedule', label: 'A schedule', hint: 'Every hour, every day at, or a cron' },
   {
      type: 'integration',
      label: 'An integration event',
      hint: 'GitHub, Slack, Linear… from the catalog',
   },
   { type: 'webhook', label: 'A webhook', hint: 'When a delivery reaches the hook URL' },
];

function newTriggerDraft(): TriggerDraft {
   const schedule = defaultSchedule();
   return {
      type: 'manual',
      event: 'issue.completed',
      cron: schedule.cron,
      timezone: schedule.timezone,
      provider: '',
      operation: '',
   };
}

/**
 * New workflow, trigger first: pick what starts it, then the steps in
 * order. It is saved as a draft — nothing runs until it is activated — and
 * the server's validator has the last word, with its findings shown beside
 * the step they belong to. The prompt-first tab waits for the planner.
 */
export function CreateWorkflowDialog() {
   const router = useRouter();
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const workspace = useSessionStore((state) => state.workspace);
   const status = useSessionStore((state) => state.status);
   const upsertWorkflow = useWorkflowsStore((state) => state.upsertWorkflow);
   const providersLoaded = useProvidersStore((state) => state.loaded);
   const hydrateProviders = useProvidersStore((state) => state.hydrateProviders);
   const goals = useGoalsStore((state) => state.goals);
   const { isOpen, prefill, closeModal } = useCreateWorkflowStore();

   const [name, setName] = useState('');
   const [description, setDescription] = useState('');
   const [trigger, setTrigger] = useState<TriggerDraft>(() => newTriggerDraft());
   const [steps, setSteps] = useState<StepDraft[]>([]);
   const [pending, setPending] = useState(false);
   const [serverErrors, setServerErrors] = useState<FieldError[]>([]);

   useEffect(() => {
      if (!isOpen) return;
      setName(prefill.name ?? '');
      setDescription('');
      setTrigger(newTriggerDraft());
      setSteps([newStepDraft('create_issue')]);
      setPending(false);
      setServerErrors([]);
   }, [isOpen, prefill]);

   useEffect(() => {
      if (!isOpen || providersLoaded || status !== 'ready' || !workspace) return;
      let cancelled = false;
      void loadProviders(workspace.id).then((providers) => {
         if (!cancelled) hydrateProviders(providers);
      });
      return () => {
         cancelled = true;
      };
   }, [isOpen, providersLoaded, status, workspace, hydrateProviders]);

   const goal = prefill.goalId
      ? goals.find((candidate) => candidate.id === prefill.goalId)
      : undefined;

   const updateStep = (key: string, patch: Partial<StepDraft>) =>
      setSteps((current) =>
         current.map((step) => (step.key === key ? { ...step, ...patch } : step))
      );
   const removeStep = (key: string) =>
      setSteps((current) => current.filter((step) => step.key !== key));
   const moveStep = (key: string, direction: -1 | 1) =>
      setSteps((current) => {
         const index = current.findIndex((step) => step.key === key);
         const target = index + direction;
         if (index < 0 || target < 0 || target >= current.length) return current;
         const next = current.slice();
         [next[index], next[target]] = [next[target], next[index]];
         return next;
      });
   const addStep = (type: StepKind) => setSteps((current) => [...current, newStepDraft(type)]);

   /** The steps after one, as a branch may lead to them. */
   const siblingsAfter = (index: number): SiblingStep[] =>
      steps.slice(index + 1).map((step, offset) => ({
         key: step.key,
         label: `${index + offset + 2} · ${
            STEP_KINDS.find((kind) => kind.type === step.type)?.label ?? step.type
         }`,
      }));

   const submit = async () => {
      const trimmed = name.trim();
      if (!trimmed) {
         toast.error('Give the workflow a name');
         return;
      }
      if (!workspace) {
         toast.error('Workspace is not ready');
         return;
      }
      const triggerProblem = triggerInputProblem(toTriggerInput(trigger));
      if (triggerProblem) {
         toast.error(`Trigger: ${triggerProblem}`);
         return;
      }
      if (steps.length === 0) {
         toast.error('Add at least one step');
         return;
      }
      for (const [index, step] of steps.entries()) {
         const problem = stepDraftProblem(step) ?? stepDraftLineProblem(step);
         if (problem) {
            toast.error(`Step ${index + 1}: ${problem}`);
            return;
         }
      }
      setPending(true);
      setServerErrors([]);
      try {
         const workflow = await createWorkflow({
            workspaceId: workspace.id,
            name: trimmed,
            description: description.trim() || undefined,
            goalId: prefill.goalId,
            projectId: prefill.projectId,
            definition: buildDefinition(trigger, steps),
         });
         upsertWorkflow(workflow);
         toast.success('Workflow created as a draft');
         closeModal();
         router.push(`/${orgId}/workflow/${workflow.id}/overview`);
      } catch (error) {
         const fields = definitionFieldErrors(error);
         if (fields.length > 0) setServerErrors(fields);
         toast.error(describeWorkflowFailure(error));
      } finally {
         setPending(false);
      }
   };

   const errorsFor = (index: number) =>
      serverErrors.filter((error) => {
         const where = describeDefinitionPath(error.path);
         return where.scope === 'step' && where.stepIndex === index;
      });
   const otherErrors = serverErrors.filter((error) => {
      const where = describeDefinitionPath(error.path);
      return where.scope !== 'step' || where.stepIndex === null;
   });

   return (
      <Dialog open={isOpen} onOpenChange={(open) => !open && closeModal()}>
         <DialogContent
            showCloseButton={false}
            className="flex w-full h-[min(46rem,calc(100vh-3.5rem))] flex-col gap-0 p-0 shadow-lg top-[5vh] translate-y-0 sm:max-w-[52rem]"
         >
            <DialogHeader className="px-6 pt-5 pb-0">
               <DialogTitle className="sr-only">New workflow</DialogTitle>
               <DialogDescription className="sr-only">
                  Name the workflow, choose what starts it, and add the steps it runs. It is saved
                  as a draft and runs nothing until you activate it.
               </DialogDescription>
               <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                     <BerryMark size="sm" />
                     <span className="font-medium text-foreground">{WORKSPACE_NAME}</span>
                     <ChevronRight className="size-3.5 shrink-0" />
                     {goal && (
                        <>
                           <span className="truncate">{goal.title}</span>
                           <ChevronRight className="size-3.5 shrink-0" />
                        </>
                     )}
                     <span className="truncate">New workflow</span>
                  </div>
                  <Button
                     type="button"
                     variant="ghost"
                     size="icon"
                     className="size-8 shrink-0"
                     aria-label="Close"
                     onClick={closeModal}
                  >
                     <X className="size-4" />
                  </Button>
               </div>
            </DialogHeader>

            <form
               className="flex min-h-0 flex-1 flex-col"
               onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
               }}
            >
               <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-5 pb-4">
                  <label htmlFor="create-workflow-name" className="sr-only">
                     Workflow name
                  </label>
                  <Input
                     id="create-workflow-name"
                     data-heading="h1"
                     autoFocus
                     className="h-auto border-none bg-transparent px-0 font-medium text-foreground shadow-none placeholder:text-foreground/40"
                     placeholder="Workflow name"
                     value={name}
                     onChange={(event) => setName(event.target.value)}
                  />
                  <DescriptionTextarea
                     data-heading="h3"
                     aria-label="Workflow description"
                     placeholder="What does it do, in a sentence?"
                     value={description}
                     onChange={setDescription}
                     className="mt-1 min-h-12"
                  />

                  <Tabs value="trigger" className="mt-4">
                     <TabsList>
                        <TabsTrigger value="trigger">Start from a trigger</TabsTrigger>
                        <TabsTrigger value="prompt" disabled title="Arrives with the planner phase">
                           Describe it
                        </TabsTrigger>
                     </TabsList>
                  </Tabs>

                  <section className="mt-4">
                     <h3 className="flex items-center gap-1.5 font-medium">
                        <Zap className="size-3.5 text-muted-foreground" />
                        Starts when
                     </h3>
                     <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {TRIGGERS.map((option) => {
                           const on = trigger.type === option.type;
                           return (
                              <button
                                 key={option.type}
                                 type="button"
                                 aria-pressed={on}
                                 onClick={() => setTrigger({ ...trigger, type: option.type })}
                                 className={cn(
                                    'flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors',
                                    on
                                       ? 'border-foreground/40 bg-accent/60'
                                       : 'border-border/60 bg-background hover:bg-accent/40'
                                 )}
                              >
                                 <span className="font-medium">{option.label}</span>
                                 <span className="text-muted-foreground">{option.hint}</span>
                              </button>
                           );
                        })}
                     </div>
                     {trigger.type === 'berry_event' && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                           <span className="text-muted-foreground">When</span>
                           <Select
                              value={trigger.event}
                              onValueChange={(event) => setTrigger({ ...trigger, event })}
                           >
                              <SelectTrigger className="h-8 w-72">
                                 <SelectValue placeholder="Pick an event" />
                              </SelectTrigger>
                              <SelectContent>
                                 {BERRY_EVENTS.map((entry) => (
                                    <SelectItem key={entry.topic} value={entry.topic}>
                                       {entry.label}
                                    </SelectItem>
                                 ))}
                              </SelectContent>
                           </Select>
                           <code className="font-mono text-muted-foreground">{trigger.event}</code>
                        </div>
                     )}
                     {trigger.type === 'schedule' && (
                        <div className="mt-3 rounded-md border border-border/60 bg-background px-4 py-3">
                           <ScheduleFields
                              value={{ cron: trigger.cron, timezone: trigger.timezone }}
                              onChange={(value) =>
                                 setTrigger({
                                    ...trigger,
                                    cron: value.cron,
                                    timezone: value.timezone,
                                 })
                              }
                           />
                        </div>
                     )}
                     {trigger.type === 'integration' && (
                        <div className="mt-3 rounded-md border border-border/60 bg-background px-4 py-3">
                           <IntegrationTriggerFields
                              value={{ provider: trigger.provider, operation: trigger.operation }}
                              onChange={(value) =>
                                 setTrigger({
                                    ...trigger,
                                    provider: value.provider,
                                    operation: value.operation,
                                 })
                              }
                           />
                        </div>
                     )}
                     {trigger.type === 'webhook' && (
                        <WebhookTriggerNotes className="mt-3 rounded-md border border-border/60 bg-background px-4 py-3" />
                     )}
                     {trigger.type === 'manual' && (
                        <p className="mt-2 text-muted-foreground">
                           Only Run now starts it. Good for trying steps before wiring a trigger.
                        </p>
                     )}
                  </section>

                  <section className="mt-6">
                     <div className="flex items-center justify-between gap-3">
                        <h3 className="font-medium">
                           Then
                           <span className="ml-1.5 text-muted-foreground">· {steps.length}</span>
                        </h3>
                        <DropdownMenu>
                           <DropdownMenuTrigger asChild>
                              <Button type="button" size="xs" variant="secondary">
                                 <Plus className="size-3.5" />
                                 Add step
                              </Button>
                           </DropdownMenuTrigger>
                           <DropdownMenuContent align="end" className="min-w-56">
                              {STEP_KINDS.map((kind) => (
                                 <DropdownMenuItem
                                    key={kind.type}
                                    onClick={() => addStep(kind.type)}
                                 >
                                    <span className="flex flex-col">
                                       <span>{kind.label}</span>
                                       <span className="text-muted-foreground">{kind.hint}</span>
                                    </span>
                                 </DropdownMenuItem>
                              ))}
                           </DropdownMenuContent>
                        </DropdownMenu>
                     </div>
                     {steps.length === 0 ? (
                        <p className="mt-2 rounded-md border border-dashed border-border px-4 py-6 text-center text-muted-foreground">
                           No steps yet. Add the first one.
                        </p>
                     ) : (
                        <ol className="mt-2 flex flex-col gap-2">
                           {steps.map((step, index) => (
                              <StepEditor
                                 key={step.key}
                                 step={step}
                                 index={index}
                                 count={steps.length}
                                 errors={errorsFor(index)}
                                 siblings={siblingsAfter(index)}
                                 onChange={(patch) => updateStep(step.key, patch)}
                                 onRemove={() => removeStep(step.key)}
                                 onMove={(direction) => moveStep(step.key, direction)}
                              />
                           ))}
                        </ol>
                     )}
                     {steps.length > 1 && (
                        <p className="mt-2 text-muted-foreground">
                           Steps run in order. An If step lets the next one run only when its check
                           passes; a Switch sends the run to the step each case names, or the next
                           one; a For each repeats the steps you tick, then carries on. The canvas
                           can rewire any of it later.
                        </p>
                     )}
                  </section>

                  {otherErrors.length > 0 && (
                     <ul className="mt-4 flex flex-col gap-1" role="alert">
                        {otherErrors.map((error, index) => (
                           <li key={`${error.path}-${index}`} className="text-status-danger">
                              {error.message}
                              <span className="text-muted-foreground"> · {error.path}</span>
                           </li>
                        ))}
                     </ul>
                  )}
               </div>

               <DialogFooter className="flex-row items-center justify-between gap-2 border-t px-6 py-3">
                  <span className="text-muted-foreground">
                     Saved as a draft. Nothing runs until you activate it.
                  </span>
                  <div className="flex items-center gap-2">
                     <Button type="button" variant="ghost" size="sm" onClick={closeModal}>
                        Cancel
                     </Button>
                     <Button type="submit" size="sm" disabled={pending || !name.trim()}>
                        {pending ? 'Creating…' : 'Create workflow'}
                     </Button>
                  </div>
               </DialogFooter>
            </form>
         </DialogContent>
      </Dialog>
   );
}
