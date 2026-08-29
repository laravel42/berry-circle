'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { DescriptionTextarea } from '@/components/common/editor/description-textarea';
import { ProjectSelector } from '@/components/layout/sidebar/create-new-issue/project-selector';
import { AutoGateToggle } from './auto-gate-toggle';
import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import type { Project } from '@/data/projects';
import { WORKSPACE_NAME, WORKSPACE_SLUG } from '@/lib/config';
import { describePlanFailure, generatePlan } from '@/lib/plans';
import { useCreatePlanStore } from '@/store/create-plan-store';
import { usePlanStore } from '@/store/plan-store';
import { useProjectsStore } from '@/store/projects-store';
import { useSessionStore } from '@/store/session-store';
import { ChevronRight, Sparkles, X } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

/**
 * The unified prompt: "What do you want to accomplish?"
 *
 * Berry decides server-side what tasks the answer needs,
 * so the dialog asks one question and nothing else beyond an optional
 * project. Submitting opens the plan preview, where the person sees what
 * Berry proposes before anything exists.
 */
export function CreatePlanDialog() {
   const router = useRouter();
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const workspace = useSessionStore((state) => state.workspace);
   const boardId = useSessionStore((state) => state.boardId);
   const projects = useProjectsStore((state) => state.projects);
   const upsertRecord = usePlanStore((state) => state.upsertRecord);
   const { isOpen, prefill, closeModal } = useCreatePlanStore();

   const [prompt, setPrompt] = useState('');
   const [project, setProject] = useState<Project | undefined>();
   const [autoGate, setAutoGate] = useState(false);
   const [pending, setPending] = useState(false);
   const promptRef = useRef<HTMLDivElement>(null);

   useEffect(() => {
      if (!isOpen) return;
      setPrompt(prefill.prompt ?? '');
      setProject(
         prefill.projectId
            ? projects.find((candidate) => candidate.id === prefill.projectId)
            : undefined
      );
      setAutoGate(false);
      setPending(false);
      // `projects` is read once when the dialog opens; a later hydration
      // must not reset what the person typed.
      // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [isOpen, prefill]);

   const submit = async () => {
      const trimmed = prompt.trim();
      if (!trimmed) {
         toast.error('Say what you want to accomplish');
         return;
      }
      if (!workspace) {
         toast.error('Workspace is not ready');
         return;
      }
      setPending(true);
      try {
         const record = await generatePlan({
            workspaceId: workspace.id,
            prompt: trimmed,
            goalId: prefill.goalId,
            projectId: project?.id,
            boardId: boardId ?? undefined,
            hint: prefill.hint,
            autoGate,
         });
         upsertRecord(record);
         closeModal();
         router.push(`/${orgId}/plan/${record.id}`);
      } catch (error) {
         toast.error(describePlanFailure(error));
      } finally {
         setPending(false);
      }
   };

   return (
      <Dialog open={isOpen} onOpenChange={(open) => !open && closeModal()}>
         <DialogContent
            showCloseButton={false}
            className="flex w-full flex-col gap-0 p-0 shadow-lg top-[22%] translate-y-0 sm:max-w-[52rem]"
            onOpenAutoFocus={(event) => {
               event.preventDefault();
               promptRef.current?.querySelector('textarea')?.focus();
            }}
         >
            <DialogHeader className="px-6 pt-5 pb-0">
               <DialogTitle className="sr-only">New plan</DialogTitle>
               <DialogDescription className="sr-only">
                  Describe what you want to accomplish. Berry proposes the tasks and
                  approvals it would take, and nothing starts until you approve the plan.
               </DialogDescription>
               <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                     <BerryMark size="sm" />
                     <span className="font-medium text-foreground">{WORKSPACE_NAME}</span>
                     <ChevronRight className="size-3.5 shrink-0" />
                     <span className="truncate">New plan</span>
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
               onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                     event.preventDefault();
                     void submit();
                  }
               }}
            >
               <div className="space-y-1 px-6 pt-4 pb-4">
                  <div ref={promptRef}>
                     <DescriptionTextarea
                        data-heading="h2"
                        aria-label="What do you want to accomplish?"
                        placeholder="What do you want to accomplish?"
                        value={prompt}
                        onChange={setPrompt}
                        className="min-h-28 placeholder:text-foreground/40"
                     />
                  </div>
                  <p className="text-muted-foreground">
                     Berry turns this into tasks and approvals you review before anything
                     starts.
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5 pt-3">
                     <ProjectSelector project={project} onChange={setProject} />
                     <AutoGateToggle enabled={autoGate} onChange={setAutoGate} />
                  </div>
               </div>

               <DialogFooter className="flex-row items-center justify-between gap-2 border-t px-6 py-3">
                  <span className="text-muted-foreground">⌘↵ to plan</span>
                  <div className="flex items-center gap-2">
                     <Button type="button" variant="ghost" size="sm" onClick={closeModal}>
                        Cancel
                     </Button>
                     <Button type="submit" size="sm" disabled={pending || !prompt.trim()}>
                        <Sparkles className="size-4" />
                        {pending ? 'Planning…' : 'Plan it'}
                     </Button>
                  </div>
               </DialogFooter>
            </form>
         </DialogContent>
      </Dialog>
   );
}
