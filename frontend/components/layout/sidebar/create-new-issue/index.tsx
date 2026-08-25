'use client';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { MarkdownTextarea } from '@/components/common/editor/markdown-textarea';
import { BerryMark } from '@/components/brand/berry-mark';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { RiEditLine } from '@remixicon/react';
import { useState, useEffect, useCallback } from 'react';
import { Issue } from '@/data/issues';
import { priorities } from '@/data/priorities';
import { status } from '@/data/status';
import { useIssuesStore } from '@/store/issues-store';
import { useCreateIssueStore } from '@/store/create-issue-store';
import { useSessionStore } from '@/store/session-store';
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';
import { StatusSelector } from './status-selector';
import { PrioritySelector } from './priority-selector';
import { AssigneeSelector } from './assignee-selector';
import { ProjectSelector } from './project-selector';
import { LabelSelector } from './label-selector';
import { rankFromSortOrder } from '@/lib/issues';
import { ISSUE_IDENTIFIER_PREFIX, WORKSPACE_NAME } from '@/lib/config';
import { BerryApiError } from '@/lib/api';
import { createBoardIssue } from '@/lib/issues';
import { DialogTitle } from '@radix-ui/react-dialog';

export function CreateNewIssue() {
   const [createMore, setCreateMore] = useState<boolean>(false);
   const { isOpen, defaultStatus, openModal, closeModal } = useCreateIssueStore();
   const { addIssue, getAllIssues } = useIssuesStore();
   const boardId = useSessionStore((state) => state.boardId);
   const [pending, setPending] = useState(false);

   const generateUniqueIdentifier = useCallback(() => {
      const identifiers = getAllIssues().map((issue) => issue.identifier);
      let identifier = Math.floor(Math.random() * 999)
         .toString()
         .padStart(3, '0');
      while (identifiers.includes(`${ISSUE_IDENTIFIER_PREFIX}-${identifier}`)) {
         identifier = Math.floor(Math.random() * 999)
            .toString()
            .padStart(3, '0');
      }
      return identifier;
   }, [getAllIssues]);

   const createDefaultData = useCallback(() => {
      const identifier = generateUniqueIdentifier();
      const sortOrder = (getAllIssues().length + 1) * 1000;
      return {
         id: uuidv4(),
         identifier: `${ISSUE_IDENTIFIER_PREFIX}-${identifier}`,
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
   }, [defaultStatus, generateUniqueIdentifier, getAllIssues]);

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
         });
         addIssue({
            ...created,
            assignee: addIssueForm.assignee,
            labels: addIssueForm.labels,
            project: addIssueForm.project,
         });
         toast.success('Issue created');
         if (!createMore) {
            closeModal();
         }
         setAddIssueForm(createDefaultData());
      } catch (error) {
         toast.error(error instanceof BerryApiError ? error.message : 'Could not create issue');
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
               aria-label="Create issue"
            >
               <RiEditLine />
            </Button>
         </DialogTrigger>
         <DialogContent className="w-full sm:max-w-[750px] p-0 shadow-xl top-[30%]">
            <DialogHeader>
               <DialogTitle>
                  <div className="flex items-center px-4 pt-4 gap-2">
                     <Button size="sm" variant="outline" className="gap-1.5">
                        <BerryMark size="sm" />
                        <span className="font-medium">{WORKSPACE_NAME}</span>
                     </Button>
                  </div>
               </DialogTitle>
            </DialogHeader>

            <div className="px-4 pb-0 space-y-3 w-full">
               <Input
                  className="h-auto border-none bg-transparent px-0 font-medium text-foreground shadow-none outline-none placeholder:text-foreground/40 placeholder:!text-[12px] placeholder:font-normal placeholder:leading-4"
                  placeholder="Issue title"
                  value={addIssueForm.title}
                  onChange={(e) => setAddIssueForm({ ...addIssueForm, title: e.target.value })}
               />

               <MarkdownTextarea
                  className="min-h-16 resize-none border-none bg-transparent px-0 text-foreground shadow-none outline-none placeholder:text-foreground/40 placeholder:!text-[12px] placeholder:leading-4"
                  placeholder="Add description..."
                  value={addIssueForm.description}
                  onChange={(description) => setAddIssueForm({ ...addIssueForm, description })}
               />

               <div className="w-full flex items-center justify-start gap-1.5 flex-wrap">
                  <StatusSelector
                     status={addIssueForm.status}
                     onChange={(newStatus) =>
                        setAddIssueForm({ ...addIssueForm, status: newStatus })
                     }
                  />
                  <PrioritySelector
                     priority={addIssueForm.priority}
                     onChange={(newPriority) =>
                        setAddIssueForm({ ...addIssueForm, priority: newPriority })
                     }
                  />
                  <AssigneeSelector
                     assignee={addIssueForm.assignee}
                     onChange={(newAssignee) =>
                        setAddIssueForm({ ...addIssueForm, assignee: newAssignee })
                     }
                  />
                  <ProjectSelector
                     project={addIssueForm.project}
                     onChange={(newProject) =>
                        setAddIssueForm({ ...addIssueForm, project: newProject })
                     }
                  />
                  <LabelSelector
                     selectedLabels={addIssueForm.labels}
                     onChange={(newLabels) =>
                        setAddIssueForm({ ...addIssueForm, labels: newLabels })
                     }
                  />
               </div>
            </div>
            <div className="flex items-center justify-between py-2.5 px-4 w-full border-t">
               <div className="flex items-center gap-2">
                  <div className="flex items-center space-x-2">
                     <Switch
                        id="create-more"
                        checked={createMore}
                        onCheckedChange={setCreateMore}
                     />
                     <Label htmlFor="create-more">Create more</Label>
                  </div>
               </div>
               <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                     void createIssue();
                  }}
               >
                  {pending ? 'Creating…' : 'Create issue'}
               </Button>
            </div>
         </DialogContent>
      </Dialog>
   );
}
