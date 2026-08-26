import {
   Bot,
   Braces,
   CircleHelp,
   Clock,
   GitBranch,
   ListPlus,
   PencilLine,
   Plug,
   Repeat,
   ShieldCheck,
   Split,
   Workflow,
   Zap,
   type LucideIcon,
} from 'lucide-react';

/**
 * How each step type shows on the canvas and in the palette. The group
 * decides the icon's tone: what starts a run, what steers it, what makes
 * work happen in Berry, and what reaches outside.
 */

export type NodeGroup = 'trigger' | 'logic' | 'work' | 'actions';

export interface NodeKind {
   type: string;
   label: string;
   hint: string;
   group: NodeGroup;
   icon: LucideIcon;
   /** True for the types this build has a form for; an unknown type is shown as stored. */
   supported: boolean;
}

export const GROUP_TONE: Record<NodeGroup, string> = {
   trigger: 'text-berry',
   logic: 'text-status-info',
   work: 'text-status-success',
   actions: 'text-status-warning',
};

export const GROUP_LABEL: Record<NodeGroup, string> = {
   trigger: 'Triggers',
   logic: 'Logic',
   work: 'Work',
   actions: 'Actions',
};

export const TRIGGER_KIND: NodeKind = {
   type: 'trigger',
   label: 'Trigger',
   hint: 'What starts a run',
   group: 'trigger',
   icon: Zap,
   supported: true,
};

export const NODE_KINDS: NodeKind[] = [
   {
      type: 'create_issue',
      label: 'Create task',
      hint: 'Put a task on the board',
      group: 'work',
      icon: ListPlus,
      supported: true,
   },
   {
      type: 'update_issue',
      label: 'Update task',
      hint: 'Change status, priority or assignee',
      group: 'work',
      icon: PencilLine,
      supported: true,
   },
   {
      type: 'agent',
      label: 'Ask an agent',
      hint: 'One bounded instruction',
      group: 'work',
      icon: Bot,
      supported: true,
   },
   {
      type: 'approval',
      label: 'Approval',
      hint: 'A person decides before it goes on',
      group: 'work',
      icon: ShieldCheck,
      supported: true,
   },
   {
      type: 'condition',
      label: 'If',
      hint: 'Continue only when a value matches',
      group: 'logic',
      icon: GitBranch,
      supported: true,
   },
   {
      type: 'wait',
      label: 'Wait',
      hint: 'A duration, an instant or an event',
      group: 'logic',
      icon: Clock,
      supported: true,
   },
   {
      type: 'action',
      label: 'Action',
      hint: 'A tool from a connected provider',
      group: 'actions',
      icon: Plug,
      supported: true,
   },
   {
      type: 'switch',
      label: 'Switch',
      hint: 'One branch per value',
      group: 'logic',
      icon: Split,
      supported: true,
   },
   {
      type: 'foreach',
      label: 'For each',
      hint: 'Repeat steps over a list',
      group: 'logic',
      icon: Repeat,
      supported: true,
   },
   {
      type: 'transform',
      label: 'Transform',
      hint: 'Shape values for the next step',
      group: 'logic',
      icon: Braces,
      supported: true,
   },
   {
      type: 'subworkflow',
      label: 'Run workflow',
      hint: 'Hand off to another workflow',
      group: 'actions',
      icon: Workflow,
      supported: true,
   },
];

const UNKNOWN_KIND: NodeKind = {
   type: 'unknown',
   label: 'Step',
   hint: 'A step this build does not know',
   group: 'logic',
   icon: CircleHelp,
   supported: false,
};

export function nodeKind(type: string): NodeKind {
   if (type === 'trigger') return TRIGGER_KIND;
   return NODE_KINDS.find((kind) => kind.type === type) ?? { ...UNKNOWN_KIND, label: type };
}
