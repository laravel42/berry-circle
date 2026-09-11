'use client';

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
import { loadIssueLabels, setIssueLabels, type IssueLabel } from '@/lib/issue-labels';
import { loadWorkspaceLabels } from '@/lib/labels';
import type { LabelInterface } from '@/data/labels';
import { useSessionStore } from '@/store/session-store';
import { CheckIcon, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

/**
 * The labels on this task, and the catalogue to pick from.
 *
 * Chips rather than a select, because labels are a set a reader scans rather
 * than a value they choose. Archived labels already on a task stay visible and
 * cannot be re-added once removed — the catalogue only offers live ones.
 */
export function IssueLabelPicker({ issueRef }: { issueRef: string }) {
   const t = useTranslations('issueDetail.properties');
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [current, setCurrent] = useState<IssueLabel[]>([]);
   const [catalogue, setCatalogue] = useState<LabelInterface[]>([]);
   const [open, setOpen] = useState(false);
   const [busy, setBusy] = useState(false);

   useEffect(() => {
      if (!issueRef) return;
      let cancelled = false;
      void loadIssueLabels(issueRef)
         .then((loaded) => {
            if (!cancelled) setCurrent(loaded);
         })
         .catch(() => undefined);
      return () => {
         cancelled = true;
      };
   }, [issueRef]);

   useEffect(() => {
      if (!open || !workspaceId || catalogue.length > 0) return;
      let cancelled = false;
      void loadWorkspaceLabels(workspaceId).then((loaded) => {
         if (!cancelled) setCatalogue(loaded);
      });
      return () => {
         cancelled = true;
      };
   }, [open, workspaceId, catalogue.length]);

   const write = (labelIds: string[]) => {
      setBusy(true);
      void setIssueLabels(issueRef, labelIds)
         .then(setCurrent)
         .catch(() => toast.error(t('saveFailed')))
         .finally(() => setBusy(false));
   };

   const toggle = (labelId: string) => {
      const ids = current.map((label) => label.id);
      write(ids.includes(labelId) ? ids.filter((id) => id !== labelId) : [...ids, labelId]);
   };

   return (
      <div className="flex flex-wrap items-center gap-1">
         {current.length === 0 ? (
            <span className="text-muted-foreground">{t('noLabels')}</span>
         ) : (
            current.map((label) => (
               <button
                  key={label.id}
                  type="button"
                  disabled={busy}
                  onClick={() => toggle(label.id)}
                  title={label.name}
                  className="inline-flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5"
                  style={{ borderColor: label.color, color: label.color }}
               >
                  <span className="max-w-[110px] truncate">{label.name}</span>
               </button>
            ))
         )}
         <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
               <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={t('addLabel')}
                  title={t('addLabel')}
               >
                  <Plus className="size-3.5" />
               </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-0">
               <Command>
                  <CommandInput placeholder={t('labels')} className="h-8" />
                  <CommandList>
                     <CommandEmpty>{t('noLabels')}</CommandEmpty>
                     <CommandGroup>
                        {catalogue.map((label) => {
                           const on = current.some((entry) => entry.id === label.id);
                           return (
                              <CommandItem
                                 key={label.id}
                                 value={label.name}
                                 onSelect={() => toggle(label.id)}
                              >
                                 <span
                                    className="mr-2 size-2 shrink-0 rounded-full"
                                    style={{ backgroundColor: label.color }}
                                 />
                                 <span className="min-w-0 truncate">{label.name}</span>
                                 {on ? <CheckIcon className="ml-auto size-3.5" /> : null}
                              </CommandItem>
                           );
                        })}
                     </CommandGroup>
                  </CommandList>
               </Command>
            </PopoverContent>
         </Popover>
      </div>
   );
}
