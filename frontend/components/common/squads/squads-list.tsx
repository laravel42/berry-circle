'use client';

import { Lock, MoreHorizontal, Users } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
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
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { BerryApiError } from '@/lib/api';
import type { Agent } from '@/lib/agents';
import { archiveSquad, type Squad } from '@/lib/squads';

import type { SquadCriteria } from './squads-filters';

interface Props {
   squads: Squad[] | null;
   error: string | null;
   criteria: SquadCriteria;
   agents: Agent[];
   canEdit: boolean;
   onChanged: () => void;
   narrowed: boolean;
}

function sortSquads(squads: Squad[], sort: SquadCriteria['sort']): Squad[] {
   const sorted = [...squads];
   if (sort === 'updated') {
      sorted.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
   } else if (sort === 'members') {
      sorted.sort(
         (left, right) =>
            right.members.length - left.members.length || left.name.localeCompare(right.name)
      );
   } else {
      sorted.sort((left, right) => left.name.localeCompare(right.name));
   }
   return sorted;
}

/**
 * The workspace's squads.
 *
 * Archiving is offered here rather than only inside a squad, and says the thing
 * a person actually needs to know before doing it: the issues the squad holds
 * stay with its leader.
 */
export default function SquadsList({
   squads,
   error,
   criteria,
   agents,
   canEdit,
   onChanged,
   narrowed,
}: Props) {
   const t = useTranslations('areas.squads');
   const { orgId } = useParams<{ orgId: string }>();
   const [confirming, setConfirming] = useState<Squad | null>(null);

   const rows = useMemo(() => sortSquads(squads ?? [], criteria.sort), [squads, criteria.sort]);
   const shows = (column: SquadCriteria['columns'][number]) => criteria.columns.includes(column);
   const agentName = (id: string) =>
      agents.find((agent) => agent.id === id)?.name ?? t('row.archivedAgent');

   if (error) return <p className="px-6 py-8 text-muted-foreground">{error}</p>;
   if (squads === null) return <p className="px-6 py-8 text-muted-foreground">{t('loading')}</p>;

   const archive = async (squad: Squad) => {
      try {
         await archiveSquad(squad.id);
         toast.success(t('archive.done', { name: squad.name }));
         onChanged();
      } catch (failure) {
         toast.error(failure instanceof BerryApiError ? failure.message : t('archive.failed'));
      }
   };

   return (
      <div className="w-full">
         <div className="sticky top-0 z-10 flex items-center gap-3 border-b bg-container px-6 py-1.5 text-muted-foreground">
            <div className="min-w-0 flex-1">{t('columns.squad')}</div>
            {shows('leader') ? (
               <div className="hidden w-40 shrink-0 md:block">{t('columns.leader')}</div>
            ) : null}
            {shows('creator') ? (
               <div className="hidden w-32 shrink-0 lg:block">{t('columns.creator')}</div>
            ) : null}
            {shows('updated') ? (
               <div className="hidden w-28 shrink-0 lg:block">{t('columns.updated')}</div>
            ) : null}
            {shows('members') ? (
               <div className="w-16 shrink-0 text-right">{t('columns.members')}</div>
            ) : null}
            <div className="w-7 shrink-0" />
         </div>

         {rows.length === 0 ? (
            <p className="px-6 py-8 text-muted-foreground">
               {narrowed ? t('noMatch') : t('empty')}
            </p>
         ) : (
            rows.map((squad) => (
               <div
                  key={squad.id}
                  className="flex w-full items-center gap-3 border-b border-muted-foreground/5 px-6 py-3 hover:bg-sidebar/50"
               >
                  <Link
                     href={`/${orgId}/squads/${squad.id}`}
                     className="flex min-w-0 flex-1 items-center gap-3"
                  >
                     <Avatar className="size-7 shrink-0">
                        {squad.avatarUrl ? <AvatarImage src={squad.avatarUrl} alt="" /> : null}
                        <AvatarFallback>
                           <Users className="size-3.5" />
                        </AvatarFallback>
                     </Avatar>
                     <span className="min-w-0">
                        <span className="block truncate font-medium">{squad.name}</span>
                        {squad.description ? (
                           <span className="block truncate text-muted-foreground">
                              {squad.description}
                           </span>
                        ) : null}
                     </span>
                  </Link>
                  {shows('leader') ? (
                     <div className="hidden w-40 shrink-0 truncate text-muted-foreground md:block">
                        {agentName(squad.leaderAgentId)}
                     </div>
                  ) : null}
                  {shows('creator') ? (
                     <div className="hidden w-32 shrink-0 truncate text-muted-foreground lg:block">
                        {squad.createdBy ? t('row.someone') : t('row.unknownCreator')}
                     </div>
                  ) : null}
                  {shows('updated') ? (
                     <div className="hidden w-28 shrink-0 text-muted-foreground lg:block">
                        {new Date(squad.updatedAt).toLocaleDateString()}
                     </div>
                  ) : null}
                  {shows('members') ? (
                     <div className="w-16 shrink-0 text-right text-muted-foreground">
                        {squad.members.length}
                     </div>
                  ) : null}
                  <div className="flex w-7 shrink-0 justify-end">
                     {canEdit ? (
                        <DropdownMenu>
                           <DropdownMenuTrigger asChild>
                              <Button
                                 size="icon"
                                 variant="ghost"
                                 className="size-7"
                                 aria-label={t('row.menu')}
                              >
                                 <MoreHorizontal className="size-4" />
                              </Button>
                           </DropdownMenuTrigger>
                           <DropdownMenuContent align="end">
                              <DropdownMenuItem asChild>
                                 <Link href={`/${orgId}/squads/${squad.id}`}>{t('row.open')}</Link>
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setConfirming(squad)}>
                                 {t('row.archive')}
                              </DropdownMenuItem>
                           </DropdownMenuContent>
                        </DropdownMenu>
                     ) : (
                        <Lock
                           className="size-4 text-muted-foreground"
                           aria-label={t('row.locked')}
                        />
                     )}
                  </div>
               </div>
            ))
         )}

         <AlertDialog
            open={confirming !== null}
            onOpenChange={(open) => !open && setConfirming(null)}
         >
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>
                     {t('archive.title', { name: confirming?.name ?? '' })}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                     {t('archive.body', {
                        leader: confirming ? agentName(confirming.leaderAgentId) : '',
                     })}
                  </AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                     onClick={() => {
                        const target = confirming;
                        setConfirming(null);
                        if (target) void archive(target);
                     }}
                  >
                     {t('row.archive')}
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>
      </div>
   );
}
