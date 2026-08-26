'use client';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { actionTools, describeToolEffect, toolOperation } from '@/lib/integrations';
import type { FieldError } from '@/lib/plans';
import {
   BERRY_EVENTS,
   type WorkflowDefinitionInput,
   type WorkflowStepInput,
   type WorkflowTriggerType,
} from '@/lib/workflows';
import { stepIdBase } from '@/lib/workflow-definition';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/store/agents-store';
import { useMembersStore } from '@/store/members-store';
import { useProvidersStore } from '@/store/providers-store';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { useId, type ReactNode } from 'react';

/** The step kinds the trigger-first builder offers: the set Berry runs natively. */
export type StepKind =
   'create_issue' | 'update_issue' | 'agent' | 'condition' | 'wait' | 'approval' | 'action';

export const STEP_KINDS: { type: StepKind; label: string; hint: string }[] = [
   { type: 'create_issue', label: 'Create task', hint: 'Put a task on the board' },
   { type: 'update_issue', label: 'Update task', hint: 'Change status, priority or assignee' },
   { type: 'agent', label: 'Ask an agent', hint: 'One bounded instruction' },
   { type: 'condition', label: 'If', hint: 'Continue only when a value matches' },
   { type: 'wait', label: 'Wait', hint: 'A duration, an instant or an event' },
   { type: 'approval', label: 'Approval', hint: 'A person decides before it goes on' },
   { type: 'action', label: 'Action', hint: 'A tool from a connected provider' },
];

export interface StepDraft {
   key: string;
   type: StepKind;
   // create_issue
   title: string;
   description: string;
   assignAgentId: string;
   priority: string;
   waitForCompletion: boolean;
   // update_issue
   issueRef: string;
   patchStatus: string;
   patchPriority: string;
   patchAssignAgentId: string;
   // agent
   agentId: string;
   instruction: string;
   issueMode: 'inline' | 'issue';
   // condition
   left: string;
   op: string;
   right: string;
   // wait
   waitMode: 'duration' | 'until' | 'event';
   duration: string;
   until: string;
   waitEvent: string;
   // approval
   approvalTitle: string;
   approvalDescription: string;
   approverType: 'role' | 'user';
   approverRole: string;
   approverUserId: string;
   timeout: string;
   // action
   provider: string;
   operation: string;
   inputRows: { key: string; value: string }[];
}

export interface TriggerDraft {
   type: Extract<WorkflowTriggerType, 'manual' | 'berry_event' | 'webhook'>;
   event: string;
}

let draftCounter = 0;

export function newStepDraft(type: StepKind): StepDraft {
   draftCounter += 1;
   return {
      key: `step-${draftCounter}-${Date.now()}`,
      type,
      title: '',
      description: '',
      assignAgentId: '',
      priority: '',
      waitForCompletion: false,
      issueRef: '{{ trigger.issue.id }}',
      patchStatus: '',
      patchPriority: '',
      patchAssignAgentId: '',
      agentId: '',
      instruction: '',
      issueMode: 'inline',
      left: 'trigger.issue.priority',
      op: 'equals',
      right: '',
      waitMode: 'duration',
      duration: 'PT10M',
      until: '',
      waitEvent: 'issue.completed',
      approvalTitle: '',
      approvalDescription: '',
      approverType: 'role',
      approverRole: 'admin',
      approverUserId: '',
      timeout: '',
      provider: '',
      operation: '',
      inputRows: [{ key: '', value: '' }],
   };
}

/** Step ids follow the server grammar (`^[a-z][a-z0-9_]{0,63}$`) and read in order. */
export function stepIdFor(step: StepDraft, index: number): string {
   return `${stepIdBase(step.type)}_${index + 1}`;
}

/** True for a wire step type the editors below have a form for. */
export function isStepKind(type: string): type is StepKind {
   return STEP_KINDS.some((kind) => kind.type === type);
}

const TEMPLATE_REF = /^\{\{\s*([a-z][\w.]*)\s*\}\}$/;

/** `{{ trigger.issue.id }}` alone becomes a typed reference; anything else stays text. */
function valueOrRef(text: string): unknown {
   const match = TEMPLATE_REF.exec(text.trim());
   return match ? { ref: match[1] } : text;
}

