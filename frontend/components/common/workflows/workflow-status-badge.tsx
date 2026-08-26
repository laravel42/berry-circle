'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import {
   STEP_RUN_STATUS,
   WORKFLOW_RUN_STATUS,
   WORKFLOW_STATUS,
   statusLook,
   type StatusLook,
} from '@/lib/catalog';
import { cn } from '@/lib/utils';

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

export function WorkflowStatusBadge({ status, className }: { status: string; className?: string }) {
   return <StatusBadge look={statusLook(WORKFLOW_STATUS, status)} className={className} />;
}

export function WorkflowRunStatusBadge({
   status,
   className,
}: {
   status: string;
   className?: string;
}) {
   return <StatusBadge look={statusLook(WORKFLOW_RUN_STATUS, status)} className={className} />;
}

/** The mark alone, for dense rows where the word is elsewhere. */
export function StepRunStatusMark({ status, className }: { status: string; className?: string }) {
   const look = statusLook(STEP_RUN_STATUS, status);
   return (
      <BerryMark
         size="sm"
         tone={look.tone}
         state={look.state}
         pulse={look.pulse}
         label={look.label}
         className={className}
      />
   );
}
