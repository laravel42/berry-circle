'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { BerryApiError } from '@/lib/api';
import { createBoardIssue } from '@/lib/issues';
import type { Agent } from '@/lib/agents';
import { useIssuesStore } from '@/store/issues-store';
import { useSessionStore } from '@/store/session-store';

interface AgentAssignWorkDialogProps {
   agent: Agent;
   open: boolean;
   onOpenChange: (open: boolean) => void;
}

/**
 * Quick-create, with this agent already chosen.
 *
 * Deliberately two fields. Assigning work to an agent from its own page is an
 * act of delegation, not of planning: status, priority, project and labels are
 * all things the issue view can change afterwards, and asking for them here
 * would turn a handoff into a form.
 */
export default function AgentAssignWorkDialog({
   agent,
   open,
   onOpenChange,
}: AgentAssignWorkDialogProps) {
   const t = useTranslations('agentsChat.detail');
   const common = useTranslations('agentsChat.common');
   const create = useTranslations('agentsChat.create');
   const boardId = useSessionStore((state) => state.boardId);
   const addIssue = useIssuesStore((state) => state.addIssue);
   const [title, setTitle] = useState('');
   const [description, setDescription] = useState('');
   const [busy, setBusy] = useState(false);

   const submit = async () => {
      if (!boardId || !title.trim()) return;
      setBusy(true);
      try {
         const issue = await createBoardIssue({
            boardId,
            title: title.trim(),
            ...(description.trim() ? { description: description.trim() } : {}),
            statusId: 'to-do',
            priorityId: 'no-priority',
            assignee: { type: 'agent', id: agent.id },
         });
         addIssue(issue);
         toast.success(issue.identifier);
         setTitle('');
         setDescription('');
         onOpenChange(false);
      } catch (error) {
         toast.error(error instanceof BerryApiError ? error.message : t('failureUnknown'));
      } finally {
         setBusy(false);
      }
   };

   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent className="sm:max-w-lg">
            <DialogHeader>
               <DialogTitle>{t('assignWork')}</DialogTitle>
               <DialogDescription>{agent.name}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
               <Input
                  autoFocus
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={create('namePlaceholder')}
                  aria-label={create('name')}
               />
               <Textarea
                  rows={5}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={create('description')}
                  aria-label={create('description')}
               />
               <div className="flex items-center gap-2">
                  <Button
                     size="sm"
                     disabled={busy || !title.trim() || !boardId}
                     onClick={() => void submit()}
                  >
                     {t('assignWork')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
                     {common('cancel')}
                  </Button>
               </div>
            </div>
         </DialogContent>
      </Dialog>
   );
}
