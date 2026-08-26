'use client';

import { Pill } from '@/components/common/plans/plan-sections';
import { cn } from '@/lib/utils';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo } from 'react';
import { NODE_WIDTH } from '../layout';
import type { StepFlowNode } from '../to-flow';
import { GROUP_TONE, nodeKind } from './node-kinds';

/**
 * One step on the canvas: its kind, its id, one line of what it does, and
 * the marks that matter before activating — external side effect,
 * destructive tool, approval gate, agent. A branching step lists its
 * branches at the foot so each outgoing handle sits beside its name.
 */
function StepNodeComponent({ data, selected }: NodeProps<StepFlowNode>) {
   const kind = nodeKind(data.step.type);
   const Icon = kind.icon;
   const errors = data.findings.filter((finding) => finding.severity === 'error');
   const warnings = data.findings.filter((finding) => finding.severity === 'warning');
   const branching = data.handles.length > 1 || data.handles[0] !== 'next';
   return (
      <div
         data-step-node={data.step.id}
         className={cn(
            'rounded-md border bg-container px-3 py-2 shadow-sm transition-[box-shadow,border-color]',
            selected ? 'border-foreground/50 ring-2 ring-ring/40' : 'border-border',
            errors.length > 0 && 'border-status-danger',
            errors.length === 0 && warnings.length > 0 && 'border-status-warning/70',
            !data.editable && 'opacity-90'
         )}
         style={{ width: NODE_WIDTH }}
      >
         <Handle
            type="target"
            position={Position.Left}
            id="in"
            isConnectable={data.editable}
            className="!size-2.5 !border-2 !border-border !bg-container"
         />
         <div className="flex items-center gap-1.5">
            <Icon
               className={cn(
                  'size-3.5 shrink-0',
                  data.destructive ? 'text-status-danger' : GROUP_TONE[kind.group]
               )}
               aria-hidden
            />
            <span className="shrink-0 font-medium">{data.label}</span>
            <span className="ml-auto min-w-0 truncate font-mono text-muted-foreground">
               {data.step.id}
            </span>
         </div>
         <p className="mt-0.5 truncate text-muted-foreground" title={data.text}>
            {data.text || (kind.supported ? 'Not set up yet' : kind.hint)}
         </p>
         {(data.agentName ||
            data.destructive ||
            data.external ||
            data.requiresApproval ||
            data.findings.length > 0) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
               {data.agentName && <Pill>{data.agentName}</Pill>}
               {data.destructive ? (
                  <Pill tone="danger">destructive</Pill>
               ) : data.external ? (
                  <Pill tone="attention">external</Pill>
               ) : null}
               {data.requiresApproval && <Pill tone="attention">approval</Pill>}
               {errors.length > 0 && (
                  <Pill tone="danger">
                     {errors.length} problem{errors.length === 1 ? '' : 's'}
                  </Pill>
               )}
               {errors.length === 0 && warnings.length > 0 && (
                  <Pill tone="attention">
                     {warnings.length} note{warnings.length === 1 ? '' : 's'}
                  </Pill>
               )}
            </div>
         )}
         {branching ? (
            <ul className="-mr-3 mt-1.5 flex flex-col items-end gap-0.5">
               {data.handles.map((handle) => (
                  <li key={handle} className="relative pr-3 text-muted-foreground">
                     {data.handleLabels[handle] || 'then'}
                     <Handle
                        type="source"
                        position={Position.Right}
                        id={handle}
                        isConnectable={data.editable}
                        className="!size-2.5 !border-2 !border-border !bg-container"
                     />
                  </li>
               ))}
            </ul>
         ) : (
            <Handle
               type="source"
               position={Position.Right}
               id="next"
               isConnectable={data.editable}
               className="!size-2.5 !border-2 !border-border !bg-container"
            />
         )}
      </div>
   );
}

export const StepNode = memo(StepNodeComponent);
