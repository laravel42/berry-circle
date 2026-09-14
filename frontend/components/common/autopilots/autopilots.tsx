'use client';

import { Lock, MoreHorizontal } from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import {
   archiveAutopilot,
   describeAutopilotFailure,
   updateAutopilot,
   type Autopilot,
} from '@/lib/autopilots';
import { WORKSPACE_SLUG } from '@/lib/config';

import type { AutopilotCriteria } from './autopilots-filters';

interface Props {
   autopilots: Autopilot[];
   loaded: boolean;
   error: string | null;
   criteria: AutopilotCriteria;
   /** Names for assignee ids, whether they name an agent or a squad. */
   assigneeName: (autopilot: Autopilot) => string;
   canEdit: boolean;
   onChanged: () => void;
   narrowed: boolean;
   onUseTemplate: (template: { name: string; prompt: string }) => void;
}

/** Something to start from, so an empty workspace is not an empty page. */
const TEMPLATES = ['standup', 'triage', 'sweep', 'digest', 'release', 'watch'] as const;

function sortAutopilots(list: Autopilot[], sort: AutopilotCriteria['sort']): Autopilot[] {
   const sorted = [...list];
   if (sort === 'updated') {
      sorted.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
   } else if (sort === 'created') {
      sorted.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
   } else {
      sorted.sort((left, right) => left.name.localeCompare(right.name));
   }
   return sorted;
}

/**
 * The workspace's autopilots.
 *
 * Pausing and deleting are offered per row and over a selection; a delete of
 * either size asks first, because an autopilot is a standing instruction and
 * losing one silently means work simply stops happening.
 */
