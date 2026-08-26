'use client';

import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { BERRY_EVENTS, type WorkflowTriggerInput } from '@/lib/workflows';
import { cn } from '@/lib/utils';
import { IntegrationTriggerFields } from '../integration-trigger-fields';
import { ScheduleFields, defaultSchedule } from '../schedule-fields';
import { WebhookTriggerNotes } from '../webhook-trigger-notes';
import { GROUP_TONE, TRIGGER_KIND } from './nodes/node-kinds';
import { FindingList } from './step-panel';
import type { CanvasFinding } from './to-flow';

interface TriggerPanelProps {
   workflowId: string;
   trigger: WorkflowTriggerInput;
   findings: CanvasFinding[];
   editable: boolean;
   onChange: (trigger: WorkflowTriggerInput) => void;
}

const TRIGGER_TYPES: { value: WorkflowTriggerInput['type']; label: string; hint: string }[] = [
   { value: 'manual', label: 'By hand', hint: 'Only Run now starts it.' },
   {
      value: 'berry_event',
      label: 'A Berry event',
      hint: 'When something happens in this workspace.',
   },
   {
      value: 'schedule',
      label: 'A schedule',
      hint: 'At each instant of the schedule, on its timezone’s clock. Fires only while active.',
   },
   {
      value: 'integration',
      label: 'An integration event',
      hint: 'When a connected provider delivers the event; the delivery is trigger.payload.',
   },
   {
      value: 'webhook',
      label: 'A webhook',
      hint: 'A delivery to the hook URL starts a run; its body becomes trigger.input.',
   },
];

/** What starts the workflow: the type, then the fields that type needs. */
export function TriggerPanel({
   workflowId,
   trigger,
   findings,
   editable,
   onChange,
}: TriggerPanelProps) {
   const Icon = TRIGGER_KIND.icon;
   const known = TRIGGER_TYPES.find((entry) => entry.value === trigger.type);
   const setType = (value: string) => {
      const type = TRIGGER_TYPES.find((entry) => entry.value === value)?.value;
      if (!type) return;
      const next: WorkflowTriggerInput = { id: trigger.id || 'trigger', type };
      if (type === 'berry_event') next.event = trigger.event ?? 'issue.completed';
      if (type === 'schedule') {
         const fresh = defaultSchedule();
         next.config = {
            cron: trigger.config?.cron ?? fresh.cron,
            timezone: trigger.config?.timezone ?? fresh.timezone,
         };
      }
      if (type === 'integration') {
         next.provider = trigger.provider ?? '';
         next.operation = trigger.operation ?? '';
      }
      onChange(next);
   };
   return (
      <div className="flex flex-col gap-4">
         <div className="flex items-start gap-2">
            <Icon className={cn('mt-0.5 size-4 shrink-0', GROUP_TONE.trigger)} aria-hidden />
            <div className="min-w-0 flex-1">
               <h3 className="font-medium">Trigger</h3>
               <p className="text-muted-foreground">What starts a run.</p>
            </div>
         </div>

         <FindingList findings={findings} />

         <fieldset disabled={!editable} className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-col gap-1">
               <span className="text-muted-foreground">Starts when</span>
               {known ? (
                  <Select value={trigger.type} onValueChange={setType}>
                     <SelectTrigger className="h-8 w-full">
                        <SelectValue />
                     </SelectTrigger>
                     <SelectContent>
                        {TRIGGER_TYPES.map((entry) => (
                           <SelectItem key={entry.value} value={entry.value}>
                              {entry.label}
                           </SelectItem>
                        ))}
                     </SelectContent>
                  </Select>
               ) : (
                  <p>
                     <span className="font-mono">{trigger.type}</span>
                     <span className="text-muted-foreground">
                        {' '}
                        · {trigger.provider ?? ''} {trigger.operation ?? trigger.event ?? ''}
                     </span>
                  </p>
               )}
               <p className="text-muted-foreground">
                  {known ? known.hint : 'A trigger type this build does not know; kept as stored.'}
               </p>
            </div>
            {trigger.type === 'berry_event' && (
               <div className="flex flex-col gap-1">
                  <span className="text-muted-foreground">Event</span>
                  <Select
                     value={trigger.event ?? ''}
                     onValueChange={(event) => onChange({ ...trigger, event })}
                  >
                     <SelectTrigger className="h-8 w-full">
                        <SelectValue placeholder="Pick an event" />
                     </SelectTrigger>
                     <SelectContent>
                        {BERRY_EVENTS.map((entry) => (
                           <SelectItem key={entry.topic} value={entry.topic}>
                              {entry.label}
                           </SelectItem>
                        ))}
                     </SelectContent>
                  </Select>
                  {trigger.event && (
                     <code className="font-mono text-muted-foreground">{trigger.event}</code>
                  )}
               </div>
            )}
            {trigger.type === 'schedule' && (
               <ScheduleFields
                  compact
                  value={{
                     cron: trigger.config?.cron ?? '',
                     timezone: trigger.config?.timezone ?? '',
                  }}
                  onChange={(value) =>
                     onChange({
                        ...trigger,
                        config: { ...trigger.config, cron: value.cron, timezone: value.timezone },
                     })
                  }
               />
            )}
            {trigger.type === 'integration' && (
               <IntegrationTriggerFields
                  compact
                  value={{ provider: trigger.provider ?? '', operation: trigger.operation ?? '' }}
                  onChange={(value) =>
                     onChange({
                        ...trigger,
                        provider: value.provider,
                        operation: value.operation,
                     })
                  }
               />
            )}
         </fieldset>
         {trigger.type === 'webhook' && <WebhookTriggerNotes workflowId={workflowId} compact />}
      </div>
   );
}
