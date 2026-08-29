'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { cn } from '@/lib/utils';
import type { StatusLook } from '@/lib/catalog';

/** A mark and a word in a pill: the shape every status in this area shares. */
export function StatusBadge({ look, className }: { look: StatusLook; className?: string }) {
   return (
      <span
         className={cn(
            'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border/60 bg-background px-2 py-0.5 text-muted-foreground',
            className
         )}
      >
         <BerryMark size="sm" tone={look.tone} state={look.state} pulse={look.pulse} />
         {look.label}
      </span>
   );
}