/** Numbers and booleans compare as such; everything else is a string. */
function literal(text: string): unknown {
   const trimmed = text.trim();
   if (trimmed === 'true') return true;
   if (trimmed === 'false') return false;
   if (trimmed === 'null') return null;
   if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
   return text;
}

/** What is missing before this step can be sent, or null. */
export function stepDraftProblem(step: StepDraft): string | null {
   switch (step.type) {
      case 'create_issue':
         return step.title.trim() ? null : 'Give the task a title.';
      case 'update_issue':
         if (!step.issueRef.trim()) return 'Say which task to update.';
         if (!step.patchStatus && !step.patchPriority && !step.patchAssignAgentId) {
            return 'Choose at least one change.';
         }
         return null;
      case 'agent':
         return step.instruction.trim() ? null : 'Tell the agent what to do.';
      case 'condition':
         if (!step.left.trim()) return 'Name the value to check.';
         if (step.op !== 'exists' && !step.right.trim()) return 'Give the value to compare with.';
         return null;
      case 'wait':
         if (step.waitMode === 'duration' && !step.duration.trim()) return 'Give a duration.';
         if (step.waitMode === 'until' && !step.until.trim()) return 'Give an instant.';
         if (step.waitMode === 'event' && !step.waitEvent.trim()) return 'Pick an event.';
         return null;
      case 'approval':
         if (!step.approvalTitle.trim()) return 'Say what is being approved.';
         if (step.approverType === 'user' && !step.approverUserId) return 'Pick who decides.';
         return null;
      case 'action':
         if (!step.provider || !step.operation) return 'Pick a tool.';
         return null;
   }
}

/** The wire step a draft describes. Only the type's own fields; links are the caller's. */
export function toStepInput(step: StepDraft, id: string): WorkflowStepInput {
   switch (step.type) {
      case 'create_issue': {
         const out: WorkflowStepInput = { id, type: 'create_issue', title: step.title.trim() };
         if (step.description.trim()) out.description = step.description.trim();
         if (step.assignAgentId) out.assignAgentId = step.assignAgentId;
         if (step.priority) out.priority = step.priority;
         if (step.waitForCompletion) out.waitForCompletion = true;
         return out;
      }
      case 'update_issue': {
         const patch: Record<string, string> = {};
         if (step.patchStatus) patch.status = step.patchStatus;
         if (step.patchPriority) patch.priority = step.patchPriority;
         if (step.patchAssignAgentId) patch.assignAgentId = step.patchAssignAgentId;
         return { id, type: 'update_issue', issue: valueOrRef(step.issueRef), patch };
      }
      case 'agent': {
         const out: WorkflowStepInput = {
            id,
            type: 'agent',
            instruction: step.instruction.trim(),
            issueMode: step.issueMode,
         };
         if (step.agentId) out.agentId = step.agentId;
         return out;
      }
      case 'condition': {
         const expression: Record<string, unknown> = {
            op: step.op,
            left: { ref: step.left.trim() },
         };
         if (step.op !== 'exists') expression.right = literal(step.right);
         return { id, type: 'condition', expression, trueSteps: [], falseSteps: [] };
      }
      case 'wait': {
         const out: WorkflowStepInput = { id, type: 'wait', mode: step.waitMode };
         if (step.waitMode === 'duration') out.duration = step.duration.trim();
         if (step.waitMode === 'until') out.until = step.until.trim();
         if (step.waitMode === 'event') out.event = { provider: 'berry', event: step.waitEvent };
         return out;
      }
      case 'approval': {
         const out: WorkflowStepInput = {
            id,
            type: 'approval',
            title: step.approvalTitle.trim(),
            approver:
               step.approverType === 'user'
                  ? { type: 'user', userId: step.approverUserId }
                  : { type: 'role', role: step.approverRole },
         };
         if (step.approvalDescription.trim()) out.description = step.approvalDescription.trim();
         if (step.timeout.trim()) out.timeout = step.timeout.trim();
         return out;
      }
      case 'action': {
         const input: Record<string, unknown> = {};
         for (const row of step.inputRows) {
            if (row.key.trim()) input[row.key.trim()] = valueOrRef(row.value);
         }
         return { id, type: 'action', provider: step.provider, operation: step.operation, input };
      }
   }
}

