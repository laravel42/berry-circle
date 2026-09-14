'use client';

import { Button } from '@/components/ui/button';
import type { Issue } from '@/data/issues';
import { setParent } from '@/lib/issue-tracking';
import { getBoardIssue } from '@/lib/issues';
import { useIssuesStore } from '@/store/issues-store';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Section } from './panel-section';

/** The task this one sits under, and the way out of it. */
export function IssueParentSection({ issue }: { issue: Issue }) {
   const t = useTranslations('issueDetail.parent');
   const { orgId } = useParams<{ orgId: string }>();
   const updateIssue = useIssuesStore((state) => state.updateIssue);
   const [parent, setParentIssue] = useState<Issue | null>(null);
   const [busy, setBusy] = useState(false);

   useEffect(() => {
      if (!issue.parentId) {
         setParentIssue(null);
         return;
      }
      let cancelled = false;
      void getBoardIssue(issue.parentId).then((found) => {
         if (!cancelled) setParentIssue(found ?? null);
      });
      return () => {
         cancelled = true;
      };
   }, [issue.parentId]);

   if (!issue.parentId) return null;

   const remove = () => {
      setBusy(true);
      void setParent(issue.identifier, null, null)
         .then(() => {
            updateIssue(issue.id, { parentId: null, stage: null });
            setParentIssue(null);
            toast.success(t('removed'));
         })
         .catch(() => toast.error(t('removeFailed')))
         .finally(() => setBusy(false));
   };

   return (
      <Section title={t('title')}>
         <div className="flex min-w-0 items-center gap-2">
            {parent ? (
               <Link
                  href={`/${orgId}/issue/${parent.identifier}`}
                  className="flex min-w-0 items-center gap-1.5 hover:underline"
               >
                  <span className="shrink-0 text-muted-foreground">{parent.identifier}</span>
                  <span className="min-w-0 truncate">{parent.title}</span>
               </Link>
            ) : (
               <span className="min-w-0 truncate text-muted-foreground">{issue.parentId}</span>
            )}
            <Button
               variant="ghost"
               size="icon"
               className="ml-auto size-6 shrink-0"
               aria-label={t('remove')}
               title={t('remove')}
               disabled={busy}
               onClick={remove}
            >
               <X className="size-3.5" />
            </Button>
         </div>
      </Section>
   );
}
