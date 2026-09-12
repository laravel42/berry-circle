'use client';

import { X } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState, type FormEvent } from 'react';

import { MarkdownTextarea } from '@/components/common/editor/markdown-textarea';
import { Button } from '@/components/ui/button';
import {
   Command,
   CommandEmpty,
   CommandGroup,
   CommandInput,
   CommandItem,
   CommandList,
} from '@/components/ui/command';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import type { User } from '@/data/users';
import {
   addCronTrigger,
   addWebhookTrigger,
   createAutopilot,
   describeAutopilotFailure,
   setAutopilotMembers,
   updateAutopilot,
   type Autopilot,
   type AutopilotDraft,
   type WebhookSecrets,
} from '@/lib/autopilots';
import { listBoards, type BoardSummary } from '@/lib/boards';
import { WORKSPACE_SLUG } from '@/lib/config';
import { localTimezone } from '@/lib/cron-schedule';
import { loadWorkspaceMembers } from '@/lib/members';
import { agentHasRuntime, getAgentCoverage, type AgentCoverage } from '@/lib/runtimes';
import { listSquads, type Squad } from '@/lib/squads';
import { useAgentsStore } from '@/store/agents-store';
import { useIssuesStore } from '@/store/issues-store';
import { useSessionStore } from '@/store/session-store';

import ScheduleEditor from './schedule-editor';
import { SecretsNotice } from './triggers-tab';

interface Props {
   open: boolean;
   onOpenChange: (open: boolean) => void;
   autopilot?: Autopilot;
   /** A starting point chosen from the empty state. */
   template?: { name: string; prompt: string } | null;
   onSaved?: () => void;
}

function initialDraft(autopilot?: Autopilot, template?: { name: string; prompt: string } | null) {
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
      } satisfies AutopilotDraft;
   }
   return {
      name: template?.name ?? '',
      description: null,
      assigneeType: 'agent',
      assigneeId: '',
      promptTemplate: template?.prompt ?? '',
      executionMode: 'create_issue',
      boardId: null,
      issueId: null,
      quotaPeriod: 'none',
      quotaMax: null,
   } satisfies AutopilotDraft;
}

/**
 * An autopilot: who runs it, what they are told to do, what each run produces,
 * who hears about it, and — when it is new — what will set it off.
 *
 * An agent with nowhere to run is not offered: an autopilot assigned to one
 * would be a standing instruction that silently never fires.
 */