function text(value: unknown): string {
   return typeof value === 'string' ? value : '';
}

/** `{ ref }` back to `{{ ref }}`, scalars to their text, anything else to JSON. */
function refText(value: unknown): string {
   if (typeof value === 'string') return value;
   if (value === null || value === undefined) return '';
   if (typeof value === 'object' && 'ref' in value) {
      const ref = (value as { ref?: unknown }).ref;
      return typeof ref === 'string' ? `{{ ${ref} }}` : '';
   }
   if (typeof value === 'number' || typeof value === 'boolean') return String(value);
   return JSON.stringify(value);
}

function record(value: unknown): Record<string, unknown> {
   return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
}

/**
 * A draft for an existing step, so the canvas edits a saved step with the
 * same form the create dialog uses. Null for a type the form does not
 * cover; the caller shows those read-only.
 */
export function draftFromStep(step: WorkflowStepInput): StepDraft | null {
   if (!isStepKind(step.type)) return null;
   const draft = newStepDraft(step.type);
   draft.key = step.id;
   switch (step.type) {
      case 'create_issue':
         draft.title = text(step.title);
         draft.description = text(step.description);
         draft.assignAgentId = text(step.assignAgentId);
         draft.priority = text(step.priority);
         draft.waitForCompletion = step.waitForCompletion === true;
         break;
      case 'update_issue': {
         const patch = record(step.patch);
         draft.issueRef = refText(step.issue);
         draft.patchStatus = text(patch.status);
         draft.patchPriority = text(patch.priority);
         draft.patchAssignAgentId = text(patch.assignAgentId);
         break;
      }
      case 'agent':
         draft.instruction = text(step.instruction);
         draft.agentId = text(step.agentId);
         draft.issueMode = step.issueMode === 'issue' ? 'issue' : 'inline';
         break;
      case 'condition': {
         const expression = record(step.expression);
         const left = expression.left;
         draft.left = typeof left === 'string' ? left : text(record(left).ref) || refText(left);
         draft.op = text(expression.op) || 'equals';
         draft.right = refText(expression.right);
         break;
      }
      case 'wait': {
         const mode = step.mode;
         draft.waitMode = mode === 'until' ? 'until' : mode === 'event' ? 'event' : 'duration';
         draft.duration = text(step.duration) || draft.duration;
         draft.until = text(step.until);
         draft.waitEvent = text(record(step.event).event) || draft.waitEvent;
         break;
      }
      case 'approval': {
         const approver = record(step.approver);
         draft.approvalTitle = text(step.title);
         draft.approvalDescription = text(step.description);
         if (approver.type === 'user') {
            draft.approverType = 'user';
            draft.approverUserId = text(approver.userId);
         } else {
            draft.approverType = 'role';
            draft.approverRole = text(approver.role) || 'admin';
         }
         draft.timeout = text(step.timeout);
         break;
      }
      case 'action': {
         draft.provider = text(step.provider);
         draft.operation = text(step.operation);
         const rows = Object.entries(record(step.input)).map(([key, value]) => ({
            key,
            value: refText(value),
         }));
         draft.inputRows = rows.length > 0 ? rows : [{ key: '', value: '' }];
         break;
      }
   }
   return draft;
}

/**
 * A straight line of steps: each runs after the one before it. A condition
 * hands the next step its true branch, so the run takes it only when the
 * check passes and prunes it otherwise.
 */
export function buildDefinition(
   trigger: TriggerDraft,
   steps: StepDraft[]
): WorkflowDefinitionInput {
   const ids = steps.map((step, index) => stepIdFor(step, index));
   const built = steps.map((step, index) => toStepInput(step, ids[index]));
   for (let index = 1; index < built.length; index += 1) {
      const previous = built[index - 1];
      if (previous.type === 'condition') {
         previous.trueSteps = [ids[index]];
      } else {
         built[index].dependsOn = [ids[index - 1]];
      }
   }
   const triggerInput: WorkflowDefinitionInput['trigger'] = { id: 'trigger', type: trigger.type };
   if (trigger.type === 'berry_event') triggerInput.event = trigger.event;
   return {
      version: '1',
      trigger: triggerInput,
      steps: built,
      entry: ids.length > 0 ? [ids[0]] : [],
   };
}

