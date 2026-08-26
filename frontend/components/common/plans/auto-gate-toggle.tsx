'use client';

import { Button } from '@/components/ui/button';
import {
   Tooltip,
   TooltipContent,
   TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ShieldCheck } from 'lucide-react';

interface AutoGateToggleProps {
   enabled: boolean;
   onChange: (enabled: boolean) => void;
}

/**
 * AutoGate: this plan's tasks close on a peer agent's review, not a person's.
 *
 * A chip beside the project selector rather than a switch in a settings
 * section, because it belongs to the plan being written and not to the
 * workspace — turning it on here says nothing about the next plan.
 *
 * The off state is deliberately the quiet one. What this removes is the point
 * at which somebody sees an agent's work before it counts as finished, so the
 * control has to look like a decision when it is on and like nothing when it
 * is not.
 */
export function AutoGateToggle({ enabled, onChange }: AutoGateToggleProps) {
   return (
      <Tooltip>
         <TooltipTrigger asChild>
            <Button
               type="button"
               size="xs"
               variant="secondary"
               aria-pressed={enabled}
               onClick={() => onChange(!enabled)}
               className={cn(
                  'flex items-center gap-1.5',
                  enabled && 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
               )}
            >
               <ShieldCheck className="size-4" />
               AutoGate
            </Button>
         </TooltipTrigger>
         <TooltipContent className="max-w-72">
            {enabled
               ? 'On: a second agent reviews each finished task and, if it passes, moves it to Done. Nobody is asked to approve it first.'
               : 'Off: finished tasks wait in review for you. Turn on to let a peer agent approve them instead.'}
         </TooltipContent>
      </Tooltip>
   );
}
