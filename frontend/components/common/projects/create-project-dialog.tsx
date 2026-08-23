'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { MarkdownTextarea } from '@/components/common/editor/markdown-textarea';
import { ProjectDateSelector } from '@/components/common/projects/create-project/date-selector';
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
import { currentUser } from '@/data/users';
import { BerryApiError } from '@/lib/api';
import { WORKSPACE_NAME } from '@/lib/config';
import { createWorkspaceProject } from '@/lib/projects';
import { useCreateProjectStore } from '@/store/create-project-store';
import { useProjectsStore } from '@/store/projects-store';
import { useSessionStore } from '@/store/session-store';
import { format } from 'date-fns';
import { ChevronRight, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

interface ProjectFormState {
   name: string;
   summary: string;
   description: string;
   status: Status;
   priority: (typeof priorities)[number];
   lead: User;
   startDate?: Date;
   targetDate?: Date;
}

function composeDescription(summary: string, description: string): string | undefined {
   const parts = [summary.trim(), description.trim()].filter(Boolean);
   return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function toIsoDate(date?: Date): string | undefined {
   return date ? format(date, 'yyyy-MM-dd') : undefined;
}

/** Shared create-project dialog — opened from the header or board column "+". */
export function CreateProjectDialog() {
   const workspace = useSessionStore((state) => state.workspace);
   const user = useSessionStore((state) => state.user);
   const addProject = useProjectsStore((state) => state.addProject);
   const { isOpen, defaultStatus, closeModal } = useCreateProjectStore();
   const [pending, setPending] = useState(false);

   const createDefaultForm = useCallback((): ProjectFormState => {
      const lead = user ?? currentUser;
      return {
         name: '',
         summary: '',
         description: '',
         status: defaultStatus ?? defaultProjectCreateStatus.status,
         priority: priorities.find((entry) => entry.id === 'no-priority')!,
         lead,
      };
   }, [user, defaultStatus]);

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
      if (form.startDate && form.targetDate && form.targetDate < form.startDate) {
         toast.error('Target date must be on or after the start date');
         return;
      }
      setPending(true);
      try {
         const project = await createWorkspaceProject({
            workspaceId: workspace.id,
            name: trimmed,
            description: composeDescription(form.summary, form.description),
            statusId: form.status.id,
            priorityId: form.priority.id,
            startDate: toIsoDate(form.startDate),
            targetDate: toIsoDate(form.targetDate),
            lead: form.lead,
         });
         addProject({ ...project, lead: form.lead, status: form.status, priority: form.priority });
         toast.success('Project created');
         closeModal();
      } catch (error) {
         toast.error(error instanceof BerryApiError ? error.message : 'Could not create project');
      } finally {
         setPending(false);
      }
   };

   return (
      <Dialog open={isOpen} onOpenChange={(open) => !open && closeModal()}>
         <DialogContent
            showCloseButton={false}
            className="flex w-full h-[min(42rem,calc(100vh-3.5rem))] flex-col gap-0 p-0 shadow-lg top-[5vh] translate-y-0 sm:max-w-[40rem]"
         >
            <DialogHeader className="px-6 pt-5 pb-0">
               <DialogTitle className="sr-only">New project</DialogTitle>
               <DialogDescription className="sr-only">
                  Name the project, set its properties, and add an optional summary and description.
               </DialogDescription>
               <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
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
                     autoFocus
                     className="h-auto border-none bg-transparent px-0 text-2xl font-medium text-foreground shadow-none placeholder:text-foreground/40 md:text-2xl"
                     placeholder="Project name"
                     value={form.name}
                     onChange={(event) => setForm({ ...form, name: event.target.value })}
                  />

                  <label htmlFor="create-project-summary" className="sr-only">
                     Short summary
                  </label>
                  <Input
                     id="create-project-summary"
                     className="mt-1 h-auto border-none bg-transparent px-0 text-base text-foreground shadow-none placeholder:text-foreground/40 md:text-base"
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
                  </div>

                  <label htmlFor="create-project-description" className="sr-only">
                     Description
                  </label>
                  <MarkdownTextarea
                     id="create-project-description"
                     className="mt-5 min-h-40 flex-1 h-full resize-none border-none bg-transparent px-0 text-base text-foreground shadow-none placeholder:text-foreground/40 md:text-base"
                     placeholder="Write a description or collect the work…"
                     value={form.description}
                     onChange={(description) => setForm({ ...form, description })}
                  />
               </div>

               <DialogFooter className="flex-row items-center justify-end gap-2 border-t px-6 py-3">
                  <Button type="button" variant="ghost" size="sm" onClick={closeModal}>
                     Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={pending || !form.name.trim()}>
                     {pending ? 'Creating…' : 'Create project'}
                  </Button>
               </DialogFooter>
            </form>
         </DialogContent>
      </Dialog>
   );
}