// ---------------------------------------------------------------------------
// Editors

const NONE = '__none__';

const PRIORITIES = [
   { value: 'none', label: 'No priority' },
   { value: 'urgent', label: 'Urgent' },
   { value: 'high', label: 'High' },
   { value: 'medium', label: 'Medium' },
   { value: 'low', label: 'Low' },
];

const STATUSES = [
   { value: 'backlog', label: 'Backlog' },
   { value: 'todo', label: 'Todo' },
   { value: 'inProgress', label: 'In progress' },
   { value: 'inReview', label: 'In review' },
   { value: 'done', label: 'Done' },
   { value: 'cancelled', label: 'Cancelled' },
];

const OPERATORS = [
   { value: 'equals', label: 'is' },
   { value: 'not_equals', label: 'is not' },
   { value: 'contains', label: 'contains' },
   { value: 'greater_than', label: 'is greater than' },
   { value: 'less_than', label: 'is less than' },
   { value: 'gte', label: 'is at least' },
   { value: 'lte', label: 'is at most' },
   { value: 'exists', label: 'exists' },
];

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
   const id = useId();
   return (
      <div className="flex min-w-0 flex-col gap-1">
         <Label htmlFor={id} className="text-muted-foreground">
            {label}
         </Label>
         <div id={id}>{children}</div>
         {hint && <p className="text-muted-foreground">{hint}</p>}
      </div>
   );
}

function AgentSelect({
   value,
   onChange,
   placeholder,
}: {
   value: string;
   onChange: (value: string) => void;
   placeholder: string;
}) {
   const agents = useAgentsStore((state) => state.agents);
   return (
      <Select value={value || NONE} onValueChange={(next) => onChange(next === NONE ? '' : next)}>
         <SelectTrigger className="h-8 w-full">
            <SelectValue placeholder={placeholder} />
         </SelectTrigger>
         <SelectContent>
            <SelectItem value={NONE}>{placeholder}</SelectItem>
            {agents.map((agent) => (
               <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
               </SelectItem>
            ))}
         </SelectContent>
      </Select>
   );
}

function OptionSelect({
   value,
   onChange,
   options,
   placeholder,
   allowNone = true,
}: {
   value: string;
   onChange: (value: string) => void;
   options: { value: string; label: string }[];
   placeholder: string;
   allowNone?: boolean;
}) {
   return (
      <Select value={value || NONE} onValueChange={(next) => onChange(next === NONE ? '' : next)}>
         <SelectTrigger className="h-8 w-full">
            <SelectValue placeholder={placeholder} />
         </SelectTrigger>
         <SelectContent>
            {allowNone && <SelectItem value={NONE}>{placeholder}</SelectItem>}
            {options.map((option) => (
               <SelectItem key={option.value} value={option.value}>
                  {option.label}
               </SelectItem>
            ))}
         </SelectContent>
      </Select>
   );
}

