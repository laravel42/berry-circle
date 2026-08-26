'use client';

import { describeWorkflowTrigger } from '@/lib/workflows';
import { cn } from '@/lib/utils';
import { useProvidersStore } from '@/store/providers-store';
import { Zap } from 'lucide-react';

interface WorkflowTriggerLabelProps {
   trigger: Parameters<typeof describeWorkflowTrigger>[0];
   className?: string;
}

/**
 * "When a task is completed", "Run by hand", "Every weekday at 09:00 ·
 * Europe/Rome", "GitHub · issues.opened", with the bolt. The provider's
 * display name comes from the catalog when a page has loaded it.
 */
export function WorkflowTriggerLabel({ trigger, className }: WorkflowTriggerLabelProps) {
   const providerName = useProvidersStore((state) =>
      trigger.provider
         ? state.providers.find((provider) => provider.id === trigger.provider)?.name
         : undefined
   );
   const text = describeWorkflowTrigger(trigger, { providerName });
   return (
      <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)} title={text}>
         <Zap className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
         <span className="truncate">{text}</span>
      </span>
   );
}
