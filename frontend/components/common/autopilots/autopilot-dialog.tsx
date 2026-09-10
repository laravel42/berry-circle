'use client';

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
import { Label } from '@/components/ui/label';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
   createAutopilot,
   describeAutopilotFailure,
   updateAutopilot,
   type Autopilot,
   type AutopilotDraft,
} from '@/lib/autopilots';
import { listBoards, type BoardSummary } from '@/lib/boards';
import { WORKSPACE_SLUG } from '@/lib/config';
import { useAgentsStore } from '@/store/agents-store';
import { useIssuesStore } from '@/store/issues-store';
import { useSessionStore } from '@/store/session-store';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

interface Props {
   open: boolean;
   onOpenChange: (open: boolean) => void;
   autopilot?: Autopilot;
}

function initialDraft(autopilot?: Autopilot): AutopilotDraft {
   if (autopilot) {
      const { name, description, assigneeType, assigneeId, promptTemplate, executionMode } =
         autopilot;
      return {
         name,
         description,
         assigneeType,
         assigneeId,
         promptTemplate,
         executionMode,
         boardId: autopilot.boardId,
         issueId: autopilot.issueId,
         quotaPeriod: autopilot.quotaPeriod,
         quotaMax: autopilot.quotaMax,
      };
   }
   return {
      name: '',
      description: null,
      assigneeType: 'agent',
      assigneeId: '',
      promptTemplate: '',
      executionMode: 'create_issue',
      boardId: null,
      issueId: null,
      quotaPeriod: 'none',
      quotaMax: null,
   };
}

