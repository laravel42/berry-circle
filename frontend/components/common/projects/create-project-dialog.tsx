'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { DescriptionTextarea } from '@/components/common/editor/description-textarea';
import { ProjectDateSelector } from '@/components/common/projects/create-project/date-selector';
import { RepositoryPicker } from '@/components/common/projects/repository-selector';
import { AutoGateToggle } from '@/components/common/plans/auto-gate-toggle';
import { isAiWorkflow } from '@/components/common/projects/create-project/ai-workflow';
import { ProjectLeadSelector } from '@/components/common/projects/create-project/lead-selector';
import { ProjectPrioritySelector } from '@/components/common/projects/create-project/priority-selector';
import { defaultProjectCreateStatus } from '@/components/common/projects/create-project/project-status-options';
import { ProjectStatusSelector } from '@/components/common/projects/create-project/status-selector';
import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { priorities } from '@/data/priorities';
import type { Status } from '@/data/status';
import type { User } from '@/data/users';
import { BerryApiError } from '@/lib/api';
import { WORKSPACE_NAME, WORKSPACE_SLUG } from '@/lib/config';
import { describePlanFailure, generatePlan } from '@/lib/plans';
import { createWorkspaceProject } from '@/lib/projects';
import { usePlanStore } from '@/store/plan-store';
import { useCreateProjectStore } from '@/store/create-project-store';
import { useProjectsStore } from '@/store/projects-store';
import { useSessionStore } from '@/store/session-store';
import { format } from 'date-fns';
import { ChevronRight, Sparkles, X } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

interface ProjectFormState {
   name: string;
   summary: string;
   description: string;
   status: Status;
   priority: (typeof priorities)[number];
   /** Undefined until chosen — the lead decides whether Berry plans this. */
   lead?: User;
   /** Only meaningful while the lead is the AI workflow. */
   autoGate: boolean;
   startDate?: Date;
   targetDate?: Date;
   /** owner/name, or undefined for a project that delivers nowhere yet. */
   githubRepo?: string;
}

