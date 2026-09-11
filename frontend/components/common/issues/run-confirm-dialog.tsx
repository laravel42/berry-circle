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
import { useTranslations } from 'next-intl';

/**
 * Confirmation shown before handing tasks to an agent.
 *
 * A local stand-in for the run-confirmation dialog the agent workstream owns:
 * assigning work to an agent starts it spending, so the list must ask first,
 * and this keeps that promise until the real dialog lands. Swap the body for
 * theirs; the call site only needs `open`, `onConfirm` and the agent's name.
 */
export function RunConfirmDialog({
   open,
   agentName,
   taskCount,
   onOpenChange,
   onConfirm,
}: {
   open: boolean;
   agentName: string;
   taskCount: number;
   onOpenChange: (open: boolean) => void;
   onConfirm: () => void;
}) {
   const t = useTranslations('issueLists');

   return (
      <AlertDialog open={open} onOpenChange={onOpenChange}>
         <AlertDialogContent>
            <AlertDialogHeader>
               <AlertDialogTitle>{t('selection.runConfirmTitle')}</AlertDialogTitle>
               <AlertDialogDescription>
                  {t('selection.runConfirmBody', { name: agentName, count: taskCount })}
               </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
               <AlertDialogCancel>{t('selection.cancel')}</AlertDialogCancel>
               <AlertDialogAction
                  onClick={(event) => {
                     event.preventDefault();
                     onConfirm();
                     onOpenChange(false);
                  }}
               >
                  {t('selection.confirmRun')}
               </AlertDialogAction>
            </AlertDialogFooter>
         </AlertDialogContent>
      </AlertDialog>
   );
}
