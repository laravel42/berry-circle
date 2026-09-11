'use client';

import { Button } from '@/components/ui/button';
import { BerryApiError } from '@/lib/api';
import { runQuickAction } from '@/lib/issue-tracking';
import { loadQuickActions, type QuickAction } from '@/lib/quick-actions';
import { useSessionStore } from '@/store/session-store';
import { Zap } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Section } from './panel-section';

/**
 * The saved prompts this workspace can run on a task.
 *
 * A panel rather than a menu, and each row keeps its own result, because the
 * four things that can happen are genuinely different and a toast that says
 * "started" for all of them is a lie three times out of four: the run may have
 * started, it may have been folded into a run already going, it may have been
 * refused, or the agent may simply have replied in the thread.
 */

type Outcome =
   | { kind: 'started' }
   | { kind: 'folded' }
   | { kind: 'blocked'; reason: string }
   | { kind: 'commented' }
   | { kind: 'failed' };

export function IssueQuickActions({ issueRef }: { issueRef: string }) {
   const t = useTranslations('issueDetail.quickActions');
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [actions, setActions] = useState<QuickAction[]>([]);
   const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
   const [running, setRunning] = useState<string | null>(null);

   useEffect(() => {
      if (!workspaceId) return;
      let cancelled = false;
      void loadQuickActions(workspaceId)
         .then((loaded) => {
            if (!cancelled) setActions(loaded);
         })
         .catch(() => {
            if (!cancelled) setActions([]);
         });
      return () => {
         cancelled = true;
      };
   }, [workspaceId]);

   if (actions.length === 0) return null;

   const describe = (action: QuickAction, outcome: Outcome): string => {
      switch (outcome.kind) {
         case 'started':
            return t('started', { name: action.name });
         case 'folded':
            return t('folded', { name: action.name });
         case 'blocked':
            return t('blocked', { name: action.name, reason: outcome.reason });
         case 'commented':
            return t('commented', { name: action.name });
         default:
            return t('failed', { name: action.name });
      }
   };

   const run = (action: QuickAction) => {
      setRunning(action.id);
      void runQuickAction(issueRef, action.id)
         .then(
            (): Outcome => ({ kind: 'started' }),
            (cause: unknown): Outcome => {
               // The server's refusals, read back as the four things they mean.
               if (cause instanceof BerryApiError) {
                  if (cause.code === 'ACTIVE_RUN_EXISTS') return { kind: 'folded' };
                  if (cause.status === 503)
                     return { kind: 'blocked', reason: t('blockedNoRuntime') };
                  if (cause.status === 409) {
                     return { kind: 'blocked', reason: t('blockedActiveRun') };
                  }
                  if (cause.status === 403) return { kind: 'blocked', reason: cause.message };
               }
               return { kind: 'failed' };
            }
         )
         .then((outcome) => {
            setOutcomes((current) => ({ ...current, [action.id]: outcome }));
            const message = describe(action, outcome);
            if (outcome.kind === 'failed' || outcome.kind === 'blocked') toast.error(message);
            else toast.success(message);
         })
         .finally(() => setRunning(null));
   };

   return (
      <Section title={t('title')}>
         <ul className="flex flex-col gap-1.5">
            {actions.map((action) => {
               const outcome = outcomes[action.id];
               return (
                  <li key={action.id} className="flex flex-col gap-0.5">
                     <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate">{action.name}</span>
                        <Button
                           variant="ghost"
                           size="xs"
                           disabled={running !== null}
                           onClick={() => run(action)}
                        >
                           <Zap className="mr-1 size-3.5" />
                           {t('run')}
                        </Button>
                     </div>
                     {outcome ? (
                        <p
                           className={
                              outcome.kind === 'failed' || outcome.kind === 'blocked'
                                 ? 'text-status-danger'
                                 : 'text-muted-foreground'
                           }
                        >
                           {describe(action, outcome)}
                        </p>
                     ) : null}
                  </li>
               );
            })}
         </ul>
      </Section>
   );
}
