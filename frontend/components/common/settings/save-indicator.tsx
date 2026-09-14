'use client';

import { Check, Loader2, TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SaveState } from './use-autosave';

/**
 * Whether the last edit landed.
 *
 * An autosaving field with no indicator asks a reader to trust that typing was
 * enough, and says nothing at all when it was not. The live region is mounted
 * even while idle so a screen reader announces the change rather than the
 * arrival of a new element.
 *
 * The failure is the state worth the most care: it names why, and offers the
 * write again, because the alternative is retyping something already typed.
 */
export function SaveIndicator({
   state,
   error,
   onRetry,
   className,
}: {
   state: SaveState;
   error?: string | null;
   onRetry?: () => void;
   className?: string;
}) {
   const t = useTranslations('workspaceAdmin.save');

   return (
      <span
         role="status"
         aria-live="polite"
         className={cn('inline-flex items-center gap-1.5 text-muted-foreground', className)}
      >
         {state === 'saving' ? (
            <>
               <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
               {t('saving')}
            </>
         ) : null}
         {state === 'saved' ? (
            <>
               <Check className="size-3.5 text-status-success" />
               {t('saved')}
            </>
         ) : null}
         {state === 'failed' ? (
            <>
               <TriangleAlert className="size-3.5 text-status-danger" />
               <span className="text-status-danger">{error ?? t('failed')}</span>
               {onRetry ? (
                  <Button size="xxs" variant="ghost" onClick={onRetry}>
                     {t('retry')}
                  </Button>
               ) : null}
            </>
         ) : null}
      </span>
   );
}
