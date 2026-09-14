'use client';

import { X } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import AutopilotDialog from '@/components/common/autopilots/autopilot-dialog';
import { DeliveriesTable, RunsTable } from '@/components/common/autopilots/history-tabs';
import TriggersTab from '@/components/common/autopilots/triggers-tab';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
   Command,
   CommandEmpty,
   CommandGroup,
   CommandInput,
   CommandItem,
   CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { User } from '@/data/users';
import { useAutopilot } from '@/hooks/use-autopilot';
import {
   archiveAutopilot,
   describeAutopilotFailure,
   runAutopilot,
   setAutopilotMembers,
   updateAutopilot,
} from '@/lib/autopilots';
import { listBoards, type BoardSummary } from '@/lib/boards';
import { WORKSPACE_SLUG } from '@/lib/config';
import { loadWorkspaceMembers } from '@/lib/members';
import { agentHasRuntime, getAgentCoverage, type AgentCoverage } from '@/lib/runtimes';
import { listSquads, type Squad } from '@/lib/squads';
import { canEditProduct } from '@/lib/workspace-role';
import { useAgentsStore } from '@/store/agents-store';
import { useSessionStore } from '@/store/session-store';

type Member = { userId: string; role: 'collaborator' | 'subscriber' };

/**
 * One autopilot: whether it is on, what it will do, who hears about it, and
 * everything it has already done.
 *
 * "Run now" says up front why it cannot run — paused, or an assignee with
 * nowhere to run — rather than queueing a firing that is only going to be
 * skipped.
 */
