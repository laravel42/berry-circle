'use client';

import { cn } from '@/lib/utils';
import type { NodeProps } from '@xyflow/react';
import { Repeat } from 'lucide-react';
import { memo } from 'react';
import type { LoopFlowNode } from '../to-flow';
import { GROUP_TONE } from './node-kinds';

/**
 * The dashed frame around a loop's body: not a step, not selectable, sized
 * by the adapter to hold every body step with a margin. It sits behind the
 * nodes it frames and lets clicks through to the pane.
 */
function LoopNodeComponent({ data }: NodeProps<LoopFlowNode>) {
   return (
      <div
         data-loop-node={data.stepId}
         className="h-full w-full rounded-lg border border-dashed border-status-info/60 bg-status-info/5"
      >
         <span
            className={cn(
               'absolute left-2 top-1 inline-flex items-center gap-1 font-medium',
               GROUP_TONE.logic
            )}
         >
            <Repeat className="size-3" aria-hidden />
            {data.label}
         </span>
      </div>
   );
}

export const LoopNode = memo(LoopNodeComponent);