export default function Autopilots({
   autopilots,
   loaded,
   error,
   criteria,
   assigneeName,
   canEdit,
   onChanged,
   narrowed,
   onUseTemplate,
}: Props) {
   const t = useTranslations('areas.autopilots');
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const [selection, setSelection] = useState<string[]>([]);
   const [confirming, setConfirming] = useState<Autopilot | null>(null);
   const [confirmingBulk, setConfirmingBulk] = useState(false);
   const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

   const rows = useMemo(
      () => sortAutopilots(autopilots, criteria.sort),
      [autopilots, criteria.sort]
   );
   const shows = (column: AutopilotCriteria['columns'][number]) =>
      criteria.columns.includes(column);
   const selected = rows.filter((row) => selection.includes(row.id));

   const fail = (failure: unknown) => toast.error(describeAutopilotFailure(failure));

   const setStatus = async (autopilot: Autopilot, status: 'active' | 'paused') => {
      try {
         await updateAutopilot(autopilot.id, { status });
         toast.success(status === 'paused' ? t('row.paused') : t('row.resumed'));
         onChanged();
      } catch (failure) {
         fail(failure);
      }
   };

   const remove = async (autopilot: Autopilot) => {
      try {
         await archiveAutopilot(autopilot.id);
         toast.success(t('row.deleted', { name: autopilot.name }));
         setSelection((current) => current.filter((id) => id !== autopilot.id));
         onChanged();
      } catch (failure) {
         fail(failure);
      }
   };

   /** One request per autopilot, counted off, so a failure names itself. */
   const walk = async (work: (autopilot: Autopilot) => Promise<unknown>, done: string) => {
      setProgress({ done: 0, total: selected.length });
      let failed = 0;
      for (const [index, autopilot] of selected.entries()) {
         try {
            await work(autopilot);
         } catch (failure) {
            failed += 1;
            if (failed === 1) fail(failure);
         }
         setProgress({ done: index + 1, total: selected.length });
      }
      setProgress(null);
      setSelection([]);
      toast.success(done);
      onChanged();
   };

   if (!loaded && !error) {
      return <div className="px-6 py-10 text-muted-foreground">{t('loading')}</div>;
   }
   if (error) {
      return (
         <div className="px-6 py-10 text-muted-foreground" role="alert">
            {error}
         </div>
      );
   }

   if (rows.length === 0) {
      return (
         <div className="px-6 py-10">
            <p className="text-muted-foreground">{narrowed ? t('noMatch') : t('empty')}</p>
            {!narrowed && canEdit ? (
               <div className="mt-6">
                  <p className="font-medium">{t('templates.title')}</p>
                  <p className="text-muted-foreground">{t('templates.hint')}</p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                     {TEMPLATES.map((key) => (
                        <button
                           key={key}
                           type="button"
                           className="cursor-pointer rounded-md border p-3 text-left hover:bg-sidebar/50"
                           onClick={() =>
                              onUseTemplate({
                                 name: t(`templates.${key}_name`),
                                 prompt: t(`templates.${key}_prompt`),
                              })
                           }
                        >
                           <span className="block font-medium">{t(`templates.${key}_name`)}</span>
                           <span className="mt-0.5 block line-clamp-2 text-muted-foreground">
                              {t(`templates.${key}_prompt`)}
                           </span>
                        </button>
                     ))}
                  </div>
               </div>
            ) : null}
         </div>
      );
   }

   return (
      <div className="flex h-full w-full flex-col">
         <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="sticky top-0 z-10 flex items-center gap-3 border-b bg-container px-6 py-1.5 text-muted-foreground">
               {canEdit ? (
                  <Checkbox
                     className="shrink-0"
                     aria-label={t('bulk.selectAll')}
                     checked={rows.length > 0 && selection.length === rows.length}
                     onCheckedChange={(checked) =>
                        setSelection(checked === true ? rows.map((row) => row.id) : [])
                     }
                  />
               ) : null}
               <div className="min-w-0 flex-1">{t('columns.autopilot')}</div>
               {shows('status') ? <div className="w-20 shrink-0">{t('columns.status')}</div> : null}
               {shows('mode') ? (
                  <div className="hidden w-40 shrink-0 lg:block">{t('columns.mode')}</div>
               ) : null}
               {shows('quota') ? (
                  <div className="hidden w-32 shrink-0 xl:block">{t('columns.quota')}</div>
               ) : null}
               {shows('updated') ? (
                  <div className="hidden w-28 shrink-0 sm:block">{t('columns.updated')}</div>
               ) : null}
               <div className="w-7 shrink-0" />
            </div>

            {rows.map((autopilot) => {
               const paused = autopilot.status === 'paused';
               return (
                  <div
                     key={autopilot.id}
                     className="flex w-full items-center gap-3 border-b px-6 py-2.5 hover:bg-accent/40"
                  >
                     {canEdit ? (
                        <Checkbox
                           className="shrink-0"
                           aria-label={t('bulk.select', { name: autopilot.name })}
                           checked={selection.includes(autopilot.id)}
                           onCheckedChange={() =>
                              setSelection((current) =>
                                 current.includes(autopilot.id)
                                    ? current.filter((id) => id !== autopilot.id)
                                    : [...current, autopilot.id]
                              )
                           }
                        />
                     ) : null}
                     <Link href={`/${orgId}/autopilot/${autopilot.id}`} className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{autopilot.name}</span>
                        <span className="block truncate text-muted-foreground">
                           {assigneeName(autopilot)}
                        </span>
                     </Link>
                     {shows('status') ? (
                        <div className="w-20 shrink-0">
                           <Badge variant={paused ? 'secondary' : 'default'}>
                              {t(`status.${autopilot.status}`)}
                           </Badge>
                        </div>
                     ) : null}
                     {shows('mode') ? (
                        <div className="hidden w-40 shrink-0 truncate text-muted-foreground lg:block">
                           {t(`mode.${autopilot.executionMode}`)}
                        </div>
                     ) : null}
                     {shows('quota') ? (
                        <div className="hidden w-32 shrink-0 text-muted-foreground xl:block">
                           {autopilot.quotaPeriod === 'none'
                              ? t('quota.none')
                              : t('quota.some', {
                                   count: autopilot.quotaMax ?? 0,
                                   period: t(`quota.${autopilot.quotaPeriod}`),
                                })}
                        </div>
                     ) : null}
                     {shows('updated') ? (
                        <div className="hidden w-28 shrink-0 text-muted-foreground sm:block">
                           {new Date(autopilot.updatedAt).toLocaleDateString()}
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
                                    <Link href={`/${orgId}/autopilot/${autopilot.id}`}>
                                       {t('row.open')}
                                    </Link>
                                 </DropdownMenuItem>
                                 <DropdownMenuItem
                                    onClick={() =>
                                       void setStatus(autopilot, paused ? 'active' : 'paused')
                                    }
                                 >
                                    {paused ? t('row.resume') : t('row.pause')}
                                 </DropdownMenuItem>
                                 <DropdownMenuSeparator />
                                 <DropdownMenuItem onClick={() => setConfirming(autopilot)}>
                                    {t('row.delete')}
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
               );
            })}
         </div>

         {canEdit && selected.length > 0 ? (
            <div className="sticky bottom-0 z-20 flex flex-wrap items-center gap-3 border-t bg-container px-6 py-2">
               <span className="font-medium">{t('bulk.selected', { count: selected.length })}</span>
               {progress ? (
                  <span className="flex items-center gap-2 text-muted-foreground">
                     <Progress
                        className="w-32"
                        value={(progress.done / Math.max(1, progress.total)) * 100}
                     />
                     {t('bulk.progress', { done: progress.done, total: progress.total })}
                  </span>
               ) : (
                  <>
                     <Button
                        size="xs"
                        variant="secondary"
                        onClick={() =>
                           void walk(
                              (autopilot) => updateAutopilot(autopilot.id, { status: 'paused' }),
                              t('bulk.pausedDone')
                           )
                        }
                     >
                        {t('bulk.pause')}
                     </Button>
                     <Button
                        size="xs"
                        variant="secondary"
                        onClick={() =>
                           void walk(
                              (autopilot) => updateAutopilot(autopilot.id, { status: 'active' }),
                              t('bulk.resumedDone')
                           )
                        }
                     >
                        {t('bulk.resume')}
                     </Button>
                     <Button size="xs" variant="secondary" onClick={() => setConfirmingBulk(true)}>
                        {t('bulk.delete')}
                     </Button>
                     <Button size="xs" variant="ghost" onClick={() => setSelection([])}>
                        {t('bulk.clear')}
                     </Button>
                  </>
               )}
            </div>
         ) : null}

         <AlertDialog
            open={confirming !== null}
            onOpenChange={(open) => !open && setConfirming(null)}
         >
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>
                     {t('row.confirmDeleteTitle', { name: confirming?.name ?? '' })}
                  </AlertDialogTitle>
                  <AlertDialogDescription>{t('row.confirmDeleteBody')}</AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                     onClick={() => {
                        const target = confirming;
                        setConfirming(null);
                        if (target) void remove(target);
                     }}
                  >
                     {t('row.delete')}
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>

         <AlertDialog open={confirmingBulk} onOpenChange={setConfirmingBulk}>
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>
                     {t('bulk.confirmDeleteTitle', { count: selected.length })}
                  </AlertDialogTitle>
                  <AlertDialogDescription>{t('bulk.confirmDeleteBody')}</AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                     onClick={() =>
                        void walk(
                           (autopilot) => archiveAutopilot(autopilot.id),
                           t('bulk.deletedDone')
                        )
                     }
                  >
                     {t('bulk.delete')}
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>
      </div>
   );
}
