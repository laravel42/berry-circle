'use client';

import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import type { Issue } from '@/data/issues';
import { loadIssueMetadata } from '@/lib/issue-metadata';
import { useMembersStore } from '@/store/members-store';
import { format, parseISO } from 'date-fns';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Section } from './panel-section';

/**
 * Who made this task, when, and what has been written on it since.
 *
 * The three dates were parsed off the wire and thrown away, which is the kind
 * of omission nobody notices until they are trying to work out why a task
 * exists. Metadata sits behind a dialog rather than in the sidebar because it
 * is written by integrations for integrations — valuable when you go looking,
 * noise when you are not.
 */

function when(value: string | undefined): string | null {
   if (!value) return null;
   try {
      return format(parseISO(value), 'd MMM yyyy, HH:mm');
   } catch {
      return null;
   }
}

export function IssueDetailsSection({ issue }: { issue: Issue }) {
   const t = useTranslations('issueDetail.details');
   const getMemberById = useMembersStore((state) => state.getMemberById);
   const [open, setOpen] = useState(false);
   const [metadata, setMetadata] = useState<Record<string, unknown> | null>(null);

   useEffect(() => {
      if (!open || metadata !== null) return;
      let cancelled = false;
      void loadIssueMetadata(issue.identifier)
         .then((loaded) => {
            if (!cancelled) setMetadata(loaded);
         })
         .catch(() => {
            if (!cancelled) setMetadata({});
         });
      return () => {
         cancelled = true;
      };
   }, [open, metadata, issue.identifier]);

   const creator = issue.createdBy ? getMemberById(issue.createdBy.id) : undefined;
   const created = when(issue.createdAt);
   const updated = when(issue.updatedAt);
   const entries = Object.entries(metadata ?? {});

   return (
      <Section title={t('title')}>
         <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
               <span className="shrink-0 text-muted-foreground">{t('createdBy')}</span>
               <span className="min-w-0 truncate">
                  {creator?.name ?? issue.createdBy?.name ?? t('unknown')}
               </span>
            </div>
            {created ? (
               <div className="flex items-center justify-between gap-2">
                  <span className="shrink-0 text-muted-foreground">{t('created')}</span>
                  <span className="min-w-0 truncate tabular-nums">{created}</span>
               </div>
            ) : null}
            {updated ? (
               <div className="flex items-center justify-between gap-2">
                  <span className="shrink-0 text-muted-foreground">{t('updated')}</span>
                  <span className="min-w-0 truncate tabular-nums">{updated}</span>
               </div>
            ) : null}
            <Button
               variant="ghost"
               size="xs"
               className="-ml-2 self-start"
               onClick={() => setOpen(true)}
            >
               {t('metadata')}
            </Button>
         </div>

         <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="w-full sm:max-w-[520px]">
               <DialogHeader>
                  <DialogTitle>{t('metadataTitle')}</DialogTitle>
                  <DialogDescription>{issue.identifier}</DialogDescription>
               </DialogHeader>
               {entries.length === 0 ? (
                  <p className="text-muted-foreground">{t('metadataEmpty')}</p>
               ) : (
                  <div className="overflow-x-auto">
                     <table className="w-full text-left">
                        <thead>
                           <tr className="border-b text-muted-foreground">
                              <th scope="col" className="py-1 font-normal">
                                 {t('key')}
                              </th>
                              <th scope="col" className="py-1 font-normal">
                                 {t('value')}
                              </th>
                           </tr>
                        </thead>
                        <tbody>
                           {entries.map(([key, value]) => (
                              <tr key={key} className="border-b border-border/50">
                                 <td className="py-1.5 pr-3 font-mono">{key}</td>
                                 <td className="py-1.5 break-words font-mono">
                                    {value === null ? 'null' : String(value)}
                                 </td>
                              </tr>
                           ))}
                        </tbody>
                     </table>
                  </div>
               )}
               <div className="flex justify-end">
                  <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
                     {t('close')}
                  </Button>
               </div>
            </DialogContent>
         </Dialog>
      </Section>
   );
}

export default IssueDetailsSection;
