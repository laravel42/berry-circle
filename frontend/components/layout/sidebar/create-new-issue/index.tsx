'use client';

import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogHeader,
   DialogTitle,
   DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { MarkdownTextarea } from '@/components/common/editor/markdown-textarea';
import { BerryMark } from '@/components/brand/berry-mark';
import { RiEditLine } from '@remixicon/react';
import { ChevronRight, Sparkles, X } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { Issue } from '@/data/issues';
import { priorities } from '@/data/priorities';
import { status } from '@/data/status';
import { useIssuesStore } from '@/store/issues-store';
import { useCreateIssueStore } from '@/store/create-issue-store';
import { useSessionStore } from '@/store/session-store';
import { useUiPrefsStore } from '@/store/ui-prefs-store';
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';
import { StatusSelector } from './status-selector';
import { PrioritySelector } from './priority-selector';
import { AssigneeSelector } from './assignee-selector';
import { ProjectSelector } from './project-selector';
import { rankFromSortOrder } from '@/lib/issues';
import { WORKSPACE_NAME } from '@/lib/config';
import { BerryApiError } from '@/lib/api';
import { createBoardIssue } from '@/lib/issues';
import { assignIssueToSquad, type Squad } from '@/lib/squads';

export function CreateNewIssue() {
   const { isOpen, defaultStatus, openModal, closeModal } = useCreateIssueStore();
   const { addIssue, getAllIssues } = useIssuesStore();
   const boardId = useSessionStore((state) => state.boardId);
   // Preferences → Tasks decides which of these selectors are worth the room.
   // A hidden one is not a missing value: the form still carries its default
   // and still sends it, so the task is created exactly as before.
   const createFields = useUiPrefsStore((state) => state.createFields);
   const [pending, setPending] = useState(false);
   // A squad chosen as assignee: its leader is the assignee on create, and the
   // squad is given the issue once the issue exists.
   const [squad, setSquad] = useState<Squad | null>(null);

   const createDefaultData = useCallback(() => {
      const sortOrder = (getAllIssues().length + 1) * 1000;
      return {
         id: uuidv4(),
         // Blank until the server assigns one. The identifier comes from the
         // board's slug and the next number on that board, neither of which the
         // client knows — inventing one here produced a code that matched
         // nothing once the issue was actually created.
         identifier: '',
         title: '',
         description: '',
         status: defaultStatus || status.find((s) => s.id === 'to-do')!,
         assignee: null,
         priority: priorities.find((p) => p.id === 'no-priority')!,
         labels: [],
         createdAt: new Date().toISOString(),
         cycleId: '',
         project: undefined,
         subissues: [],
         sortOrder,
         rank: rankFromSortOrder(sortOrder),
      };
   }, [defaultStatus, getAllIssues]);

   const [addIssueForm, setAddIssueForm] = useState<Issue>(createDefaultData());

   useEffect(() => {
      setAddIssueForm(createDefaultData());
   }, [createDefaultData]);

   const createIssue = async () => {
      if (!addIssueForm.title) {
         toast.error('Title is required');
         return;
      }
      if (!boardId) {
         toast.error('Board is not ready');
         return;
      }
      setPending(true);
      try {
         const created = await createBoardIssue({
            boardId,
            title: addIssueForm.title,
            description: addIssueForm.description || undefined,
            statusId: addIssueForm.status.id,
            priorityId: addIssueForm.priority.id,
            assignee:
               addIssueForm.assignee == null
                  ? undefined
                  : {
                       type: addIssueForm.assignee.role === 'Application' ? 'agent' : 'user',
                       id: addIssueForm.assignee.id,
                    },
            projectId: addIssueForm.project?.id,
         });
         addIssue({
            ...created,
            assignee: addIssueForm.assignee,
            labels: addIssueForm.labels,
         });
         toast.success('Task created');
         if (squad) {
            // Separate from the create: the task exists either way, and a
            // squad that could not take it is reported rather than undone.
            await assignIssueToSquad(squad.id, created.id).then(
               () => toast.success(`Given to ${squad.name}`),
               (error: unknown) =>
                  toast.error(
                     error instanceof BerryApiError
                        ? error.message
                        : `The task was created but could not be given to ${squad.name}`
                  )
            );
         }
         closeModal();
         setSquad(null);
         setAddIssueForm(createDefaultData());
      } catch (error) {
         toast.error(error instanceof BerryApiError ? error.message : 'Could not create task');
      } finally {
         setPending(false);
      }
   };

   return (
      <Dialog open={isOpen} onOpenChange={(value) => (value ? openModal() : closeModal())}>
         <DialogTrigger asChild>
            <Button
               className="size-8 shrink-0"
               variant="secondary"
               size="icon"
               aria-label="Create task"
            >
               <RiEditLine />
            </Button>
         </DialogTrigger>
         <DialogContent
            showCloseButton={false}
            className="w-full sm:max-w-[750px] p-0 shadow-xl top-[30%]"
         >
            {/* Same header as the create-project dialog: the workspace crumb
                says where the thing lands, the close button is the only chrome. */}
            <DialogHeader className="px-4 pt-4 pb-0">
               <DialogTitle className="sr-only">New task</DialogTitle>
               <DialogDescription className="sr-only">
                  Give the task a title, set its properties, and add an optional description.
               </DialogDescription>
               <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                     <BerryMark size="sm" />
                     <span className="font-medium text-foreground">{WORKSPACE_NAME}</span>
                     <ChevronRight className="size-3.5 shrink-0" />
                     <span className="truncate">New task</span>
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

            <div className="px-4 pb-0 space-y-1 w-full">
               <Input
                  data-heading="h1"
                  className="h-auto border-none bg-transparent px-0 font-medium text-foreground shadow-none outline-none placeholder:text-foreground/40 placeholder:font-normal"
                  placeholder="Task title"
                  value={addIssueForm.title}
                  onChange={(e) => setAddIssueForm({ ...addIssueForm, title: e.target.value })}
               />

               <MarkdownTextarea
                  data-heading="h3"
                  className="min-h-28 resize-none border-none bg-transparent px-0 text-foreground shadow-none outline-none placeholder:text-foreground/40"
                  placeholder="Add description..."
                  value={addIssueForm.description}
                  onChange={(description) => setAddIssueForm({ ...addIssueForm, description })}
               />

               <div className="w-full flex items-center justify-start gap-1.5 flex-wrap">
                  {createFields.status ? (
                     <StatusSelector
                        status={addIssueForm.status}
                        onChange={(newStatus) =>
                           setAddIssueForm({ ...addIssueForm, status: newStatus })
                        }
                     />
                  ) : null}
                  {createFields.priority ? (
                     <PrioritySelector
                        priority={addIssueForm.priority}
                        onChange={(newPriority) =>
                           setAddIssueForm({ ...addIssueForm, priority: newPriority })
                        }
                     />
                  ) : null}
                  {createFields.assignee ? (
                     <AssigneeSelector
                        assignee={addIssueForm.assignee}
                        onChange={(newAssignee) =>
                           setAddIssueForm({ ...addIssueForm, assignee: newAssignee })
                        }
                        onSquadChange={setSquad}
                     />
                  ) : null}
                  {createFields.project ? (
                     <ProjectSelector
                        project={addIssueForm.project}
                        onChange={(newProject) =>
                           setAddIssueForm({ ...addIssueForm, project: newProject })
                        }
                     />
                  ) : null}
               </div>
            </div>
            <div className="flex items-center justify-between py-2.5 px-4 w-full border-t">
               <span className="ai-animated-border">
                  <Button
                     variant="ghost"
                     size="sm"
                     className="gap-1.5 border-0 bg-background shadow-none hover:bg-accent"
                  >
                     <Sparkles className="size-4" />
                     Improve with AI
                  </Button>
               </span>
               <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                     void createIssue();
                  }}
               >
                  {pending ? 'Creating…' : 'Create task'}
               </Button>
            </div>
         </DialogContent>
      </Dialog>
   );
}
