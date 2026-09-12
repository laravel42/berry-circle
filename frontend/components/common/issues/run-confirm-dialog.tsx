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
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';

/**
 * Handing work to an agent is two decisions, not one.
 *
 * Assigning a task to an agent and starting it are usually the same act, and
 * the product treats them that way — but not always: someone tidying a backlog
 * assigns ten tasks to the agent that will eventually do them, and does not
 * mean "start ten runs now". Before this, the only way to find out which of the
 * two had happened was to watch what the agent did next.
 *
 * Shown when work is handed to an agent or a squad, and when an agent-owned
 * task leaves the backlog. Exported for the board's bulk assignment (F1), which
 * asks the same question about many tasks at once.
 */

export type RunConfirmTarget = { kind: 'agent' | 'squad'; name: string };

export interface RunConfirmRequest {
   target: RunConfirmTarget;
   /** More than one when a selection is being assigned at once. */
   count?: number;
}

export interface RunConfirmDialogProps {
   request: RunConfirmRequest | null;
   onClose: () => void;
   /**
    * Apply the assignment. `start` says whether a run should begin now.
    * Rejecting leaves the dialog open so the reader sees it did not happen.
    */
   onDecide: (start: boolean) => Promise<void> | void;
}

export function RunConfirmDialog({ request, onClose, onDecide }: RunConfirmDialogProps) {
   const t = useTranslations('issueDetail.runConfirm');
   const [pending, setPending] = useState<'start' | 'apply' | null>(null);

   const decide = useCallback(
      async (start: boolean) => {
         setPending(start ? 'start' : 'apply');
         try {
            await onDecide(start);
            onClose();
         } finally {
            setPending(null);
         }
      },
      [onDecide, onClose]
   );

   const body = !request
      ? ''
      : (request.count ?? 1) > 1
        ? t('bulkBody', { count: request.count ?? 1, name: request.target.name })
        : request.target.kind === 'squad'
          ? t('squadBody', { name: request.target.name })
          : t('agentBody', { name: request.target.name });

   return (
      <AlertDialog open={request !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
         <AlertDialogContent>
            <AlertDialogHeader>
               <AlertDialogTitle>{t('title')}</AlertDialogTitle>
               <AlertDialogDescription>{body}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
               <AlertDialogCancel disabled={pending !== null}>{t('cancel')}</AlertDialogCancel>
               {/* Not an AlertDialogAction: choosing this must not close the
                   dialog before the write has been accepted. */}
               <Button
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => void decide(false)}
               >
                  {t('applyOnly')}
               </Button>
               <AlertDialogAction
                  disabled={pending !== null}
                  onClick={(event) => {
                     event.preventDefault();
                     void decide(true);
                  }}
               >
                  {t('startNow')}
               </AlertDialogAction>
            </AlertDialogFooter>
         </AlertDialogContent>
      </AlertDialog>
   );
}

/**
 * The dialog plus the state that drives it.
 *
 * A caller asks for a decision and gets a promise back, so the assignment code
 * reads as one step rather than being split across a handler and a callback.
 */
export function useRunConfirm(): {
   dialog: React.ReactNode;
   ask: (request: RunConfirmRequest) => Promise<boolean | null>;
} {
   const [request, setRequest] = useState<RunConfirmRequest | null>(null);
   const [resolver, setResolver] = useState<{ resolve: (value: boolean | null) => void } | null>(
      null
   );

   const ask = useCallback((next: RunConfirmRequest) => {
      setRequest(next);
      return new Promise<boolean | null>((resolve) => setResolver({ resolve }));
   }, []);

   const close = useCallback(() => {
      setRequest(null);
      // Null, not false: dismissing is "I changed my mind", which is different
      // from "assign it but do not start it".
      resolver?.resolve(null);
      setResolver(null);
   }, [resolver]);

   const decide = useCallback(
      (start: boolean) => {
         resolver?.resolve(start);
         setResolver(null);
      },
      [resolver]
   );

   return {
      ask,
      dialog: <RunConfirmDialog request={request} onClose={close} onDecide={decide} />,
   };
}

export default RunConfirmDialog;
