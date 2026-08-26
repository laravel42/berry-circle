'use client';

import { Pill } from '@/components/common/plans/plan-sections';
import { cn } from '@/lib/utils';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo } from 'react';
import { NODE_WIDTH } from '../layout';
import type { TriggerFlowNode } from '../to-flow';
import { GROUP_TONE, TRIGGER_KIND } from './node-kinds';

/** What starts a run. It has one outgoing edge per entry step and nothing coming in. */
function TriggerNodeComponent({ data, selected }: NodeProps<TriggerFlowNode>) {
   const Icon = TRIGGER_KIND.icon;
   const errors = data.findings.filter((finding) => finding.severity === 'error');
   return (
      <div
         data-trigger-node
         className={cn(
            'rounded-md border bg-container px-3 py-2 shadow-sm transition-[box-shadow,border-color]',
            selected ? 'border-foreground/50 ring-2 ring-ring/40' : 'border-border',
            errors.length > 0 && 'border-status-danger'
         )}
         style={{ width: NODE_WIDTH }}
      >
         <div className="flex items-center gap-1.5">
            <Icon className={cn('size-3.5 shrink-0', GROUP_TONE.trigger)} aria-hidden />
            <span className="font-medium">Trigger</span>
            <span className="ml-auto font-mono text-muted-foreground">{data.trigger.type}</span>
         </div>
         <p className="mt-0.5 truncate text-muted-foreground" title={data.label}>
            {data.label}
         </p>
         {data.findings.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
               <Pill tone={errors.length > 0 ? 'danger' : 'attention'}>
                  {data.findings.length} {errors.length > 0 ? 'problem' : 'note'}
                  {data.findings.length === 1 ? '' : 's'}
               </Pill>
            </div>
         )}
         <Handle
            type="source"
            position={Position.Right}
            id="next"
            isConnectable={data.editable}
            className="!size-2.5 !border-2 !border-border !bg-container"
         />
      </div>
   );
}

export const TriggerNode = memo(TriggerNodeComponent);