function composeDescription(summary: string, description: string): string | undefined {
   const parts = [summary.trim(), description.trim()].filter(Boolean);
   return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function toIsoDate(date?: Date): string | undefined {
   return date ? format(date, 'yyyy-MM-dd') : undefined;
}

/** What Berry is asked to plan: everything the person wrote, in order. */
function planPrompt(form: ProjectFormState): string {
   return [form.name.trim(), form.summary.trim(), form.description.trim()]
      .filter(Boolean)
      .join('\n\n');
}

/** Shared create-project dialog — opened from the header or board column "+". */
export function CreateProjectDialog() {
   const router = useRouter();
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const workspace = useSessionStore((state) => state.workspace);
   const boardId = useSessionStore((state) => state.boardId);
   const addProject = useProjectsStore((state) => state.addProject);
   const upsertPlanRecord = usePlanStore((state) => state.upsertRecord);
   const markAutoStart = usePlanStore((state) => state.markAutoStart);
   const { isOpen, defaultStatus, closeModal } = useCreateProjectStore();
   const [pending, setPending] = useState(false);

   // No lead is chosen for the person: who runs a project is the decision this
   // dialog exists to take, and defaulting it to whoever opened the dialog
   // hides the option that makes Berry run it.
   const createDefaultForm = useCallback(
      (): ProjectFormState => ({
         name: '',
         summary: '',
         description: '',
         status: defaultStatus ?? defaultProjectCreateStatus.status,
         priority: priorities.find((entry) => entry.id === 'no-priority')!,
         autoGate: false,
      }),
      [defaultStatus]
   );

   const [form, setForm] = useState<ProjectFormState>(createDefaultForm);

   useEffect(() => {
      if (isOpen) {
         setForm(createDefaultForm());
      }
   }, [isOpen, createDefaultForm]);

   const createProject = async () => {
      const trimmed = form.name.trim();
      if (!trimmed) {
         toast.error('Project name is required');
         return;
      }
      if (!workspace) {
         toast.error('Workspace is not ready');
         return;
      }
      const lead = form.lead;
      if (!lead) {
         toast.error('Choose who leads this project');
         return;
      }
      if (form.startDate && form.targetDate && form.targetDate < form.startDate) {
         toast.error('Target date must be on or after the start date');
         return;
      }
      setPending(true);
      let project;
      try {
         project = await createWorkspaceProject({
            workspaceId: workspace.id,
            name: trimmed,
            description: composeDescription(form.summary, form.description),
            statusId: form.status.id,
            priorityId: form.priority.id,
            startDate: toIsoDate(form.startDate),
            targetDate: toIsoDate(form.targetDate),
            githubRepo: form.githubRepo,
            lead,
         });
         addProject({ ...project, lead, status: form.status, priority: form.priority });
      } catch (error) {
         toast.error(error instanceof BerryApiError ? error.message : 'Could not create project');
         setPending(false);
         return;
      }

      if (!isAiWorkflow(lead)) {
         toast.success('Project created');
         setPending(false);
         closeModal();
         return;
      }

      // Berry leads it, so creating the project is the same act as asking for
      // the plan. The project exists either way, which is why this failure is
      // reported as planning failing rather than creation failing.
      try {
         const record = await generatePlan({
            workspaceId: workspace.id,
            prompt: planPrompt(form),
            projectId: project.id,
            boardId: boardId ?? undefined,
            autoGate: form.autoGate,
         });
         upsertPlanRecord(record);
         // Berry leads it, so it does not stop at a proposal: the preview
         // starts the plan itself once generation finishes, which is what
         // turns it into tasks.
         markAutoStart(record.id);
         closeModal();
         router.push(`/${orgId}/plan/${record.id}`);
      } catch (error) {
         toast.error(`Project created, but planning failed. ${describePlanFailure(error)}`);
         closeModal();
      } finally {
         setPending(false);
      }
   };

   return (
      <Dialog open={isOpen} onOpenChange={(open) => !open && closeModal()}>
         <DialogContent
            showCloseButton={false}
            className="flex w-full h-[min(42rem,calc(100vh-3.5rem))] flex-col gap-0 p-0 shadow-lg top-[5vh] translate-y-0 sm:max-w-[52rem]"
         >
            <DialogHeader className="px-6 pt-5 pb-0">
               <DialogTitle className="sr-only">New project</DialogTitle>
               <DialogDescription className="sr-only">
                  Name the project, set its properties, and add an optional summary and description.
               </DialogDescription>
               <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                     <BerryMark size="sm" />
                     <span className="font-medium text-foreground">{WORKSPACE_NAME}</span>
                     <ChevronRight className="size-3.5 shrink-0" />
                     <span className="truncate">New project</span>
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
                  void createProject();
               }}
            >
               <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-5 pb-4">
                  <label htmlFor="create-project-name" className="sr-only">
                     Project name
                  </label>
                  <Input
                     id="create-project-name"
                     data-heading="h1"
                     autoFocus
                     className="h-auto border-none bg-transparent px-0 font-medium text-foreground shadow-none placeholder:text-foreground/40"
                     placeholder="Project name"
                     value={form.name}
                     onChange={(event) => setForm({ ...form, name: event.target.value })}
                  />

                  <label htmlFor="create-project-summary" className="sr-only">
                     Short summary
                  </label>
                  <Input
                     id="create-project-summary"
                     data-heading="h3"
                     className="mt-1 h-auto border-none bg-transparent px-0 text-foreground shadow-none placeholder:text-foreground/40"
                     placeholder="Add a short summary…"
                     value={form.summary}
                     onChange={(event) => setForm({ ...form, summary: event.target.value })}
                  />

                  <div className="mt-4 flex flex-wrap items-center gap-1.5">
                     <ProjectStatusSelector
                        status={form.status}
                        onChange={(status) => setForm({ ...form, status })}
                     />
                     <ProjectPrioritySelector
                        priority={form.priority}
                        onChange={(priority) => setForm({ ...form, priority })}
                     />
                     <ProjectLeadSelector
                        lead={form.lead}
                        onChange={(lead) => setForm({ ...form, lead })}
                     />
                     {/* Only Berry can be told to skip the human review, so the
                         control appears with the lead that makes it mean
                         something rather than sitting greyed out beside it. */}
                     {isAiWorkflow(form.lead) && (
                        <AutoGateToggle
                           enabled={form.autoGate}
                           onChange={(autoGate) => setForm({ ...form, autoGate })}
                        />
                     )}
                     <ProjectDateSelector
                        label="Start"
                        date={form.startDate}
                        onChange={(startDate) => setForm({ ...form, startDate })}
                     />
                     <ProjectDateSelector
                        label="Target"
                        date={form.targetDate}
                        onChange={(targetDate) => setForm({ ...form, targetDate })}
                     />
                     {/* Held in form state rather than saved on selection: the
                         project does not exist yet, so there is nothing to link
                         until it is created. Styled like the sibling chips; the
                         width cap makes a long repository name truncate instead
                         of wrapping the property row. */}
                     <RepositoryPicker
                        value={form.githubRepo}
                        placeholder="Repository"
                        variant="secondary"
                        size="xs"
                        className="max-w-56"
                        onSelect={(githubRepo) =>
                           setForm({ ...form, githubRepo: githubRepo ?? undefined })
                        }
                     />
                  </div>

                  <label htmlFor="create-project-description" className="sr-only">
                     Description
                  </label>
                  <div className="mt-5 min-h-40 flex-1">
                     <DescriptionTextarea
                        data-heading="h3"
                        value={form.description}
                        onChange={(description) => setForm({ ...form, description })}
                        placeholder="Write a description or collect the work…"
                        aria-label="Project description"
                        className="min-h-40"
                     />
                  </div>
               </div>

               <DialogFooter className="flex-row items-center justify-end gap-2 border-t px-6 py-3">
                  <Button type="button" variant="ghost" size="sm" onClick={closeModal}>
                     Cancel
                  </Button>
                  <Button
                     type="submit"
                     size="sm"
                     disabled={pending || !form.name.trim() || !form.lead}
                  >
                     {isAiWorkflow(form.lead) ? (
                        <>
                           <Sparkles className="size-4" />
                           {pending ? 'Planning…' : 'Create & plan'}
                        </>
                     ) : (
                        <>{pending ? 'Creating…' : 'Create project'}</>
                     )}
                  </Button>
               </DialogFooter>
            </form>
         </DialogContent>
      </Dialog>
   );
}
