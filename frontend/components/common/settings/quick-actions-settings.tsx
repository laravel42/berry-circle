'use client';

import {
   AlertDialog,
   AlertDialogAction,
   AlertDialogCancel,
   AlertDialogContent,
   AlertDialogDescription,
   AlertDialogFooter,
   AlertDialogHeader,
   AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { loadWorkspaceAgents, type Agent } from '@/lib/agents';
import {
   archiveQuickAction,
   createQuickAction,
   deleteQuickAction,
   FILLABLE_VARIABLES,
   isStale,
   loadQuickActions,
   STALE_AFTER_DAYS,
   unfillableVariables,
   updateQuickAction,
   type QuickAction,
} from '@/lib/quick-actions';
import { useSessionStore } from '@/store/session-store';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useSettingsResource } from './use-settings-resource';

/**
 * Prompt templates an agent runs on a task.
 *
 * Ordered by how often each one is actually run, because a workspace
 * accumulates these and alphabetical order buries the two or three anyone
 * uses. One nobody has run in {@link STALE_AFTER_DAYS} days is flagged rather
 * than hidden: it may still be the right thing to keep, and that is the
 * author's call, not the list's.
 *
 * A prompt that uses a variable Berry cannot fill is refused here as well as
 * by the server, because here is where the author can still see what they
 * typed. Unfilled, it would not fail at run time — it would arrive at the
 * agent as two braces and a word, read as instructions.
 *
 * Archiving is reversible and the archived rows stay reachable behind a
 * toggle; deleting for good is a separate step that only an archived action
 * accepts, so the irreversible click is never the first one.
 */