export default function AutopilotDialog({ open, onOpenChange, autopilot }: Props) {
   const router = useRouter();
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const agents = useAgentsStore((state) => state.agents);
   const issues = useIssuesStore((state) => state.getAllIssues());
   const [boards, setBoards] = useState<BoardSummary[]>([]);
   const [draft, setDraft] = useState<AutopilotDraft>(() => initialDraft(autopilot));
   const [error, setError] = useState<string | null>(null);
   const [saving, setSaving] = useState(false);

   // Keyed on the id, not the object: the detail page re-reads the autopilot
   // whenever a stream frame about it arrives (a run, a delivery), and a
   // dependency on the object would wipe what the person is typing mid-edit.
   // Leaving `autopilot` out of the dependencies is deliberate.
   const autopilotKey = autopilot?.id ?? null;
   useEffect(() => {
      if (!open) return;
      setDraft(initialDraft(autopilot));
      setError(null);
      void listBoards()
         .then(setBoards)
         .catch(() => setBoards([]));
      // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [open, autopilotKey]);

   const set = <K extends keyof AutopilotDraft>(key: K, value: AutopilotDraft[K]) =>
      setDraft((current) => ({ ...current, [key]: value }));

   const ready =
      draft.name.trim() !== '' &&
      draft.assigneeId !== '' &&
      draft.promptTemplate.trim() !== '' &&
      (draft.executionMode === 'create_issue' ? draft.boardId !== null : draft.issueId !== null) &&
      (draft.quotaPeriod === 'none' || (draft.quotaMax !== null && draft.quotaMax >= 1));

   async function submit(event: FormEvent) {
      event.preventDefault();
      if (!ready || saving) return;
      setSaving(true);
      setError(null);
      try {
         if (autopilot) {
            await updateAutopilot(autopilot.id, draft);
            onOpenChange(false);
         } else {
            const created = await createAutopilot(workspaceId, draft);
            onOpenChange(false);
            router.push(`/${orgId}/autopilot/${created.id}`);
         }
      } catch (failure) {
         setError(describeAutopilotFailure(failure));
      } finally {
         setSaving(false);
      }
   }

   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent className="sm:max-w-xl">
            <form onSubmit={submit} className="flex flex-col gap-4">
               <DialogHeader>
                  <DialogTitle>{autopilot ? 'Edit autopilot' : 'New autopilot'}</DialogTitle>
                  <DialogDescription>
                     An agent and a prompt. Add a schedule or a webhook after saving, or run it by
                     hand.
                  </DialogDescription>
               </DialogHeader>

               <div className="grid gap-2">
                  <Label htmlFor="autopilot-name">Name</Label>
                  <Input
                     id="autopilot-name"
                     value={draft.name}
                     maxLength={200}
                     onChange={(event) => set('name', event.target.value)}
                  />
               </div>

               <div className="grid gap-2">
                  <Label>Agent</Label>
                  <Select
                     value={draft.assigneeId}
                     onValueChange={(value) => set('assigneeId', value)}
                  >
                     <SelectTrigger>
                        <SelectValue placeholder="Choose an agent" />
                     </SelectTrigger>
                     <SelectContent>
                        {agents.map((agent) => (
                           <SelectItem key={agent.id} value={agent.id}>
                              {agent.name}
                           </SelectItem>
                        ))}
                     </SelectContent>
                  </Select>
               </div>

               <div className="grid gap-2">
                  <Label>Each run</Label>
                  <Select
                     value={draft.executionMode}
                     onValueChange={(value) =>
                        setDraft((current) => ({
                           ...current,
                           executionMode: value === 'fixed_issue' ? 'fixed_issue' : 'create_issue',
                           boardId: null,
                           issueId: null,
                        }))
                     }
                  >
                     <SelectTrigger>
                        <SelectValue />
                     </SelectTrigger>
                     <SelectContent>
                        <SelectItem value="create_issue">opens a new task on a board</SelectItem>
                        <SelectItem value="fixed_issue">works on one existing task</SelectItem>
                     </SelectContent>
                  </Select>
               </div>

               {draft.executionMode === 'create_issue' ? (
                  <div className="grid gap-2">
                     <Label>Board</Label>
                     <Select
                        value={draft.boardId ?? ''}
                        onValueChange={(value) => set('boardId', value)}
                     >
                        <SelectTrigger>
                           <SelectValue placeholder="Choose a board" />
                        </SelectTrigger>
                        <SelectContent>
                           {boards.map((board) => (
                              <SelectItem key={board.id} value={board.id}>
                                 {board.name}
                              </SelectItem>
                           ))}
                        </SelectContent>
                     </Select>
                  </div>
               ) : (
                  <div className="grid gap-2">
                     <Label>Task</Label>
                     <Select
                        value={draft.issueId ?? ''}
                        onValueChange={(value) => set('issueId', value)}
                     >
                        <SelectTrigger>
                           <SelectValue placeholder="Choose a task" />
                        </SelectTrigger>
                        <SelectContent>
                           {issues.map((issue) => (
                              <SelectItem key={issue.id} value={issue.id}>
                                 {issue.identifier} · {issue.title}
                              </SelectItem>
                           ))}
                        </SelectContent>
                     </Select>
                  </div>
               )}

               <div className="grid gap-2">
                  <Label htmlFor="autopilot-prompt">Prompt</Label>
                  <Textarea
                     id="autopilot-prompt"
                     rows={6}
                     maxLength={20000}
                     value={draft.promptTemplate}
                     onChange={(event) => set('promptTemplate', event.target.value)}
                  />
                  <p className="text-muted-foreground">
                     {
                        'Fill in facts with {{trigger.firedAt}}, {{trigger.source}} or {{payload.field}}.'
                     }
                  </p>
               </div>

               <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                     <Label>Quota</Label>
                     <Select
                        value={draft.quotaPeriod}
                        onValueChange={(value) =>
                           setDraft((current) => ({
                              ...current,
                              quotaPeriod:
                                 value === 'hour' || value === 'day' || value === 'week'
                                    ? value
                                    : 'none',
                              quotaMax: value === 'none' ? null : (current.quotaMax ?? 1),
                           }))
                        }
                     >
                        <SelectTrigger>
                           <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                           <SelectItem value="none">no limit</SelectItem>
                           <SelectItem value="hour">per hour</SelectItem>
                           <SelectItem value="day">per day</SelectItem>
                           <SelectItem value="week">per week</SelectItem>
                        </SelectContent>
                     </Select>
                  </div>
                  {draft.quotaPeriod !== 'none' && (
                     <div className="grid gap-2">
                        <Label htmlFor="autopilot-quota">Runs at most</Label>
                        <Input
                           id="autopilot-quota"
                           type="number"
                           min={1}
                           max={10000}
                           value={draft.quotaMax ?? 1}
                           onChange={(event) =>
                              set('quotaMax', Math.max(1, Number(event.target.value) || 1))
                           }
                        />
                     </div>
                  )}
               </div>

               {error && (
                  <p className="text-destructive" role="alert">
                     {error}
                  </p>
               )}

               <DialogFooter>
                  <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                     cancel
                  </Button>
                  <Button type="submit" disabled={!ready || saving}>
                     {autopilot ? 'save' : 'create autopilot'}
                  </Button>
               </DialogFooter>
            </form>
         </DialogContent>
      </Dialog>
   );
}
