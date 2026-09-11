'use client';

import { Button } from '@/components/ui/button';
import type { Issue } from '@/data/issues';
import { patchBoardIssue } from '@/lib/issues';
import { useIssuesStore } from '@/store/issues-store';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

/**
 * The task's title, edited where it is read.
 *
 * A title is the one field everybody fixes and nobody opens a form for: it is
 * wrong by a word, and the cost of correcting it should be a click. Saving on
 * blur as well as on Enter, because someone who has retyped a title and then
 * clicked away has finished editing whatever their keyboard says.
 */
export function IssueTitle({ issue }: { issue: Issue }) {
   const t = useTranslations('issueDetail.title');
   const updateIssue = useIssuesStore((state) => state.updateIssue);
   const [editing, setEditing] = useState(false);
   const [draft, setDraft] = useState(issue.title);
   const field = useRef<HTMLTextAreaElement>(null);

   useEffect(() => {
      if (!editing) setDraft(issue.title);
   }, [issue.title, editing]);

   useEffect(() => {
      if (editing) field.current?.focus();
   }, [editing]);

   const commit = () => {
      const title = draft.trim();
      setEditing(false);
      if (!title) {
         setDraft(issue.title);
         toast.error(t('empty'));
         return;
      }
      if (title === issue.title) return;
      const previous = issue.title;
      updateIssue(issue.id, { title });
      void patchBoardIssue(issue.id, { title }).catch(() => {
         updateIssue(issue.id, { title: previous });
         setDraft(previous);
         toast.error(t('failed'));
      });
   };

   if (!editing) {
      return (
         <div className="group flex items-start gap-2">
            <h1 className="min-w-0 flex-1 text-balance font-display leading-[1.08] tracking-[-0.025em]">
               {issue.title}
            </h1>
            <Button
               variant="ghost"
               size="xs"
               className="mt-1 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
               onClick={() => setEditing(true)}
            >
               {t('edit')}
            </Button>
         </div>
      );
   }

   return (
      <textarea
         ref={field}
         value={draft}
         aria-label={t('edit')}
         rows={1}
         className="field-sizing-content w-full resize-none text-balance bg-transparent font-display leading-[1.08] tracking-[-0.025em] outline-none"
         onChange={(event) => setDraft(event.target.value)}
         onBlur={commit}
         onKeyDown={(event) => {
            if (event.key === 'Enter') {
               event.preventDefault();
               commit();
            }
            if (event.key === 'Escape') {
               event.preventDefault();
               setDraft(issue.title);
               setEditing(false);
            }
         }}
      />
   );
}