function ActionFields({
   step,
   update,
}: {
   step: StepDraft;
   update: (patch: Partial<StepDraft>) => void;
}) {
   const providers = useProvidersStore((state) => state.providers);
   const loaded = useProvidersStore((state) => state.loaded);
   const provider = providers.find((candidate) => candidate.id === step.provider);
   const tools = provider ? actionTools(provider) : [];
   const tool = tools.find((candidate) => toolOperation(candidate.name) === step.operation);
   return (
      <>
         <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Provider">
               <OptionSelect
                  value={step.provider}
                  onChange={(value) => update({ provider: value, operation: '' })}
                  options={providers.map((candidate) => ({
                     value: candidate.id,
                     label: `${candidate.name}${candidate.connected || candidate.id === 'berry' ? '' : ' · not connected'}`,
                  }))}
                  placeholder={loaded ? 'Pick a provider' : 'Loading providers…'}
               />
            </Field>
            <Field label="Tool">
               <OptionSelect
                  value={step.operation}
                  onChange={(value) => update({ operation: value })}
                  options={tools.map((candidate) => ({
                     value: toolOperation(candidate.name),
                     label: `${toolOperation(candidate.name)} · ${describeToolEffect(candidate.effect)}`,
                  }))}
                  placeholder={provider ? 'Pick a tool' : 'Pick a provider first'}
               />
            </Field>
         </div>
         {tool && (
            <p className="text-muted-foreground">
               {tool.description}
               {tool.requiresApproval && ' Needs an approval before it runs.'}
               {provider && !provider.connected && provider.id !== 'berry' && (
                  <> {provider.name} is not connected; the workflow stays a draft until it is.</>
               )}
            </p>
         )}
         <Field label="Input" hint="Values may use templates such as {{ trigger.input.text }}.">
            <div className="flex flex-col gap-1.5">
               {step.inputRows.map((row, index) => (
                  <div key={index} className="flex items-center gap-1.5">
                     <Input
                        value={row.key}
                        onChange={(event) => {
                           const rows = step.inputRows.slice();
                           rows[index] = { ...row, key: event.target.value };
                           update({ inputRows: rows });
                        }}
                        placeholder="field"
                        aria-label={`Input field ${index + 1} name`}
                        className="h-8 w-40 font-mono"
                     />
                     <Input
                        value={row.value}
                        onChange={(event) => {
                           const rows = step.inputRows.slice();
                           rows[index] = { ...row, value: event.target.value };
                           update({ inputRows: rows });
                        }}
                        placeholder="value"
                        aria-label={`Input field ${index + 1} value`}
                        className="h-8 flex-1"
                     />
                     <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0"
                        aria-label="Remove input field"
                        onClick={() =>
                           update({
                              inputRows: step.inputRows.filter((_, position) => position !== index),
                           })
                        }
                     >
                        <Trash2 className="size-3.5" />
                     </Button>
                  </div>
               ))}
               <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="w-fit"
                  onClick={() => update({ inputRows: [...step.inputRows, { key: '', value: '' }] })}
               >
                  <Plus className="size-3.5" />
                  Add field
               </Button>
            </div>
         </Field>
      </>
   );
}

function ApproverFields({
   step,
   update,
}: {
   step: StepDraft;
   update: (patch: Partial<StepDraft>) => void;
}) {
   const members = useMembersStore((state) => state.members);
   return (
      <div className="grid gap-3 sm:grid-cols-2">
         <Field label="Who decides">
            <OptionSelect
               value={step.approverType === 'user' ? 'user' : step.approverRole}
               onChange={(value) =>
                  value === 'user'
                     ? update({ approverType: 'user' })
                     : update({ approverType: 'role', approverRole: value || 'admin' })
               }
               options={[
                  { value: 'member', label: 'Any member' },
                  { value: 'admin', label: 'Any admin' },
                  { value: 'owner', label: 'The owner' },
                  { value: 'user', label: 'One person…' },
               ]}
               placeholder="Pick who decides"
               allowNone={false}
            />
         </Field>
         {step.approverType === 'user' ? (
            <Field label="Person">
               <OptionSelect
                  value={step.approverUserId}
                  onChange={(value) => update({ approverUserId: value })}
                  options={members.map((member) => ({ value: member.id, label: member.name }))}
                  placeholder="Pick a person"
               />
            </Field>
         ) : (
            <Field label="Expires after" hint="ISO 8601, e.g. P7D or PT4H. Empty never expires.">
               <Input
                  value={step.timeout}
                  onChange={(event) => update({ timeout: event.target.value })}
                  placeholder="P7D"
                  className="h-8 font-mono"
               />
            </Field>
         )}
      </div>
   );
}

interface StepEditorProps {
   step: StepDraft;
   index: number;
   count: number;
   errors: FieldError[];
   onChange: (patch: Partial<StepDraft>) => void;
   onRemove: () => void;
   onMove: (direction: -1 | 1) => void;
}