export default function QuickActionsSettings() {
   const t = useTranslations('workspaceAdmin.quickActions');
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const actions = useSettingsResource<QuickAction[]>(
      () =>
         workspaceId
            ? loadQuickActions(workspaceId, true)
            : Promise.reject(new Error('No workspace is selected.')),
      [workspaceId]
   );
   const [agents, setAgents] = useState<Agent[]>([]);
   const [name, setName] = useState('');
   const [agentId, setAgentId] = useState('');
   const [prompt, setPrompt] = useState('');
   const [visibility, setVisibility] = useState<'private' | 'workspace'>('workspace');
   const [showArchived, setShowArchived] = useState(false);
   const [deleting, setDeleting] = useState<QuickAction | null>(null);

   useEffect(() => {
      void loadWorkspaceAgents()
         .then(setAgents)
         .catch(() => setAgents([]));
   }, []);

   const all = useMemo(() => actions.value ?? [], [actions.value]);
   const active = useMemo(() => all.filter((entry) => !entry.archivedAt), [all]);
   const archived = useMemo(() => all.filter((entry) => entry.archivedAt), [all]);

   const badVariables = useMemo(() => unfillableVariables(prompt), [prompt]);
   const chosenAgent = agents.find((agent) => agent.id === agentId);
   // A shared action pointing at an agent only some people may start is a
   // button that fails for everybody else. Said before it is saved, not after.
   const restrictedAgent =
      visibility === 'workspace' &&
      chosenAgent?.access !== undefined &&
      chosenAgent.access.assign !== 'everyone';

   const replace = (next: QuickAction) => all.map((entry) => (entry.id === next.id ? next : entry));

   const create = async () => {
      try {
         const created = await createQuickAction(workspaceId, {
            name: name.trim(),
            targetAgentId: agentId,
            prompt,
            visibility,
         });
         actions.set([...all, created]);
         setName('');
         setPrompt('');
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : t('createFailed'));
      }
   };

   const archive = (action: QuickAction) =>
      void actions.mutate(replace({ ...action, archivedAt: new Date().toISOString() }), () =>
         archiveQuickAction(workspaceId, action.id)
      );

   const restore = async (action: QuickAction) => {
      try {
         actions.set(replace(await updateQuickAction(workspaceId, action.id, { archived: false })));
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : t('restoreFailed'));
      }
   };

   const remove = (action: QuickAction) => {
      setDeleting(null);
      void actions.mutate(
         all.filter((entry) => entry.id !== action.id),
         () => deleteQuickAction(workspaceId, action.id)
      );
   };

   const line = (action: QuickAction) => {
      const agent = agents.find((entry) => entry.id === action.targetAgentId);
      const stale = !action.archivedAt && isStale(action);
      return (
         <li key={action.id} className="flex items-start justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
               <div className="flex flex-wrap items-center gap-2">
                  <span>{action.name}</span>
                  <span className="text-muted-foreground">
                     · {agent?.name ?? t('unknownAgent')} ·{' '}
                     {action.visibility === 'private'
                        ? t('visibilityPrivate')
                        : t('visibilityTeam')}
                     {action.useCount === undefined
                        ? ''
                        : ` · ${t('runCount', { count: action.useCount })}`}
                  </span>
                  {stale ? (
                     <span
                        className="rounded-sm border border-status-warning/40 px-1.5 text-status-warning"
                        title={t('staleHint', { days: STALE_AFTER_DAYS })}
                     >
                        {t('stale')}
                     </span>
                  ) : null}
               </div>
               <p className="truncate text-muted-foreground">{action.prompt}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
               {action.archivedAt ? (
                  <>
                     <Button variant="ghost" size="sm" onClick={() => void restore(action)}>
                        {t('restore')}
                     </Button>
                     <Button
                        variant="ghost"
                        size="sm"
                        className="text-status-danger hover:text-status-danger"
                        onClick={() => setDeleting(action)}
                     >
                        {t('delete')}
                     </Button>
                  </>
               ) : (
                  <Button variant="ghost" size="sm" onClick={() => archive(action)}>
                     {t('archive')}
                  </Button>
               )}
            </div>
         </li>
      );
   };

   return (
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-8">
         <div>
            <h1 className="font-display">{t('title')}</h1>
            <p className="text-muted-foreground">
               {t('lead', {
                  variables: FILLABLE_VARIABLES.map((name) => `{{${name}}}`).join(', '),
               })}
            </p>
         </div>

         <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex gap-2">
               <Input
                  placeholder={t('namePlaceholder')}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
               />
               <Select value={agentId} onValueChange={setAgentId}>
                  <SelectTrigger className="w-48">
                     <SelectValue placeholder={t('agent')} />
                  </SelectTrigger>
                  <SelectContent>
                     {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                           {agent.name}
                        </SelectItem>
                     ))}
                  </SelectContent>
               </Select>
               <Select
                  value={visibility}
                  onValueChange={(value) => setVisibility(value as 'private' | 'workspace')}
               >
                  <SelectTrigger className="w-36">
                     <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                     <SelectItem value="workspace">{t('visibilityTeam')}</SelectItem>
                     <SelectItem value="private">{t('visibilityPrivate')}</SelectItem>
                  </SelectContent>
               </Select>
            </div>
            <Textarea
               placeholder={t('promptPlaceholder')}
               value={prompt}
               onChange={(event) => setPrompt(event.target.value)}
               rows={4}
               aria-invalid={badVariables.length > 0}
            />
            {badVariables.length > 0 ? (
               <p role="alert" className="text-status-danger">
                  {t('unfillable', { names: badVariables.map((name) => `{{${name}}}`).join(', ') })}
               </p>
            ) : null}
            {restrictedAgent ? (
               <p className="text-status-warning">
                  {t('restrictedAgent', { agent: chosenAgent?.name ?? '' })}
               </p>
            ) : null}
            <Button
               className="self-end"
               onClick={() => void create()}
               disabled={!name.trim() || !agentId || !prompt.trim() || badVariables.length > 0}
            >
               {t('add')}
            </Button>
         </div>

         {actions.error ? (
            <p role="alert" className="text-muted-foreground">
               {actions.error}
            </p>
         ) : null}

         <ul className="flex flex-col divide-y rounded-md border">
            {active.map(line)}
            {!actions.loading && active.length === 0 ? (
               <li className="px-3 py-4 text-muted-foreground">{t('empty')}</li>
            ) : null}
         </ul>

         {archived.length > 0 ? (
            <div className="flex flex-col gap-3">
               <label className="flex items-center gap-2">
                  <Switch checked={showArchived} onCheckedChange={setShowArchived} />
                  <span>{t('showArchived', { count: archived.length })}</span>
               </label>
               {showArchived ? (
                  <ul className="flex flex-col divide-y rounded-md border">{archived.map(line)}</ul>
               ) : null}
            </div>
         ) : null}

         <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>
                     {t('deleteTitle', { name: deleting?.name ?? '' })}
                  </AlertDialogTitle>
                  <AlertDialogDescription>{t('deleteBody')}</AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => deleting && remove(deleting)}>
                     {t('delete')}
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>
      </div>
   );
}