export default function AutopilotDetail({ autopilotId }: { autopilotId: string }) {
   const t = useTranslations('areas.autopilots');
   const router = useRouter();
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const workspaceId = useSessionStore((state) => state.workspace?.id);
   const canEdit = canEditProduct(useSessionStore((state) => state.workspace?.role));
   const agents = useAgentsStore((state) => state.agents);

   const { autopilot, runs, deliveries, error, loading, reload } = useAutopilot(autopilotId);
   const [editing, setEditing] = useState(false);
   const [archiving, setArchiving] = useState(false);
   const [coverage, setCoverage] = useState<AgentCoverage | null>(null);
   const [squads, setSquads] = useState<Squad[]>([]);
   const [boards, setBoards] = useState<BoardSummary[]>([]);
   const [people, setPeople] = useState<User[]>([]);
   const [busy, setBusy] = useState(false);

   useEffect(() => {
      let cancelled = false;
      void getAgentCoverage().then(
         (found) => {
            if (!cancelled) setCoverage(found);
         },
         () => undefined
      );
      void listSquads().then(
         (found) => {
            if (!cancelled) setSquads(found);
         },
         () => undefined
      );
      void listBoards().then(
         (found) => {
            if (!cancelled) setBoards(found);
         },
         () => undefined
      );
      return () => {
         cancelled = true;
      };
   }, []);

   useEffect(() => {
      if (!workspaceId) return;
      let cancelled = false;
      void loadWorkspaceMembers(workspaceId).then(
         (found) => {
            if (!cancelled) setPeople(found);
         },
         () => undefined
      );
      return () => {
         cancelled = true;
      };
   }, [workspaceId]);

   if (loading)
      return <div className="px-6 py-10 text-muted-foreground">{t('detail.loading')}</div>;
   if (error || !autopilot) {
      return (
         <div className="px-6 py-10 text-muted-foreground" role="alert">
            {error ?? t('detail.loadFailed')}
         </div>
      );
   }

   const paused = autopilot.status === 'paused';
   const assigneeName =
      autopilot.assigneeType === 'squad'
         ? (squads.find((squad) => squad.id === autopilot.assigneeId)?.name ?? autopilot.assigneeId)
         : (agents.find((agent) => agent.id === autopilot.assigneeId)?.name ??
           autopilot.assigneeId);
   const squadLeader =
      autopilot.assigneeType === 'squad'
         ? squads.find((squad) => squad.id === autopilot.assigneeId)?.leaderAgentId
         : undefined;
   const runsOn = autopilot.assigneeType === 'agent' ? autopilot.assigneeId : squadLeader;
   const hasRuntime = runsOn ? agentHasRuntime(coverage, runsOn) : true;
   const blocked: 'paused' | 'noRuntime' | null = !hasRuntime
      ? 'noRuntime'
      : paused
        ? 'paused'
        : null;

   const act = async (work: () => Promise<unknown>, done: string) => {
      setBusy(true);
      try {
         await work();
         toast.success(done);
         reload();
      } catch (failure) {
         toast.error(describeAutopilotFailure(failure));
      } finally {
         setBusy(false);
      }
   };

   const members: Member[] = autopilot.members.map(({ userId, role }) => ({ userId, role }));
   const writeMembers = (next: Member[]) =>
      act(() => setAutopilotMembers(autopilot.id, next), t('detail.accessSaved'));

   const runNow = () =>
      act(async () => {
         const outcome = await runAutopilot(autopilot.id);
         if (outcome.status !== 'enqueued') {
            throw new Error(
               t('detail.notQueued', { reason: outcome.reasonCode ?? outcome.status })
            );
         }
      }, t('detail.queued'));

   const board = boards.find((entry) => entry.id === autopilot.boardId);

   return (
      <div className="w-full">
         <div className="flex flex-wrap items-start justify-between gap-3 border-b px-6 py-4">
            <div className="min-w-0">
               <Link href={`/${orgId}/autopilots`} className="text-muted-foreground">
                  {t('title')}
               </Link>
               <h1 className="mt-1 font-display tracking-[-0.025em]">{autopilot.name}</h1>
               <div className="mt-1 flex items-center gap-2 text-muted-foreground">
                  <Badge variant={paused ? 'secondary' : 'default'}>
                     {t(`status.${autopilot.status}`)}
                  </Badge>
                  <span>v{autopilot.version}</span>
               </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
               {canEdit ? (
                  <label className="flex items-center gap-2">
                     <Switch
                        checked={!paused}
                        disabled={busy}
                        aria-label={t('detail.active')}
                        onCheckedChange={(on) =>
                           void act(
                              () =>
                                 updateAutopilot(autopilot.id, {
                                    status: on ? 'active' : 'paused',
                                 }),
                              on ? t('row.resumed') : t('row.paused')
                           )
                        }
                     />
                     <span className="text-muted-foreground">{t('detail.active')}</span>
                  </label>
               ) : null}
               <Button
                  type="button"
                  size="xs"
                  disabled={busy || blocked !== null || !canEdit}
                  title={blocked ? t(`detail.blocked_${blocked}`) : undefined}
                  onClick={() => void runNow()}
               >
                  {t('detail.runNow')}
               </Button>
               {canEdit ? (
                  <Button
                     type="button"
                     size="xs"
                     variant="outline"
                     onClick={() => setEditing(true)}
                  >
                     {t('detail.edit')}
                  </Button>
               ) : (
                  <span className="text-muted-foreground">{t('row.locked')}</span>
               )}
            </div>
         </div>

         {blocked === 'noRuntime' ? (
            <div className="border-b bg-muted/40 px-6 py-3" role="status">
               <p className="font-medium">{t('detail.noRuntimeBanner', { name: assigneeName })}</p>
               <p className="text-muted-foreground">
                  {t('detail.noRuntimeHint')}{' '}
                  <Link href={`/${orgId}/runtimes`} className="underline-offset-2 hover:underline">
                     {t('detail.runtimesLink')}
                  </Link>
               </p>
            </div>
         ) : null}

         <Tabs defaultValue="triggers" className="mt-4">
            <TabsList className="mx-6">
               <TabsTrigger value="triggers">{t('detail.tabTriggers')}</TabsTrigger>
               <TabsTrigger value="runs">{t('detail.tabRuns')}</TabsTrigger>
               <TabsTrigger value="deliveries">{t('detail.tabDeliveries')}</TabsTrigger>
               <TabsTrigger value="properties">{t('detail.tabProperties')}</TabsTrigger>
            </TabsList>

            <TabsContent value="triggers">
               <TriggersTab autopilot={autopilot} canEdit={canEdit} onChanged={reload} />
            </TabsContent>

            <TabsContent value="runs">
               <RunsTable runs={runs} orgId={orgId} />
            </TabsContent>

            <TabsContent value="deliveries">
               <DeliveriesTable
                  autopilotId={autopilot.id}
                  deliveries={deliveries}
                  canReplay={canEdit}
                  onReplayed={reload}
               />
            </TabsContent>

            <TabsContent value="properties" className="px-6 py-4">
               <div className="grid max-w-3xl gap-6 lg:grid-cols-2">
                  <section className="flex flex-col gap-2">
                     <h3 className="font-medium">{t('detail.properties')}</h3>
                     <dl className="flex flex-col gap-1.5">
                        <div className="flex justify-between gap-3">
                           <dt className="text-muted-foreground">{t('detail.assignee')}</dt>
                           <dd className="truncate">{assigneeName}</dd>
                        </div>
                        <div className="flex justify-between gap-3">
                           <dt className="text-muted-foreground">{t('columns.mode')}</dt>
                           <dd>{t(`mode.${autopilot.executionMode}`)}</dd>
                        </div>
                        <div className="flex justify-between gap-3">
                           <dt className="text-muted-foreground">{t('detail.project')}</dt>
                           <dd className="truncate">{board?.name ?? '—'}</dd>
                        </div>
                        <div className="flex justify-between gap-3">
                           <dt className="text-muted-foreground">{t('columns.quota')}</dt>
                           <dd>
                              {autopilot.quotaPeriod === 'none'
                                 ? t('quota.none')
                                 : t('quota.some', {
                                      count: autopilot.quotaMax ?? 0,
                                      period: t(`quota.${autopilot.quotaPeriod}`),
                                   })}
                           </dd>
                        </div>
                        <div className="flex justify-between gap-3">
                           <dt className="text-muted-foreground">{t('detail.created')}</dt>
                           <dd>{new Date(autopilot.createdAt).toLocaleDateString()}</dd>
                        </div>
                        <div className="flex justify-between gap-3">
                           <dt className="text-muted-foreground">{t('detail.updated')}</dt>
                           <dd>{new Date(autopilot.updatedAt).toLocaleDateString()}</dd>
                        </div>
                     </dl>
                     <h3 className="mt-2 font-medium">{t('detail.runbook')}</h3>
                     <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border p-3 text-muted-foreground">
                        {autopilot.promptTemplate}
                     </pre>
                  </section>

                  <section className="flex flex-col gap-2">
                     <h3 className="font-medium">{t('detail.access')}</h3>
                     <p className="text-muted-foreground">{t('detail.accessHint')}</p>
                     {members.length === 0 ? (
                        <p className="text-muted-foreground">{t('detail.noAccess')}</p>
                     ) : (
                        <ul className="flex flex-col gap-1.5">
                           {members.map((member) => (
                              <li
                                 key={member.userId}
                                 className="flex items-center justify-between gap-3"
                              >
                                 <span className="truncate">
                                    {people.find((person) => person.id === member.userId)?.name ??
                                       member.userId}
                                 </span>
                                 <span className="flex items-center gap-2">
                                    <span className="text-muted-foreground">
                                       {t(`detail.role_${member.role}`)}
                                    </span>
                                    {canEdit ? (
                                       <Button
                                          size="icon"
                                          variant="ghost"
                                          className="size-6"
                                          disabled={busy}
                                          aria-label={t('detail.removePerson')}
                                          onClick={() =>
                                             void writeMembers(
                                                members.filter(
                                                   (entry) => entry.userId !== member.userId
                                                )
                                             )
                                          }
                                       >
                                          <X className="size-3.5" />
                                       </Button>
                                    ) : null}
                                 </span>
                              </li>
                           ))}
                        </ul>
                     )}
                     {canEdit ? (
                        <Popover>
                           <PopoverTrigger asChild>
                              <Button size="xs" variant="secondary" className="w-fit">
                                 {t('detail.addPerson')}
                              </Button>
                           </PopoverTrigger>
                           <PopoverContent className="w-64 p-0" align="start">
                              <Command>
                                 <CommandInput placeholder={t('detail.searchPeople')} />
                                 <CommandList>
                                    <CommandEmpty>{t('detail.noneFound')}</CommandEmpty>
                                    <CommandGroup>
                                       {people
                                          .filter(
                                             (person) =>
                                                !members.some(
                                                   (member) => member.userId === person.id
                                                )
                                          )
                                          .map((person) => (
                                             <CommandItem
                                                key={person.id}
                                                value={person.name}
                                                onSelect={() =>
                                                   void writeMembers([
                                                      ...members,
                                                      { userId: person.id, role: 'subscriber' },
                                                   ])
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
                     ) : null}

                     {canEdit ? (
                        <div className="mt-6 rounded-md border border-destructive/40 p-3">
                           <h3 className="font-medium">{t('detail.danger')}</h3>
                           <p className="text-muted-foreground">{t('detail.dangerHint')}</p>
                           <Button
                              size="xs"
                              variant="secondary"
                              className="mt-2"
                              disabled={busy}
                              onClick={() => setArchiving(true)}
                           >
                              {t('row.delete')}
                           </Button>
                        </div>
                     ) : null}
                  </section>
               </div>
            </TabsContent>
         </Tabs>

         <AutopilotDialog
            open={editing}
            onOpenChange={(open) => {
               setEditing(open);
               if (!open) reload();
            }}
            autopilot={autopilot}
         />

         <AlertDialog open={archiving} onOpenChange={setArchiving}>
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>
                     {t('row.confirmDeleteTitle', { name: autopilot.name })}
                  </AlertDialogTitle>
                  <AlertDialogDescription>{t('row.confirmDeleteBody')}</AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                     onClick={() =>
                        void archiveAutopilot(autopilot.id)
                           .then(() => {
                              toast.success(t('row.deleted', { name: autopilot.name }));
                              router.push(`/${orgId}/autopilots`);
                           })
                           .catch((failure: unknown) =>
                              toast.error(describeAutopilotFailure(failure))
                           )
                     }
                  >
                     {t('row.delete')}
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>
      </div>
   );
}