/** One step's form. The fields are the type's own; the id and order are decided for it. */
export function StepEditor({
   step,
   index,
   count,
   errors,
   onChange,
   onRemove,
   onMove,
}: StepEditorProps) {
   const kind = STEP_KINDS.find((candidate) => candidate.type === step.type);
   return (
      <li
         className={cn(
            'rounded-md border bg-background px-4 py-3',
            errors.length > 0 ? 'border-status-danger/60' : 'border-border/60'
         )}
      >
         <div className="flex items-center gap-2">
            <span className="w-5 shrink-0 text-right tabular-nums text-muted-foreground">
               {index + 1}
            </span>
            <span className="font-medium">{kind?.label ?? step.type}</span>
            <span className="font-mono text-muted-foreground">{stepIdFor(step, index)}</span>
            <div className="ml-auto flex items-center gap-0.5">
               <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="Move step up"
                  disabled={index === 0}
                  onClick={() => onMove(-1)}
               >
                  <ChevronUp className="size-3.5" />
               </Button>
               <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="Move step down"
                  disabled={index === count - 1}
                  onClick={() => onMove(1)}
               >
                  <ChevronDown className="size-3.5" />
               </Button>
               <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="Remove step"
                  onClick={onRemove}
               >
                  <Trash2 className="size-3.5" />
               </Button>
            </div>
         </div>

         <div className="mt-3 flex flex-col gap-3 pl-7">
            <StepFields step={step} onChange={onChange} errors={errors} />
         </div>
      </li>
   );
}

interface StepFieldsProps {
   step: StepDraft;
   errors: FieldError[];
   onChange: (patch: Partial<StepDraft>) => void;
}

/**
 * The fields of one step, by type, with the validator's findings for it
 * underneath. Shared by the create dialog's list and the canvas panel, so
 * a step reads the same whichever way it was reached.
 */
