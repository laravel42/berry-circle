'use client';

import { BerryMark, type BerryMarkState } from '@/components/brand/berry-mark';
import { Button } from '@/components/ui/button';

interface InboxPanelProps {
   title: string;
   body?: string;
   /** The mark's treatment: hollow for "nothing here", crossed for "gone". */
   state?: BerryMarkState;
   action?: { label: string; onClick: () => void };
}

/**
 * What either pane shows when it has no rows to show.
 *
 * One component for loading, empty, no-matches and failed, because the four
 * differ only in what they say and whether there is something to do about it.
 */
export function InboxPanel({ title, body, state = 'hollow', action }: InboxPanelProps) {
   return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
         <BerryMark size="lg" tone="neutral" state={state} label={title} />
         <p className="font-medium">{title}</p>
         {body ? <p className="max-w-xs leading-relaxed text-muted-foreground">{body}</p> : null}
         {action ? (
            <Button variant="outline" size="sm" onClick={action.onClick}>
               {action.label}
            </Button>
         ) : null}
      </div>
   );
}