export default function AutopilotDialog({
   open,
   onOpenChange,
   autopilot,
   template,
   onSaved,
}: Props) {
   const t = useTranslations('areas.autopilots.dialog');
   const router = useRouter();
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const agents = useAgentsStore((state) => state.agents);
   const issues = useIssuesStore((state) => state.getAllIssues());

   const [boards, setBoards] = useState<BoardSummary[]>([]);
   const [squads, setSquads] = useState<Squad[]>([]);
   const [people, setPeople] = useState<User[]>([]);
   const [coverage, setCoverage] = useState<AgentCoverage | null>(null);
   const [draft, setDraft] = useState<AutopilotDraft>(() => initialDraft(autopilot, template));
   const [subscribers, setSubscribers] = useState<string[]>([]);
   const [trigger, setTrigger] = useState<'none' | 'cron' | 'webhook'>('none');
   const [schedule, setSchedule] = useState({
      expression: '0 9 * * 1-5',
      timezone: localTimezone(),
   });
   const [eventFilters, setEventFilters] = useState('');
   const [secrets, setSecrets] = useState<{ id: string; secrets: WebhookSecrets } | null>(null);
   const [error, setError] = useState<string | null>(null);
   const [saving, setSaving] = useState(false);

   // Keyed on the id, not the object: the detail page re-reads the autopilot
   // whenever a frame about it arrives, and depending on the object would wipe
   // what someone is typing mid-edit.
   const autopilotKey = autopilot?.id ?? null;
   useEffect(() => {
      if (!open) return;
      setDraft(initialDraft(autopilot, template));
      setSubscribers([]);
      setTrigger('none');
      setSecrets(null);
      setError(null);
      void listBoards()
         .then(setBoards)
         .catch(() => setBoards([]));
      void listSquads()
         .then(setSquads)
         .catch(() => setSquads([]));
      void getAgentCoverage()
         .then(setCoverage)
         .catch(() => setCoverage(null));
      if (workspaceId) {
         void loadWorkspaceMembers(workspaceId)
            .then(setPeople)
            .catch(() => setPeople([]));
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [open, autopilotKey, workspaceId]);

   const set = <K extends keyof AutopilotDraft>(key: K, value: AutopilotDraft[K]) =>
      setDraft((current) => ({ ...current, [key]: value }));

   const runnableAgents = agents.filter((agent) => agentHasRuntime(coverage, agent.id));
   const hidden = agents.length - runnableAgents.length;

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
            if (subscribers.length > 0) {
               await setAutopilotMembers(
                  autopilot.id,
                  subscribers.map((userId) => ({ userId, role: 'subscriber' as const }))
               );
            }
            onSaved?.();
            onOpenChange(false);
            return;
         }

         const created = await createAutopilot(workspaceId, draft);
         if (subscribers.length > 0) {
            await setAutopilotMembers(
               created.id,
               subscribers.map((userId) => ({ userId, role: 'subscriber' as const }))
            );
         }
         if (trigger === 'cron') {
            await addCronTrigger(created.id, schedule);
         } else if (trigger === 'webhook') {
            const made = await addWebhookTrigger(
               created.id,
               eventFilters
                  .split(',')
                  .map((name) => name.trim())
                  .filter((name) => name !== '')
            );
            // The secret is readable exactly once: hold the dialog open on it
            // rather than navigating away from the only chance to copy it.
            setSecrets({ id: created.id, secrets: made.secrets });
            onSaved?.();
            return;
         }
         onSaved?.();
         onOpenChange(false);
         router.push(`/${orgId}/autopilot/${created.id}`);
      } catch (failure) {
         setError(describeAutopilotFailure(failure));
      } finally {
         setSaving(false);
      }
   }

   if (secrets) {
      return (
         <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-xl">
               <DialogHeader>
                  <DialogTitle>{t('created')}</DialogTitle>
               </DialogHeader>
               <SecretsNotice
                  secrets={secrets.secrets}
                  onDismiss={() => {
                     const id = secrets.id;
                     setSecrets(null);
                     onOpenChange(false);
                     router.push(`/${orgId}/autopilot/${id}`);
                  }}
               />
            </DialogContent>
         </Dialog>
      );
   }

   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
            <form onSubmit={submit} className="flex flex-col gap-4">
               <DialogHeader>
                  <DialogTitle>{autopilot ? t('edit') : t('new')}</DialogTitle>
                  <DialogDescription>{t('description')}</DialogDescription>
               </DialogHeader>

               <div className="grid gap-2">
                  <Label htmlFor="autopilot-name">{t('name')}</Label>
                  <Input
                     id="autopilot-name"
                     value={draft.name}
                     maxLength={200}
                     onChange={(event) => set('name', event.target.value)}
                  />
               </div>

               <div className="grid gap-2">
                  <Label>{t('assignee')}</Label>
                  <div className="flex items-center gap-1">
                     {(['agent', 'squad'] as const).map((kind) => (
                        <Button
                           key={kind}
                           type="button"
                           size="xs"
                           variant={draft.assigneeType === kind ? 'secondary' : 'ghost'}
                           onClick={() =>
                              setDraft((current) => ({
                                 ...current,
                                 assigneeType: kind,
                                 assigneeId: '',
                              }))
                           }
                        >
                           {kind === 'agent' ? t('agents') : t('squads')}
                        </Button>
                     ))}
                  </div>
                  <Select
                     value={draft.assigneeId}
                     onValueChange={(value) => set('assigneeId', value)}
                  >
                     <SelectTrigger>
                        <SelectValue placeholder={t('chooseAssignee')} />
                     </SelectTrigger>
                     <SelectContent>
                        {(draft.assigneeType === 'agent' ? runnableAgents : squads).map((entry) => (
                           <SelectItem key={entry.id} value={entry.id}>
                              {entry.name}
                           </SelectItem>
                        ))}
                     </SelectContent>
                  </Select>
                  {draft.assigneeType === 'agent' && hidden > 0 ? (
                     <p className="text-muted-foreground">
                        {t('noRuntimeHint', { count: hidden })}
                     </p>
                  ) : null}
               </div>

               <div className="grid gap-2">
                  <Label htmlFor="autopilot-prompt">{t('runbook')}</Label>
                  <MarkdownTextarea
                     id="autopilot-prompt"
                     rows={8}
                     maxLength={20000}
                     value={draft.promptTemplate}
                     onChange={(value) => set('promptTemplate', value)}
                  />
                  <p className="text-muted-foreground">{t('runbookHint')}</p>
               </div>

               <div className="grid gap-2">
                  <Label>{t('outputMode')}</Label>
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
                        <SelectItem value="create_issue">{t('createIssue')}</SelectItem>
                        <SelectItem value="fixed_issue">{t('fixedIssue')}</SelectItem>
                     </SelectContent>
                  </Select>
               </div>

               {draft.executionMode === 'create_issue' ? (
                  <div className="grid gap-2">
                     <Label>{t('project')}</Label>
                     <Select
                        value={draft.boardId ?? ''}
                        onValueChange={(value) => set('boardId', value)}
                     >
                        <SelectTrigger>
                           <SelectValue placeholder={t('chooseProject')} />
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
                     <Label>{t('task')}</Label>
                     <Select
                        value={draft.issueId ?? ''}
                        onValueChange={(value) => set('issueId', value)}
                     >
                        <SelectTrigger>
                           <SelectValue placeholder={t('chooseTask')} />
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

               <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                     <Label>{t('quota')}</Label>
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
                           <SelectItem value="none">{t('quotaNone')}</SelectItem>
                           <SelectItem value="hour">{t('quotaHour')}</SelectItem>
                           <SelectItem value="day">{t('quotaDay')}</SelectItem>
                           <SelectItem value="week">{t('quotaWeek')}</SelectItem>
                        </SelectContent>
                     </Select>
                  </div>
                  {draft.quotaPeriod !== 'none' ? (
                     <div className="grid gap-2">
                        <Label htmlFor="autopilot-quota">{t('quotaMax')}</Label>
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
                  ) : null}
               </div>

               <div className="grid gap-2">
                  <Label>{t('subscribers')}</Label>
                  {subscribers.length > 0 ? (
                     <ul className="flex flex-wrap gap-2">
                        {subscribers.map((userId) => {
                           const person = people.find((entry) => entry.id === userId);
                           return (
                              <li
                                 key={userId}
                                 className="flex items-center gap-1 rounded border px-2 py-0.5"
                              >
                                 {person?.name ?? userId}
                                 <button
                                    type="button"
                                    className="cursor-pointer"
                                    aria-label={t('removeSubscriber', {
                                       name: person?.name ?? userId,
                                    })}
                                    onClick={() =>
                                       setSubscribers((current) =>
                                          current.filter((entry) => entry !== userId)
                                       )
                                    }
                                 >
                                    <X className="size-3" />
                                 </button>
                              </li>
                           );
                        })}
                     </ul>
                  ) : null}
                  <Popover>
                     <PopoverTrigger asChild>
                        <Button type="button" size="xs" variant="secondary" className="w-fit">
                           {t('addSubscriber')}
                        </Button>
                     </PopoverTrigger>
                     <PopoverContent className="w-64 p-0" align="start">
                        <Command>
                           <CommandInput placeholder={t('searchPeople')} />
                           <CommandList>
                              <CommandEmpty>{t('noneFound')}</CommandEmpty>
                              <CommandGroup>
                                 {people
                                    .filter((person) => !subscribers.includes(person.id))
                                    .map((person) => (
                                       <CommandItem
                                          key={person.id}
                                          value={person.name}
                                          onSelect={() =>
                                             setSubscribers((current) => [...current, person.id])
                                          }
                                       >
                                          {person.name}
                                       </CommandItem>
                                    ))}
                              </CommandGroup>
                           </CommandList>
                        </Command>
                     </PopoverContent>
                  </Popover>
                  <p className="text-muted-foreground">{t('subscribersHint')}</p>
               </div>

               {!autopilot ? (
                  <div className="grid gap-2">
                     <Label>{t('firstTrigger')}</Label>
                     <div className="flex flex-wrap items-center gap-1">
                        {(['none', 'cron', 'webhook'] as const).map((kind) => (
                           <Button
                              key={kind}
                              type="button"
                              size="xs"
                              variant={trigger === kind ? 'secondary' : 'ghost'}
                              onClick={() => setTrigger(kind)}
                           >
                              {t(`trigger_${kind}`)}
                           </Button>
                        ))}
                     </div>
                     {trigger === 'cron' ? (
                        <div className="rounded-md border p-3">
                           <ScheduleEditor
                              expression={schedule.expression}
                              timezone={schedule.timezone}
                              onChange={setSchedule}
                           />
                        </div>
                     ) : null}
                     {trigger === 'webhook' ? (
                        <div className="grid gap-1.5">
                           <Label htmlFor="autopilot-events">{t('eventFilters')}</Label>
                           <Input
                              id="autopilot-events"
                              value={eventFilters}
                              onChange={(event) => setEventFilters(event.target.value)}
                           />
                           <p className="text-muted-foreground">{t('eventFiltersHint')}</p>
                        </div>
                     ) : null}
                  </div>
               ) : null}

               {error ? (
                  <p className="text-destructive" role="alert">
                     {error}
                  </p>
               ) : null}

               <DialogFooter>
                  <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                     {t('cancel')}
                  </Button>
                  <Button type="submit" disabled={!ready || saving}>
                     {autopilot ? t('save') : t('create')}
                  </Button>
               </DialogFooter>
            </form>
         </DialogContent>
      </Dialog>
   );
}