export function StepFields({ step, errors, onChange }: StepFieldsProps) {
   return (
      <>
         {step.type === 'create_issue' && (
            <>
               <Field label="Title" hint="Templates work: Follow up {{ trigger.issue.identifier }}">
                  <Input
                     value={step.title}
                     onChange={(event) => onChange({ title: event.target.value })}
                     placeholder="Task title"
                     className="h-8"
                  />
               </Field>
               <Field label="Description">
                  <Textarea
                     value={step.description}
                     onChange={(event) => onChange({ description: event.target.value })}
                     placeholder="Optional"
                     rows={2}
                     className="min-h-0"
                  />
               </Field>
               <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Assign to">
                     <AgentSelect
                        value={step.assignAgentId}
                        onChange={(value) => onChange({ assignAgentId: value })}
                        placeholder="Nobody"
                     />
                  </Field>
                  <Field label="Priority">
                     <OptionSelect
                        value={step.priority}
                        onChange={(value) => onChange({ priority: value })}
                        options={PRIORITIES}
                        placeholder="Default"
                     />
                  </Field>
               </div>
               <label className="flex items-center gap-2">
                  <Checkbox
                     checked={step.waitForCompletion}
                     onCheckedChange={(checked) =>
                        onChange({ waitForCompletion: checked === true })
                     }
                  />
                  <span>Wait for the task to finish before the next step</span>
               </label>
            </>
         )}

         {step.type === 'update_issue' && (
            <>
               <Field
                  label="Task"
                  hint="A task id, identifier or template such as {{ trigger.issue.id }}"
               >
                  <Input
                     value={step.issueRef}
                     onChange={(event) => onChange({ issueRef: event.target.value })}
                     className="h-8 font-mono"
                  />
               </Field>
               <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Status">
                     <OptionSelect
                        value={step.patchStatus}
                        onChange={(value) => onChange({ patchStatus: value })}
                        options={STATUSES}
                        placeholder="Leave as is"
                     />
                  </Field>
                  <Field label="Priority">
                     <OptionSelect
                        value={step.patchPriority}
                        onChange={(value) => onChange({ patchPriority: value })}
                        options={PRIORITIES}
                        placeholder="Leave as is"
                     />
                  </Field>
                  <Field label="Assign to">
                     <AgentSelect
                        value={step.patchAssignAgentId}
                        onChange={(value) => onChange({ patchAssignAgentId: value })}
                        placeholder="Leave as is"
                     />
                  </Field>
               </div>
            </>
         )}

         {step.type === 'agent' && (
            <>
               <Field label="Instruction">
                  <Textarea
                     value={step.instruction}
                     onChange={(event) => onChange({ instruction: event.target.value })}
                     placeholder="What should the agent do with {{ trigger.input }}?"
                     rows={3}
                     className="min-h-0"
                  />
               </Field>
               <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Agent">
                     <AgentSelect
                        value={step.agentId}
                        onChange={(value) => onChange({ agentId: value })}
                        placeholder="Any capable agent"
                     />
                  </Field>
                  <Field label="How">
                     <OptionSelect
                        value={step.issueMode}
                        onChange={(value) =>
                           onChange({ issueMode: value === 'issue' ? 'issue' : 'inline' })
                        }
                        options={[
                           { value: 'inline', label: 'Inline · one bounded reply' },
                           { value: 'issue', label: 'As a task · waits for the run' },
                        ]}
                        placeholder="Inline"
                        allowNone={false}
                     />
                  </Field>
               </div>
            </>
         )}

         {step.type === 'condition' && (
            <div className="grid gap-3 sm:grid-cols-3">
               <Field label="Value" hint="A reference such as trigger.issue.priority">
                  <Input
                     value={step.left}
                     onChange={(event) => onChange({ left: event.target.value })}
                     className="h-8 font-mono"
                  />
               </Field>
               <Field label="Check">
                  <OptionSelect
                     value={step.op}
                     onChange={(value) => onChange({ op: value || 'equals' })}
                     options={OPERATORS}
                     placeholder="is"
                     allowNone={false}
                  />
               </Field>
               {step.op !== 'exists' && (
                  <Field label="Compared with">
                     <Input
                        value={step.right}
                        onChange={(event) => onChange({ right: event.target.value })}
                        placeholder="urgent"
                        className="h-8"
                     />
                  </Field>
               )}
            </div>
         )}

         {step.type === 'wait' && (
            <div className="grid gap-3 sm:grid-cols-2">
               <Field label="Wait for">
                  <OptionSelect
                     value={step.waitMode}
                     onChange={(value) =>
                        onChange({
                           waitMode:
                              value === 'until'
                                 ? 'until'
                                 : value === 'event'
                                   ? 'event'
                                   : 'duration',
                        })
                     }
                     options={[
                        { value: 'duration', label: 'A duration' },
                        { value: 'until', label: 'An instant' },
                        { value: 'event', label: 'A Berry event' },
                     ]}
                     placeholder="A duration"
                     allowNone={false}
                  />
               </Field>
               {step.waitMode === 'duration' && (
                  <Field label="Duration" hint="ISO 8601: PT10M, PT2H, P1D">
                     <Input
                        value={step.duration}
                        onChange={(event) => onChange({ duration: event.target.value })}
                        className="h-8 font-mono"
                     />
                  </Field>
               )}
               {step.waitMode === 'until' && (
                  <Field label="Until" hint="RFC 3339, or a template that renders one">
                     <Input
                        value={step.until}
                        onChange={(event) => onChange({ until: event.target.value })}
                        placeholder="2026-09-01T09:00:00Z"
                        className="h-8 font-mono"
                     />
                  </Field>
               )}
               {step.waitMode === 'event' && (
                  <Field label="Event">
                     <OptionSelect
                        value={step.waitEvent}
                        onChange={(value) => onChange({ waitEvent: value })}
                        options={BERRY_EVENTS.map((entry) => ({
                           value: entry.topic,
                           label: entry.label,
                        }))}
                        placeholder="Pick an event"
                        allowNone={false}
                     />
                  </Field>
               )}
            </div>
         )}

         {step.type === 'approval' && (
            <>
               <Field label="What is being approved">
                  <Input
                     value={step.approvalTitle}
                     onChange={(event) => onChange({ approvalTitle: event.target.value })}
                     placeholder="Deploy to production?"
                     className="h-8"
                  />
               </Field>
               <Field label="Details">
                  <Textarea
                     value={step.approvalDescription}
                     onChange={(event) => onChange({ approvalDescription: event.target.value })}
                     placeholder="Optional"
                     rows={2}
                     className="min-h-0"
                  />
               </Field>
               <ApproverFields step={step} update={onChange} />
            </>
         )}

         {step.type === 'action' && <ActionFields step={step} update={onChange} />}

         {errors.length > 0 && (
            <ul className="flex flex-col gap-1" role="alert">
               {errors.map((error, position) => (
                  <li key={`${error.code}-${position}`} className="text-status-danger">
                     {error.message}
                     {error.hint && <span className="text-muted-foreground"> · {error.hint}</span>}
                  </li>
               ))}
            </ul>
         )}
      </>
   );
}
