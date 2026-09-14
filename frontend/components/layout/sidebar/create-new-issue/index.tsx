'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { MarkdownTextarea } from '@/components/common/editor/markdown-textarea';
import { useRunConfirm } from '@/components/common/issues/run-confirm-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogHeader,
   DialogTitle,
   DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Issue } from '@/data/issues';
import type { LabelInterface } from '@/data/labels';
import { priorities } from '@/data/priorities';
import { status } from '@/data/status';
import { loadWorkspaceAgents, type Agent } from '@/lib/agents';
import { BerryApiError } from '@/lib/api';
import { uploadIssueAttachment } from '@/lib/attachments';
import { WORKSPACE_NAME, WORKSPACE_SLUG } from '@/lib/config';
import { setIssueLabels } from '@/lib/issue-labels';
import { setParent } from '@/lib/issue-tracking';
import { createBoardIssue, rankFromSortOrder } from '@/lib/issues';
import { loadWorkspaceLabels } from '@/lib/labels';
import { loadProperties, setIssueProperty, type PropertyDefinition } from '@/lib/properties';
import { searchWorkspace } from '@/lib/search';
import { assignIssueToSquad, listSquads, type Squad } from '@/lib/squads';
import { cn } from '@/lib/utils';
import { useCreateIssueStore } from '@/store/create-issue-store';
import { useIssuesStore } from '@/store/issues-store';
import { useSessionStore } from '@/store/session-store';
import { useUiPrefsStore } from '@/store/ui-prefs-store';
import { RiEditLine } from '@remixicon/react';
import { CheckIcon, ChevronRight, Paperclip, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';
import { AssigneeSelector } from './assignee-selector';
import { PrioritySelector } from './priority-selector';
import { ProjectSelector } from './project-selector';
import { StatusSelector } from './status-selector';

/**
 * Creating a task.
 *
 * Two modes, because there are two ways a task starts. Someone who knows what
 * they want fills the form in; someone who wants an agent to work it out
 * writes a sentence and hands it over. The second is not a lesser version of
 * the first — it is how most agent work actually begins, and it needs one
 * field, not twelve.
 *
 * Everything that cannot be set at creation time — labels, custom fields, a
 * parent, sub-tasks — is applied immediately afterwards, in that order, and a
 * failure in any of them is reported without pretending the task was not
 * created. It was.
 */

type Mode = 'manual' | 'agent';

export function CreateNewIssue() {
   const t = useTranslations('issueDetail.create');
   const {
      isOpen,
      context,
      draft,
      createAnother,
      openModal,
      closeModal,
      setDraft,
      resetDraft,
      setCreateAnother,
   } = useCreateIssueStore();
   const { addIssue, getAllIssues } = useIssuesStore();
   const boardId = useSessionStore((state) => state.boardId);
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const runConfirm = useRunConfirm();

   const [mode, setMode] = useState<Mode>('manual');

   // Preferences → Tasks decides which of these selectors are worth the
   // room. A hidden one is not a missing value: the form still carries its
   // default and still sends it, so the task is created exactly as before.
   const createFields = useUiPrefsStore((state) => state.createFields);
   const [pending, setPending] = useState(false);
   const [squad, setSquad] = useState<Squad | null>(null);
   const [squads, setSquads] = useState<Squad[]>([]);
   const [agents, setAgents] = useState<Agent[]>([]);
   const [labels, setLabels] = useState<LabelInterface[]>([]);
   const [definitions, setDefinitions] = useState<PropertyDefinition[]>([]);
   const [files, setFiles] = useState<File[]>([]);
   const [subQuery, setSubQuery] = useState('');
   const [subResults, setSubResults] = useState<
      Array<{ id: string; identifier: string; title: string }>
   >([]);
   const picker = useRef<HTMLInputElement>(null);

   const uiStatus =
      status.find((entry) => entry.id === draft.statusId) ??
      context.defaultStatus ??
      status.find((entry) => entry.id === 'to-do')!;
   const uiPriority =
      priorities.find((entry) => entry.id === draft.priorityId) ??
      priorities.find((entry) => entry.id === 'no-priority')!;

   useEffect(() => {
      if (!isOpen || !workspaceId) return;
      void loadWorkspaceLabels(workspaceId).then(setLabels);
      void loadProperties(workspaceId)
         .then((loaded) => setDefinitions(loaded.filter((entry) => entry.archivedAt === null)))
         .catch(() => setDefinitions([]));
      void listSquads()
         .then(setSquads)
         .catch(() => setSquads([]));
      void loadWorkspaceAgents()
         .then((loaded) => setAgents(loaded.filter((agent) => !agent.archivedAt)))
         .catch(() => setAgents([]));
   }, [isOpen, workspaceId]);

   // The sub-task picker: debounced, and the search is the only way in — a
   // workspace has far too many tasks for a list.
   useEffect(() => {
      if (!isOpen || !workspaceId || subQuery.trim().length < 2) {
         setSubResults([]);
         return;
      }
      let cancelled = false;
      const timer = setTimeout(() => {
         void searchWorkspace(workspaceId, subQuery, ['issue']).then((found) => {
            if (cancelled) return;
            setSubResults(
               found.slice(0, 6).map((entry) => ({
                  id: entry.id,
                  identifier: entry.identifier ?? entry.id,
                  title: entry.title,
               }))
            );
         });
      }, 250);
      return () => {
         cancelled = true;
         clearTimeout(timer);
      };
   }, [isOpen, workspaceId, subQuery]);

   const agentTarget = draft.assignee?.type === 'agent' ? draft.assignee : null;
   const willStart = Boolean(agentTarget || squad);

   const localIssue = useCallback(
      (created: Issue): Issue => {
         const sortOrder = (getAllIssues().length + 1) * 1000;
         return {
            ...created,
            id: created.id || uuidv4(),
            rank: created.rank || rankFromSortOrder(sortOrder),
         };
      },
      [getAllIssues]
   );

   /** Everything that can only be done once the task has an id. */
   const applyExtras = async (created: Issue) => {
      if (draft.labelIds.length > 0) {
         await setIssueLabels(created.identifier, draft.labelIds).catch(() =>
            toast.error(t('failed'))
         );
      }
      for (const [propertyId, value] of Object.entries(draft.properties)) {
         if (value === null || value === '' || value === undefined) continue;
         await setIssueProperty(created.identifier, propertyId, value).catch(() => undefined);
      }
      if (context.parentRef) {
         await setParent(
            created.identifier,
            context.parentRef,
            draft.stage === '' ? null : Number(draft.stage)
         ).catch(() => toast.error(t('failed')));
      }
      for (const childRef of draft.subIssueRefs) {
         await setParent(childRef, created.id, null).catch(() => undefined);
      }
      for (const file of files) {
         await uploadIssueAttachment(created.identifier, file).catch(() => undefined);
      }
      if (squad) {
         await assignIssueToSquad(squad.id, created.id).catch((error: unknown) =>
            toast.error(
               error instanceof BerryApiError
                  ? error.message
                  : `The task was created but could not be given to ${squad.name}`
            )
         );
      }
   };

   const finish = () => {
      setFiles([]);
      setSubQuery('');
      setSquad(null);
      if (createAnother) {
         // Keep the context — the column, the parent — and clear what was typed.
         resetDraft();
         return;
      }
      resetDraft();
      closeModal();
   };

   const duplicateToast = (error: BerryApiError) => {
      const details = (error.details ?? {}) as { identifier?: unknown; issueId?: unknown };
      const identifier =
         typeof details.identifier === 'string'
            ? details.identifier
            : typeof details.issueId === 'string'
              ? details.issueId
              : null;
      toast.error(t('duplicate'), {
         action: identifier
            ? {
                 label: t('viewExisting'),
                 onClick: () => {
                    window.location.href = `/${WORKSPACE_SLUG}/issue/${identifier}`;
                 },
              }
            : undefined,
      });
   };

   const create = async () => {
      const title = mode === 'agent' ? draft.prompt.trim().slice(0, 200) : draft.title.trim();
      if (!title) {
         toast.error(t('titleRequired'));
         return;
      }
      if (!boardId) {
         toast.error('Board is not ready');
         return;
      }

      // Handing work to an agent is two decisions: assign, and start. Asked
      // once, here, rather than assumed.
      let startNow = true;
      if (willStart) {
         const answer = await runConfirm.ask({
            target: {
               kind: squad ? 'squad' : 'agent',
               name: squad?.name ?? draft.assignee?.name ?? '',
            },
         });
         if (answer === null) return;
         startNow = answer;
      }

      setPending(true);
      try {
         const created = await createBoardIssue({
            boardId,
            title,
            description: mode === 'agent' ? draft.prompt.trim() : draft.description || undefined,
            // Not starting means the task waits in the backlog, which is the
            // one state an assigned agent is never dispatched from.
            statusId: willStart && !startNow ? 'backlog' : uiStatus.id,
            priorityId: uiPriority.id,
            assignee: draft.assignee
               ? { type: draft.assignee.type, id: draft.assignee.id }
               : undefined,
            projectId: draft.projectId ?? context.projectId ?? undefined,
            dueDate: draft.dueDate || undefined,
         });

         addIssue(localIssue(created));
         await applyExtras(created);
         toast.success(mode === 'agent' ? t('agentCreated') : t('created'));
         finish();
      } catch (error) {
         if (error instanceof BerryApiError && error.status === 409) duplicateToast(error);
         else toast.error(error instanceof BerryApiError ? error.message : t('failed'));
      } finally {
         setPending(false);
      }
   };

   const toggleLabel = (labelId: string) =>
      setDraft({
         labelIds: draft.labelIds.includes(labelId)
            ? draft.labelIds.filter((id) => id !== labelId)
            : [...draft.labelIds, labelId],
      });

   return (
      <Dialog open={isOpen} onOpenChange={(value) => (value ? openModal() : closeModal())}>
         <DialogTrigger asChild>
            <Button
               className="size-8 shrink-0"
               variant="secondary"
               size="icon"
               aria-label={t('title')}
            >
               <RiEditLine />
            </Button>
         </DialogTrigger>
         <DialogContent
            showCloseButton={false}
            className="top-[10vh] w-full translate-y-0 p-0 shadow-xl sm:max-w-[750px]"
         >
            <DialogHeader className="px-4 pt-4 pb-0">
               <DialogTitle className="sr-only">{t('title')}</DialogTitle>
               <DialogDescription className="sr-only">
                  {t('descriptionPlaceholder')}
               </DialogDescription>
               <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                     <BerryMark size="sm" />
                     <span className="font-medium text-foreground">{WORKSPACE_NAME}</span>
                     <ChevronRight className="size-3.5 shrink-0" />
                     <span className="truncate">{t('title')}</span>
                     {context.parentRef ? (
                        <span className="ml-1 shrink-0 rounded bg-accent px-1.5">
                           {t('parentLocked', { identifier: context.parentRef })}
                        </span>
                     ) : null}
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

            <div className="flex gap-1 px-4">
               {(['manual', 'agent'] as Mode[]).map((entry) => (
                  <Button
                     key={entry}
                     variant={mode === entry ? 'secondary' : 'ghost'}
                     size="xs"
                     aria-pressed={mode === entry}
                     onClick={() => setMode(entry)}
                  >
                     {t(entry)}
                  </Button>
               ))}
            </div>

            {mode === 'manual' ? (
               <div className="max-h-[52vh] w-full space-y-1 overflow-y-auto px-4 pb-0">
                  <Input
                     data-heading="h1"
                     className="h-auto border-none bg-transparent px-0 font-medium text-foreground shadow-none outline-none placeholder:font-normal placeholder:text-foreground/40"
                     placeholder={t('titlePlaceholder')}
                     value={draft.title}
                     onChange={(event) => setDraft({ title: event.target.value })}
                  />

                  <MarkdownTextarea
                     data-heading="h3"
                     className="min-h-28 resize-none border-none bg-transparent px-0 text-foreground shadow-none outline-none placeholder:text-foreground/40"
                     placeholder={t('descriptionPlaceholder')}
                     value={draft.description}
                     onChange={(description) => setDraft({ description })}
                  />

                  <div className="flex w-full flex-wrap items-center justify-start gap-1.5">
                     {createFields.status ? (
                        <StatusSelector
                           status={uiStatus}
                           onChange={(next) => setDraft({ statusId: next.id })}
                        />
                     ) : null}
                     {createFields.priority ? (
                        <PrioritySelector
                           priority={uiPriority}
                           onChange={(next) => setDraft({ priorityId: next.id })}
                        />
                     ) : null}
                     {createFields.assignee ? (
                        <AssigneeSelector
                           assignee={null}
                           onChange={(next) =>
                              setDraft({
                                 assignee: next
                                    ? {
                                         type: next.role === 'Application' ? 'agent' : 'user',
                                         id: next.id,
                                         name: next.name,
                                      }
                                    : null,
                              })
                           }
                           onSquadChange={setSquad}
                        />
                     ) : null}
                     {createFields.project ? (
                        <ProjectSelector
                           project={undefined}
                           onChange={(next) => setDraft({ projectId: next?.id ?? null })}
                        />
                     ) : null}

                     <Input
                        type="date"
                        aria-label={t('dueDate')}
                        className="h-7 w-36"
                        value={draft.dueDate}
                        onChange={(event) => setDraft({ dueDate: event.target.value })}
                     />

                     <Input
                        type="number"
                        min={0}
                        aria-label={t('stage')}
                        placeholder={t('stage')}
                        className="h-7 w-20"
                        value={draft.stage}
                        onChange={(event) => setDraft({ stage: event.target.value })}
                     />

                     <Popover>
                        <PopoverTrigger asChild>
                           <Button variant="outline" size="xs">
                              {draft.labelIds.length > 0
                                 ? `${t('labels')} · ${draft.labelIds.length}`
                                 : t('labels')}
                           </Button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="max-h-56 w-56 overflow-y-auto p-1">
                           {labels.map((label) => (
                              <button
                                 key={label.id}
                                 type="button"
                                 onClick={() => toggleLabel(label.id)}
                                 className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent"
                              >
                                 <span
                                    className="size-2 shrink-0 rounded-full"
                                    style={{ backgroundColor: label.color }}
                                 />
                                 <span className="min-w-0 truncate">{label.name}</span>
                                 {draft.labelIds.includes(label.id) ? (
                                    <CheckIcon className="ml-auto size-3.5" />
                                 ) : null}
                              </button>
                           ))}
                        </PopoverContent>
                     </Popover>
                  </div>

                  {definitions.length > 0 ? (
                     <div className="flex flex-col gap-1.5 border-t pt-2">
                        <span className="text-muted-foreground">{t('properties')}</span>
                        {definitions.slice(0, 6).map((definition) => (
                           <label
                              key={definition.id}
                              className="flex items-center justify-between gap-2"
                           >
                              <span className="min-w-0 truncate text-muted-foreground">
                                 {definition.name}
                              </span>
                              <Input
                                 className="h-7 w-44"
                                 type={
                                    definition.kind === 'number'
                                       ? 'number'
                                       : definition.kind === 'date'
                                         ? 'date'
                                         : 'text'
                                 }
                                 value={String(draft.properties[definition.id] ?? '')}
                                 onChange={(event) =>
                                    setDraft({
                                       properties: {
                                          ...draft.properties,
                                          [definition.id]:
                                             definition.kind === 'number'
                                                ? Number(event.target.value)
                                                : event.target.value,
                                       },
                                    })
                                 }
                              />
                           </label>
                        ))}
                     </div>
                  ) : null}

                  <div className="border-t pt-2">
                     <span className="text-muted-foreground">{t('subIssues')}</span>
                     <Input
                        className="mt-1 h-7"
                        placeholder={t('searchTasks')}
                        value={subQuery}
                        onChange={(event) => setSubQuery(event.target.value)}
                     />
                     {draft.subIssueRefs.length > 0 ? (
                        <div className="mt-1 flex flex-wrap gap-1">
                           {draft.subIssueRefs.map((ref) => (
                              <button
                                 key={ref}
                                 type="button"
                                 className="rounded-full border px-2 py-0.5 text-muted-foreground"
                                 onClick={() =>
                                    setDraft({
                                       subIssueRefs: draft.subIssueRefs.filter(
                                          (entry) => entry !== ref
                                       ),
                                    })
                                 }
                              >
                                 {ref} ×
                              </button>
                           ))}
                        </div>
                     ) : null}
                     {subResults.length > 0 ? (
                        <ul className="mt-1 flex flex-col">
                           {subResults.map((entry) => (
                              <li key={entry.id}>
                                 <button
                                    type="button"
                                    className="flex w-full min-w-0 items-center gap-2 rounded px-1 py-1 text-left hover:bg-accent"
                                    onClick={() => {
                                       setDraft({
                                          subIssueRefs: [
                                             ...new Set([...draft.subIssueRefs, entry.identifier]),
                                          ],
                                       });
                                       setSubQuery('');
                                    }}
                                 >
                                    <span className="shrink-0 text-muted-foreground">
                                       {entry.identifier}
                                    </span>
                                    <span className="min-w-0 truncate">{entry.title}</span>
                                 </button>
                              </li>
                           ))}
                        </ul>
                     ) : null}
                  </div>
               </div>
            ) : (
               <div className="max-h-[52vh] w-full space-y-2 overflow-y-auto px-4">
                  <div className="flex flex-wrap gap-1">
                     <span className="w-full text-muted-foreground">{t('pickAgent')}</span>
                     {agents.map((agent) => (
                        <Button
                           key={agent.id}
                           variant={draft.assignee?.id === agent.id ? 'secondary' : 'outline'}
                           size="xs"
                           onClick={() => {
                              setSquad(null);
                              setDraft({
                                 assignee: { type: 'agent', id: agent.id, name: agent.name },
                              });
                           }}
                        >
                           {agent.name}
                        </Button>
                     ))}
                     {squads.map((entry) => (
                        <Button
                           key={entry.id}
                           variant={squad?.id === entry.id ? 'secondary' : 'outline'}
                           size="xs"
                           onClick={() => {
                              setSquad(entry);
                              setDraft({ assignee: null });
                           }}
                        >
                           {entry.name}
                        </Button>
                     ))}
                  </div>

                  <MarkdownTextarea
                     className="min-h-20 resize-none border-none bg-transparent px-0 text-foreground shadow-none outline-none placeholder:text-foreground/40"
                     placeholder={t('promptPlaceholder')}
                     value={draft.prompt}
                     onChange={(prompt) => setDraft({ prompt })}
                  />
               </div>
            )}

            <div className="flex flex-wrap items-center gap-2 px-4">
               <Button variant="ghost" size="xs" onClick={() => picker.current?.click()}>
                  <Paperclip className="mr-1 size-3.5" />
                  {t('attachments')}
                  {files.length > 0 ? ` · ${files.length}` : ''}
               </Button>
               <input
                  ref={picker}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
               />
               <span className={cn('text-muted-foreground', willStart && 'text-status-info')}>
                  {willStart
                     ? t('agentHintStart', { name: squad?.name ?? draft.assignee?.name ?? '' })
                     : t('agentHintWait')}
               </span>
            </div>

            <div className="flex w-full items-center justify-between gap-3 border-t px-4 py-2.5">
               <label className="flex items-center gap-2 text-muted-foreground">
                  <Checkbox
                     checked={createAnother}
                     onCheckedChange={(checked) => setCreateAnother(checked === true)}
                  />
                  {t('createAnother')}
               </label>
               <Button size="sm" disabled={pending} onClick={() => void create()}>
                  {pending ? t('creating') : t('create')}
               </Button>
            </div>
         </DialogContent>
         {runConfirm.dialog}
      </Dialog>
   );
}
