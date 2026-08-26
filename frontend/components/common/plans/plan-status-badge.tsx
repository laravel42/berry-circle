'use client';

import { BerryMark, type BerryMarkState, type BerryMarkTone } from '@/components/brand/berry-mark';
import { describePlanStatus, isPlanGenerating, type PlanRecord } from '@/lib/plans';
import { cn } from '@/lib/utils';

export interface PlanLook {
   tone: BerryMarkTone;
   state: BerryMarkState;
   pulse?: boolean;
   label: string;
}

/**
 * One glyph and one word for where a plan is. Generation and compile
 * outrank the record's own status because they are what the person is
 * waiting on; a draft that failed validation reads as needing fixes rather
 * than as a draft like any other.
 */
export function planLook(record: PlanRecord): PlanLook {
   if (isPlanGenerating(record)) {
      return { tone: 'working', state: 'solid', pulse: true, label: 'Planning' };
   }
   switch (record.status) {
      case 'approved':
         if (record.compile?.status === 'failed') {
            return { tone: 'danger', state: 'solid', label: 'Start failed' };
         }
         if (record.compile?.status === 'running') {
            return { tone: 'working', state: 'solid', pulse: true, label: 'Starting' };
         }
         return { tone: 'complete', state: 'solid', label: 'Started' };
      case 'pendingApproval':
         return { tone: 'attention', state: 'solid', label: describePlanStatus(record.status) };
      case 'rejected':
         return { tone: 'attention', state: 'crossed', label: 'Rejected' };
      case 'superseded':
         return { tone: 'neutral', state: 'crossed', label: 'Superseded' };
      case 'draft':
         break;
   }
   if (record.generation.status === 'failed') {
      return { tone: 'danger', state: 'solid', label: 'Planning failed' };
   }
   if (record.validation.status === 'blocked') {
      return { tone: 'attention', state: 'hollow', label: 'Needs answers' };
   }
   if (record.validation.status === 'invalid' || record.validation.errors.length > 0) {
      return { tone: 'danger', state: 'hollow', label: 'Needs fixes' };
   }
   return { tone: 'neutral', state: 'hollow', label: 'Draft' };
}

export function PlanStatusBadge({ record, className }: { record: PlanRecord; className?: string }) {
   const look = planLook(record);
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
