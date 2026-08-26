'use client';

import { Button } from '@/components/ui/button';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { TRIGGER_NODE_ID, stringList, type StepLink } from '@/lib/workflow-definition';
import type { WorkflowDefinitionInput, WorkflowStepInput } from '@/lib/workflows';
import { cn } from '@/lib/utils';
import { BerryMark } from '@/components/brand/berry-mark';
import { Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { StepFields, draftFromStep, toStepInput, type StepDraft } from '../create-workflow-steps';
import { GROUP_TONE, nodeKind } from './nodes/node-kinds';
import { describeHandle, incomingOf, outgoingOf, type CanvasFinding } from './to-flow';

interface StepPanelProps {
   step: WorkflowStepInput;
   definition: WorkflowDefinitionInput;
   findings: CanvasFinding[];
   editable: boolean;
   onChange: (step: WorkflowStepInput) => void;
   onRemove: () => void;
   onDisconnect: (link: StepLink) => void;
   onSelect: (nodeId: string) => void;
}

/** The type's fields from the draft, with the links and error policy the draft does not carry. */
function applyDraft(step: WorkflowStepInput, draft: StepDraft): WorkflowStepInput {
   const built = toStepInput(draft, step.id);
   if (Array.isArray(step.dependsOn)) built.dependsOn = stringList(step.dependsOn);
   if (step.onError) built.onError = step.onError;
   if (built.type === 'condition') {
      built.trueSteps = stringList(step.trueSteps);
      built.falseSteps = stringList(step.falseSteps);
   }
   return built;
}

export function FindingList({ findings }: { findings: CanvasFinding[] }) {
   if (findings.length === 0) return null;
   return (
      <ul className="flex flex-col gap-1">
         {findings.map((finding, index) => (
            <li
               key={`${finding.message}-${index}`}
               role={finding.severity === 'error' ? 'alert' : 'status'}
               className="flex items-start gap-1.5"
            >
               <BerryMark
                  size="sm"
                  tone={finding.severity === 'error' ? 'danger' : 'attention'}
                  state="hollow"
                  className="mt-0.5"
               />
               <span className="min-w-0">
                  {finding.message}
                  {finding.hint && <span className="text-muted-foreground"> · {finding.hint}</span>}
               </span>
            </li>
         ))}
      </ul>
   );
}

function LinkRow({
   link,
   direction,
   definition,
   editable,
   onDisconnect,
   onSelect,
}: {
   link: StepLink;
   direction: 'in' | 'out';
   definition: WorkflowDefinitionInput;
   editable: boolean;
   onDisconnect: (link: StepLink) => void;
   onSelect: (nodeId: string) => void;
}) {
   const otherId = direction === 'in' ? link.source : link.target;
   const source = definition.steps.find((candidate) => candidate.id === link.source);
   const label = source ? describeHandle(source, link.handle) : '';
   const kind = nodeKind(
      otherId === TRIGGER_NODE_ID
         ? 'trigger'
         : (definition.steps.find((candidate) => candidate.id === otherId)?.type ?? 'unknown')
   );
   const Icon = kind.icon;
   return (
      <li className="flex items-center gap-1.5">
         <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent/60"
            onClick={() => onSelect(otherId)}
         >
            <Icon className={cn('size-3.5 shrink-0', GROUP_TONE[kind.group])} aria-hidden />
            <span className="truncate font-mono">{otherId}</span>
            {label && <span className="shrink-0 text-muted-foreground">{label}</span>}
         </button>
         {editable && (
            <Button
               type="button"
               variant="ghost"
               size="icon"
               className="size-6 shrink-0"
               aria-label={`Disconnect ${otherId}`}
               onClick={() => onDisconnect(link)}
            >
               <X className="size-3" />
            </Button>
         )}
      </li>
   );
}

/**
 * The selected step's fields. Edits go to the working copy at once and
 * wait for Save; the panel keeps its own draft while a person types so a
 * trailing space is not trimmed out from under them.
 */
export function StepPanel({
   step,
   definition,
   findings,
   editable,
   onChange,
   onRemove,
   onDisconnect,
   onSelect,
}: StepPanelProps) {
   const [draft, setDraft] = useState<StepDraft | null>(() => draftFromStep(step));
   const kind = nodeKind(step.type);
   const Icon = kind.icon;
   const incoming = incomingOf(definition, step.id);
   const outgoing = outgoingOf(definition, step.id);

   const change = (patch: Partial<StepDraft>) => {
      if (!draft) return;
      const next = { ...draft, ...patch };
      setDraft(next);
      onChange(applyDraft(step, next));
   };

   const { id: _id, type: _type, dependsOn: _dependsOn, onError: _onError, ...rest } = step;
   void _id;
   void _type;
   void _dependsOn;
   void _onError;

   return (
      <div className="flex flex-col gap-4">
         <div className="flex items-start gap-2">
            <Icon className={cn('mt-0.5 size-4 shrink-0', GROUP_TONE[kind.group])} aria-hidden />
            <div className="min-w-0 flex-1">
               <h3 className="font-medium">{kind.label}</h3>
               <p className="truncate font-mono text-muted-foreground">{step.id}</p>
            </div>
            {editable && (
               <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 text-muted-foreground hover:text-status-danger"
                  aria-label="Remove step"
                  onClick={onRemove}
               >
                  <Trash2 className="size-3.5" />
               </Button>
            )}
         </div>

         <FindingList findings={findings} />

         <fieldset disabled={!editable} className="flex min-w-0 flex-col gap-3">
            {draft ? (
               <StepFields step={draft} onChange={change} errors={[]} />
            ) : (
               <div>
                  <p className="text-muted-foreground">
                     {kind.supported
                        ? 'This step has no form yet.'
                        : `${kind.label} steps run in a later phase; the fields are shown as stored.`}
                  </p>
                  <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-border/60 bg-background px-3 py-2 font-mono leading-5 whitespace-pre-wrap break-all">
                     {JSON.stringify(rest, null, 2)}
                  </pre>
               </div>
            )}
            <div className="flex flex-col gap-1">
               <span className="text-muted-foreground">If it fails</span>
               <Select
                  value={step.onError ?? 'fail'}
                  onValueChange={(value) =>
                     onChange({ ...step, onError: value === 'skip' ? 'skip' : 'fail' })
                  }
               >
                  <SelectTrigger className="h-8 w-full">
                     <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                     <SelectItem value="fail">Stop the run</SelectItem>
                     <SelectItem value="skip">Skip it and carry on</SelectItem>
                  </SelectContent>
               </Select>
            </div>
         </fieldset>

         <div className="flex flex-col gap-1">
            <span className="text-muted-foreground">Runs after</span>
            {incoming.length === 0 ? (
               <p className="text-status-warning">
                  Nothing leads here. Drag from another step&apos;s handle to this one.
               </p>
            ) : (
               <ul className="flex flex-col gap-0.5">
                  {incoming.map((link) => (
                     <LinkRow
                        key={`${link.source}:${link.handle}`}
                        link={link}
                        direction="in"
                        definition={definition}
                        editable={editable}
                        onDisconnect={onDisconnect}
                        onSelect={onSelect}
                     />
                  ))}
               </ul>
            )}
         </div>
         <div className="flex flex-col gap-1">
            <span className="text-muted-foreground">Leads to</span>
            {outgoing.length === 0 ? (
               <p className="text-muted-foreground">Nothing yet; the run ends here.</p>
            ) : (
               <ul className="flex flex-col gap-0.5">
                  {outgoing.map((link) => (
                     <LinkRow
                        key={`${link.handle}:${link.target}`}
                        link={link}
                        direction="out"
                        definition={definition}
                        editable={editable}
                        onDisconnect={onDisconnect}
                        onSelect={onSelect}
                     />
                  ))}
               </ul>
            )}
         </div>
      </div>
   );
}
