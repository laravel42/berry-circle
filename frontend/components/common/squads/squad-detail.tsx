'use client';

import { Check, ChevronRight, Crown, Pencil, Trash2, Users } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

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
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
   Command,
   CommandEmpty,
   CommandGroup,
   CommandInput,
   CommandItem,
   CommandList,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import type { User } from '@/data/users';
import { BerryApiError } from '@/lib/api';
import { createAgent, loadWorkspaceAgents, type Agent } from '@/lib/agents';
import { loadWorkspaceMembers } from '@/lib/members';
import {
   archiveSquad,
   assignIssueToSquad,
   getSquad,
   setSquadMembers,
   updateSquad,
   type Squad,
   type SquadMember,
} from '@/lib/squads';
import { canEditProduct } from '@/lib/workspace-role';
import { useSessionStore } from '@/store/session-store';

const roster = (members: SquadMember[]) =>
   members.map(({ type, id, role }) => ({ type, id, role }));

/**
 * One squad: who leads it, who is in it, and what it is told to do.
 *
 * The roster is written as it is changed rather than collected into a draft —
 * making someone the leader or dropping them is a single decision, not an edit
 * session. The instructions are the opposite: they are written, so they have a
 * save of their own and a guard against walking away from unsaved words.
 */
export default function SquadDetail() {
   const t = useTranslations('areas.squads');
   const { orgId, squadId } = useParams<{ orgId: string; squadId: string }>();
   const router = useRouter();
   const workspaceId = useSessionStore((state) => state.workspace?.id);
   const canEdit = canEditProduct(useSessionStore((state) => state.workspace?.role));

   const [squad, setSquad] = useState<Squad | null>(null);
   const [error, setError] = useState<string | null>(null);
   const [agents, setAgents] = useState<Agent[]>([]);
   const [people, setPeople] = useState<User[]>([]);
   const [busy, setBusy] = useState(false);

   const [renaming, setRenaming] = useState<string | null>(null);
   const [description, setDescription] = useState('');
   const [instructions, setInstructions] = useState('');
   const [guarding, setGuarding] = useState<string | null>(null);
   const [tab, setTab] = useState('members');
   const [adding, setAdding] = useState(false);
   const [pane, setPane] = useState<'kind' | 'agent' | 'user'>('kind');
   const [newAgentName, setNewAgentName] = useState('');
   const [creatingAgent, setCreatingAgent] = useState(false);
   const [issueRef, setIssueRef] = useState('');
   const [archiving, setArchiving] = useState(false);

   const take = useCallback((next: Squad) => {
      setSquad(next);
      setDescription(next.description);
      setInstructions(next.instructions);
   }, []);

   useEffect(() => {
      let cancelled = false;
      getSquad(squadId)
         .then((found) => {
            if (!cancelled) take(found);
         })
         .catch((failure: unknown) => {
            if (!cancelled) {
               setError(
                  failure instanceof BerryApiError ? failure.message : t('detail.loadFailed')
               );
            }
         });
      void loadWorkspaceAgents().then(
         (found) => {
            if (!cancelled) setAgents(found);
         },
         () => undefined
      );
      return () => {
         cancelled = true;
      };
   }, [squadId, take, t]);

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

   if (error) return <p className="px-6 py-8 text-muted-foreground">{error}</p>;
   if (!squad) return <p className="px-6 py-8 text-muted-foreground">{t('detail.loading')}</p>;

   const current = squad;
   const leaderName =
      agents.find((agent) => agent.id === current.leaderAgentId)?.name ?? t('row.archivedAgent');
   const instructionsDirty = instructions !== current.instructions;

   const fail = (failure: unknown, fallback: string) =>
      toast.error(failure instanceof BerryApiError ? failure.message : fallback);

   const patch = async (values: Parameters<typeof updateSquad>[1], done?: string) => {
      setBusy(true);
      try {
         take(await updateSquad(current.id, values));
         if (done) toast.success(done);
      } catch (failure) {
         fail(failure, t('detail.saveFailed'));
      } finally {
         setBusy(false);
      }
   };

   const writeRoster = async (members: ReturnType<typeof roster>) => {
      setBusy(true);
      try {
         take(await setSquadMembers(current.id, members));
      } catch (failure) {
         fail(failure, t('detail.rosterFailed'));
      } finally {
         setBusy(false);
      }
   };

   const addMember = (type: 'agent' | 'user', id: string) => {
      setAdding(false);
      setPane('kind');
      void writeRoster([...roster(current.members), { type, id, role: 'member' }]);
   };

   const makeAgent = async () => {
      setBusy(true);
      try {
         const agent = await createAgent({
            name: newAgentName.trim(),
            description: t('detail.createAgentDescription', { squad: current.name }),
         });
         setAgents((list) => [...list, agent]);
         setNewAgentName('');
         setCreatingAgent(false);
         await writeRoster([
            ...roster(current.members),
            { type: 'agent', id: agent.id, role: 'member' },
         ]);
         toast.success(t('detail.agentCreated', { name: agent.name }));
      } catch (failure) {
         fail(failure, t('detail.createAgentFailed'));
      } finally {
         setBusy(false);
      }
   };

   const assign = async () => {
      setBusy(true);
      try {
         const result = await assignIssueToSquad(current.id, issueRef.trim());
         setIssueRef('');
         toast.success(
            result.runId
               ? t('detail.assignQueued', { leader: leaderName })
               : t('detail.assignLater', { leader: leaderName })
         );
      } catch (failure) {
         fail(failure, t('detail.assignFailed'));
      } finally {
         setBusy(false);
      }
   };

   const archive = async () => {
      setBusy(true);
      try {
         await archiveSquad(current.id);
         toast.success(t('archive.done', { name: current.name }));
         router.push(`/${orgId}/squads`);
      } catch (failure) {
         fail(failure, t('archive.failed'));
      } finally {
         setBusy(false);
      }
   };

   /** Nothing leaves the instructions tab while it holds unsaved words. */
   const leaveTab = (next: string) => {
      if (tab === 'instructions' && instructionsDirty && next !== 'instructions') {
         setGuarding(next);
         return;
      }
      setTab(next);
   };

   const taken = (type: 'agent' | 'user', id: string) =>
      current.members.some((member) => member.type === type && member.id === id);

   return (
      <div className="flex h-full w-full flex-col overflow-y-auto lg:flex-row">
         <aside className="flex shrink-0 flex-col gap-4 border-b px-6 py-6 lg:w-80 lg:border-b-0 lg:border-r">
            <div className="flex items-center gap-3">
               <Avatar className="size-12 shrink-0">
                  {current.avatarUrl ? <AvatarImage src={current.avatarUrl} alt="" /> : null}
                  <AvatarFallback>
                     <Users className="size-5" />
                  </AvatarFallback>
               </Avatar>
               <div className="min-w-0 flex-1">
                  {renaming === null ? (
                     <div className="flex min-w-0 items-center gap-1">
                        <h1 className="truncate font-medium">{current.name}</h1>
                        {canEdit ? (
                           <Button
                              size="icon"
                              variant="ghost"
                              className="size-6 shrink-0"
                              aria-label={t('detail.renameLabel')}
                              onClick={() => setRenaming(current.name)}
                           >
                              <Pencil className="size-3.5" />
                           </Button>
                        ) : null}
                     </div>
                  ) : (
                     <div className="flex items-center gap-1">
                        <Input
                           className="h-7"
                           value={renaming}
                           aria-label={t('detail.renameLabel')}
                           autoFocus
                           onChange={(event) => setRenaming(event.target.value)}
                           onKeyDown={(event) => {
                              if (event.key === 'Escape') setRenaming(null);
                              if (event.key === 'Enter' && renaming.trim()) {
                                 void patch({ name: renaming.trim() }, t('detail.saved'));
                                 setRenaming(null);
                              }
                           }}
                        />
                        <Button
                           size="icon"
                           variant="ghost"
                           className="size-6"
                           aria-label={t('detail.save')}
                           disabled={!renaming.trim()}
                           onClick={() => {
                              void patch({ name: renaming.trim() }, t('detail.saved'));
                              setRenaming(null);
                           }}
                        >
                           <Check className="size-3.5" />
                        </Button>
                     </div>
                  )}
               </div>
            </div>

            <label className="flex flex-col gap-1.5">
               <span className="text-muted-foreground">{t('detail.descriptionLabel')}</span>
               <Textarea
                  rows={3}
                  value={description}
                  disabled={!canEdit}
                  onChange={(event) => setDescription(event.target.value)}
                  onBlur={() => {
                     if (description !== current.description) void patch({ description });
                  }}
               />
            </label>

            <dl className="flex flex-col gap-1.5">
               <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t('detail.leader')}</dt>
                  <dd className="truncate">{leaderName}</dd>
               </div>
               <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t('columns.members')}</dt>
                  <dd>{current.members.length}</dd>
               </div>
               <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t('detail.created')}</dt>
                  <dd>{new Date(current.createdAt).toLocaleDateString()}</dd>
               </div>
               <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t('detail.updated')}</dt>
                  <dd>{new Date(current.updatedAt).toLocaleDateString()}</dd>
               </div>
            </dl>

            {canEdit ? (
               <div className="flex flex-col gap-2 border-t pt-4">
                  <span className="text-muted-foreground">{t('detail.assignTitle')}</span>
                  <p className="text-muted-foreground">
                     {t('detail.assignHint', { leader: leaderName })}
                  </p>
                  <div className="flex gap-2">
                     <Input
                        className="h-7"
                        value={issueRef}
                        aria-label={t('detail.assignLabel')}
                        placeholder={t('detail.assignLabel')}
                        onChange={(event) => setIssueRef(event.target.value)}
                     />
                     <Button
                        size="xs"
                        disabled={busy || issueRef.trim() === ''}
                        onClick={() => void assign()}
                     >
                        {t('detail.assign')}
                     </Button>
                  </div>
               </div>
            ) : null}

            {canEdit ? (
               <div className="border-t pt-4">
                  <Button
                     size="xs"
                     variant="secondary"
                     disabled={busy}
                     onClick={() => setArchiving(true)}
                  >
                     {t('row.archive')}
                  </Button>
               </div>
            ) : null}
         </aside>

         <div className="flex min-w-0 flex-1 flex-col">
            <Tabs value={tab} onValueChange={leaveTab} className="flex min-h-0 flex-1 flex-col">
               <TabsList className="mx-6 mt-4 w-fit">
                  <TabsTrigger value="members">{t('detail.tabMembers')}</TabsTrigger>
                  <TabsTrigger value="instructions">
                     {t('detail.tabInstructions')}
                     {instructionsDirty ? ' •' : ''}
                  </TabsTrigger>
               </TabsList>

               <TabsContent value="members" className="min-h-0 flex-1 px-6 py-4">
                  {current.members.length === 0 ? (
                     <p className="text-muted-foreground">{t('detail.noMembers')}</p>
                  ) : (
                     <div className="overflow-x-auto">
                        <table className="w-full">
                           <thead className="text-left text-muted-foreground">
                              <tr className="border-b">
                                 <th className="py-1.5 pr-3 font-normal">
                                    {t('detail.memberName')}
                                 </th>
                                 <th className="py-1.5 pr-3 font-normal">
                                    {t('detail.memberType')}
                                 </th>
                                 <th className="py-1.5 pr-3 font-normal">
                                    {t('detail.memberStatus')}
                                 </th>
                                 <th className="py-1.5 pr-3 font-normal">
                                    {t('detail.memberIssues')}
                                 </th>
                                 <th className="py-1.5 pr-3 font-normal">
                                    {t('detail.memberLastActive')}
                                 </th>
                                 <th className="py-1.5 pr-3 font-normal">
                                    {t('detail.memberRole')}
                                 </th>
                                 <th className="py-1.5 font-normal" />
                              </tr>
                           </thead>
                           <tbody>
                              {current.members.map((member) => {
                                 const isLeader =
                                    member.type === 'agent' && member.id === current.leaderAgentId;
                                 return (
                                    <tr key={`${member.type}:${member.id}`} className="border-b">
                                       <td className="py-2 pr-3">
                                          <span className="flex items-center gap-1.5">
                                             {isLeader ? (
                                                <Crown
                                                   className="size-3.5 shrink-0 text-muted-foreground"
                                                   aria-label={t('detail.leaderBadge')}
                                                />
                                             ) : null}
                                             <span className="truncate">{member.name}</span>
                                          </span>
                                       </td>
                                       <td className="py-2 pr-3 text-muted-foreground">
                                          {t(`detail.type_${member.type}`)}
                                       </td>
                                       <td className="py-2 pr-3 text-muted-foreground">
                                          {member.status === 'person' ? '—' : member.status}
                                       </td>
                                       <td className="py-2 pr-3 tabular-nums text-muted-foreground">
                                          {member.openIssues}
                                       </td>
                                       <td className="py-2 pr-3 text-muted-foreground">
                                          {member.lastActiveAt
                                             ? new Date(member.lastActiveAt).toLocaleDateString()
                                             : t('detail.never')}
                                       </td>
                                       <td className="py-2 pr-3">
                                          {canEdit ? (
                                             <Input
                                                className="h-7 w-32"
                                                defaultValue={member.role}
                                                aria-label={t('detail.roleOf', {
                                                   name: member.name,
                                                })}
                                                onBlur={(event) => {
                                                   const role =
                                                      event.target.value.trim() || 'member';
                                                   if (role === member.role) return;
                                                   void writeRoster(
                                                      roster(current.members).map((entry) =>
                                                         entry.type === member.type &&
                                                         entry.id === member.id
                                                            ? { ...entry, role }
                                                            : entry
                                                      )
                                                   );
                                                }}
                                             />
                                          ) : (
                                             <span className="text-muted-foreground">
                                                {member.role}
                                             </span>
                                          )}
                                       </td>
                                       <td className="py-2">
                                          {canEdit ? (
                                             <span className="flex justify-end gap-1">
                                                {member.type === 'agent' && !isLeader ? (
                                                   <Button
                                                      size="xxs"
                                                      variant="ghost"
                                                      disabled={busy}
                                                      onClick={() =>
                                                         void patch(
                                                            { leaderAgentId: member.id },
                                                            t('detail.leaderChanged', {
                                                               name: member.name,
                                                            })
                                                         )
                                                      }
                                                   >
                                                      {t('detail.makeLeader')}
                                                   </Button>
                                                ) : null}
                                                <Button
                                                   size="icon"
                                                   variant="ghost"
                                                   className="size-6"
                                                   disabled={busy}
                                                   aria-label={t('detail.remove', {
                                                      name: member.name,
                                                   })}
                                                   onClick={() =>
                                                      void writeRoster(
                                                         roster(current.members).filter(
                                                            (entry) =>
                                                               !(
                                                                  entry.type === member.type &&
                                                                  entry.id === member.id
                                                               )
                                                         )
                                                      )
                                                   }
                                                >
                                                   <Trash2 className="size-3.5" />
                                                </Button>
                                             </span>
                                          ) : null}
                                       </td>
                                    </tr>
                                 );
                              })}
                           </tbody>
                        </table>
                     </div>
                  )}

                  {canEdit ? (
                     <div className="mt-4 flex flex-wrap items-center gap-2">
                        <Popover
                           open={adding}
                           onOpenChange={(next) => {
                              setAdding(next);
                              if (!next) setPane('kind');
                           }}
                        >
                           <PopoverTrigger asChild>
                              <Button size="xs" variant="secondary">
                                 {t('detail.addMember')}
                              </Button>
                           </PopoverTrigger>
                           <PopoverContent className="w-64 p-0" align="start">
                              {pane === 'kind' ? (
                                 <Command>
                                    <CommandList>
                                       <CommandGroup>
                                          <CommandItem
                                             onSelect={() => setPane('agent')}
                                             className="justify-between"
                                          >
                                             {t('create.addAgents')}
                                             <ChevronRight className="size-4" />
                                          </CommandItem>
                                          <CommandItem
                                             onSelect={() => setPane('user')}
                                             className="justify-between"
                                          >
                                             {t('create.addPeople')}
                                             <ChevronRight className="size-4" />
                                          </CommandItem>
                                       </CommandGroup>
                                    </CommandList>
                                 </Command>
                              ) : (
                                 <Command>
                                    <CommandInput
                                       placeholder={
                                          pane === 'agent'
                                             ? t('create.searchAgents')
                                             : t('create.searchPeople')
                                       }
                                    />
                                    <CommandList>
                                       <CommandEmpty>{t('create.noneFound')}</CommandEmpty>
                                       <CommandGroup>
                                          {(pane === 'agent' ? agents : people)
                                             .filter((entry) => !taken(pane, entry.id))
                                             .map((entry) => (
                                                <CommandItem
                                                   key={entry.id}
                                                   value={entry.name}
                                                   onSelect={() => addMember(pane, entry.id)}
                                                >
                                                   {entry.name}
                                                </CommandItem>
                                             ))}
                                       </CommandGroup>
                                    </CommandList>
                                 </Command>
                              )}
                           </PopoverContent>
                        </Popover>
                        <Button size="xs" variant="ghost" onClick={() => setCreatingAgent(true)}>
                           {t('detail.createAgent')}
                        </Button>
                     </div>
                  ) : null}
               </TabsContent>

               <TabsContent value="instructions" className="min-h-0 flex-1 px-6 py-4">
                  <div className="flex max-w-3xl flex-col gap-3">
                     <p className="text-muted-foreground">{t('detail.instructionsHint')}</p>
                     <Textarea
                        rows={14}
                        value={instructions}
                        disabled={!canEdit}
                        placeholder={t('detail.instructionsPlaceholder')}
                        onChange={(event) => setInstructions(event.target.value)}
                     />
                     {canEdit ? (
                        <div className="flex items-center gap-2">
                           {instructionsDirty ? (
                              <span className="mr-auto text-muted-foreground">
                                 {t('detail.unsaved')}
                              </span>
                           ) : null}
                           <Button
                              size="xs"
                              variant="ghost"
                              disabled={!instructionsDirty || busy}
                              onClick={() => setInstructions(current.instructions)}
                           >
                              {t('detail.discard')}
                           </Button>
                           <Button
                              size="xs"
                              disabled={!instructionsDirty || busy}
                              onClick={() => void patch({ instructions }, t('detail.saved'))}
                           >
                              {t('detail.save')}
                           </Button>
                        </div>
                     ) : null}
                  </div>
               </TabsContent>
            </Tabs>
         </div>

         <Dialog open={creatingAgent} onOpenChange={setCreatingAgent}>
            <DialogContent className="sm:max-w-md">
               <DialogHeader>
                  <DialogTitle>{t('detail.createAgentTitle', { squad: current.name })}</DialogTitle>
               </DialogHeader>
               <div className="flex flex-col gap-3">
                  <label className="flex flex-col gap-1.5">
                     <span className="text-muted-foreground">{t('detail.createAgentName')}</span>
                     <Input
                        value={newAgentName}
                        onChange={(event) => setNewAgentName(event.target.value)}
                     />
                  </label>
                  <div className="flex justify-end">
                     <Button
                        size="sm"
                        disabled={busy || newAgentName.trim() === ''}
                        onClick={() => void makeAgent()}
                     >
                        {t('detail.create')}
                     </Button>
                  </div>
               </div>
            </DialogContent>
         </Dialog>

         <AlertDialog open={guarding !== null} onOpenChange={(open) => !open && setGuarding(null)}>
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>{t('detail.guardTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>{t('detail.guardBody')}</AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel>{t('detail.guardStay')}</AlertDialogCancel>
                  <AlertDialogAction
                     onClick={() => {
                        setInstructions(current.instructions);
                        if (guarding) setTab(guarding);
                        setGuarding(null);
                     }}
                  >
                     {t('detail.guardLeave')}
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>

         <AlertDialog open={archiving} onOpenChange={setArchiving}>
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>{t('archive.title', { name: current.name })}</AlertDialogTitle>
                  <AlertDialogDescription>
                     {t('archive.body', { leader: leaderName })}
                  </AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void archive()}>
                     {t('row.archive')}
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>
      </div>
   );
}
