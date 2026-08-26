'use client';

import { describeWorkflowTrigger } from '@/lib/workflows';
import { cn } from '@/lib/utils';
import { Zap } from 'lucide-react';

interface WorkflowTriggerLabelProps {
   trigger: Parameters<typeof describeWorkflowTrigger>[0];
   className?: string;
}

/** "When a task is completed", "Run by hand", "When a webhook arrives", with the bolt. */
export function WorkflowTriggerLabel({ trigger, className }: WorkflowTriggerLabelProps) {
   return (
      <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
         <Zap className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
         <span className="truncate">{describeWorkflowTrigger(trigger)}</span>
      </span>
   );
}
