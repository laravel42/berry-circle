import { findTool, type Provider } from '@/lib/integrations';
import { describePlanStep, planStepSchema } from '@/lib/plans';
import {
   TRIGGER_NODE_ID,
   sourceHandles,
   stepLinks,
   stringList,
   type LinkHandle,
   type StepLink,
} from '@/lib/workflow-definition';
import {
   describeWorkflowTrigger,
   type WorkflowDefinitionInput,
   type WorkflowStepInput,
   type WorkflowTriggerInput,
} from '@/lib/workflows';
import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type { CanvasLayout } from './layout';
import { nodeKind } from './nodes/node-kinds';

/**
 * The view adapter: a definition and a layout in, React Flow nodes and
 * edges out. Nothing React Flow produces is kept beyond the positions; the
 * definition stays the truth and every render derives the graph from it.
 */

export interface CanvasFinding {
   message: string;
   severity: 'error' | 'warning';
   hint?: string | null;
}

export type StepNodeData = {
   kind: 'step';
   step: WorkflowStepInput;
   label: string;
   text: string;
   external: boolean;
   destructive: boolean;
   requiresApproval: boolean;
   agentName: string | null;
   findings: CanvasFinding[];
   editable: boolean;
   handles: LinkHandle[];
   handleLabels: Record<string, string>;
   [key: string]: unknown;
};

export type TriggerNodeData = {
   kind: 'trigger';
   trigger: WorkflowTriggerInput;
   label: string;
   findings: CanvasFinding[];
   editable: boolean;
   [key: string]: unknown;
};

export type StepFlowNode = Node<StepNodeData, 'step'>;
export type TriggerFlowNode = Node<TriggerNodeData, 'trigger'>;
export type CanvasNode = StepFlowNode | TriggerFlowNode;

export type CanvasEdgeData = {
   link: StepLink;
   [key: string]: unknown;
};

export type CanvasEdge = Edge<CanvasEdgeData>;

export interface ToFlowOptions {
   editable: boolean;
   /** Findings keyed by step id; `null` holds the trigger's and the definition's own. */
   findings: Map<string | null, CanvasFinding[]>;
   agents: { id: string; name: string }[];
   providers: Provider[];
   selectedNodeId: string | null;
   selectedEdgeId: string | null;
}

export function edgeId(link: StepLink): string {
   return `${link.source}:${link.handle}->${link.target}`;
}

/** "true", "false", "default", "each", or "= value" for a switch case. */
export function describeHandle(step: WorkflowStepInput, handle: LinkHandle): string {
   if (handle === 'next') return '';
   if (handle.startsWith('case:')) {
      const index = Number.parseInt(handle.slice('case:'.length), 10);
      const cases = Array.isArray(step.cases) ? step.cases : [];
      const entry = cases[index];
      const equals =
         typeof entry === 'object' && entry !== null
            ? (entry as { equals?: unknown }).equals
            : undefined;
      return `= ${typeof equals === 'string' ? equals : JSON.stringify(equals ?? null)}`;
   }
   return handle;
}

function summarise(step: WorkflowStepInput): {
   label: string;
   text: string;
   external: boolean;
   approval: boolean;
} {
   const parsed = planStepSchema.safeParse(step);
   const kind = nodeKind(step.type);
   if (!parsed.success || parsed.data.type === 'unknown') {
      return { label: kind.label, text: '', external: false, approval: step.type === 'approval' };
   }
   const summary = describePlanStep(parsed.data);
   return {
      label: kind.label,
      text: summary.text,
      external: summary.external,
      approval: summary.approval,
   };
}

function stepNode(
   step: WorkflowStepInput,
   layout: CanvasLayout,
   options: ToFlowOptions
): StepFlowNode {
   const summary = summarise(step);
   const agentId =
      step.type === 'agent'
         ? step.agentId
         : step.type === 'create_issue'
           ? step.assignAgentId
           : step.type === 'update_issue' && typeof step.patch === 'object' && step.patch !== null
             ? (step.patch as { assignAgentId?: unknown }).assignAgentId
             : undefined;
   const agentName =
      typeof agentId === 'string'
         ? (options.agents.find((agent) => agent.id === agentId)?.name ?? null)
         : null;
   const tool =
      step.type === 'action' &&
      typeof step.provider === 'string' &&
      typeof step.operation === 'string'
         ? findTool(options.providers, step.provider, step.operation)?.tool
         : undefined;
   const handles = sourceHandles(step);
   const handleLabels: Record<string, string> = {};
   for (const handle of handles) handleLabels[handle] = describeHandle(step, handle);
   return {
      id: step.id,
      type: 'step',
      position: layout[step.id] ?? { x: 0, y: 0 },
      selected: options.selectedNodeId === step.id,
      draggable: options.editable,
      connectable: options.editable,
      deletable: options.editable,
      data: {
         kind: 'step',
         step,
         label: summary.label,
         text: summary.text,
         external: summary.external,
         destructive: tool?.effect === 'destructive',
         requiresApproval: summary.approval || Boolean(tool?.requiresApproval),
         agentName,
         findings: options.findings.get(step.id) ?? [],
         editable: options.editable,
         handles,
         handleLabels,
      },
   };
}

export function toFlow(
   definition: WorkflowDefinitionInput,
   layout: CanvasLayout,
   options: ToFlowOptions
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
   const trigger: TriggerFlowNode = {
      id: TRIGGER_NODE_ID,
      type: 'trigger',
      position: layout[TRIGGER_NODE_ID] ?? { x: 0, y: 0 },
      selected: options.selectedNodeId === TRIGGER_NODE_ID,
      draggable: options.editable,
      connectable: options.editable,
      deletable: false,
      data: {
         kind: 'trigger',
         trigger: definition.trigger,
         label: describeWorkflowTrigger({
            type: definition.trigger.type,
            provider: definition.trigger.provider,
            operation: definition.trigger.operation,
            event: definition.trigger.event,
            config: definition.trigger.config,
         }),
         findings: options.findings.get(null) ?? [],
         editable: options.editable,
      },
   };
   const nodes: CanvasNode[] = [
      trigger,
      ...definition.steps.map((step) => stepNode(step, layout, options)),
   ];
   const known = new Set(nodes.map((node) => node.id));
   const byId = new Map(definition.steps.map((step) => [step.id, step]));
   const edges: CanvasEdge[] = [];
   for (const link of stepLinks(definition)) {
      // An edge to a step that does not exist is a finding, not a line to nowhere.
      if (!known.has(link.target) || !known.has(link.source)) continue;
      const source = byId.get(link.source);
      const label = source ? describeHandle(source, link.handle) : '';
      const id = edgeId(link);
      edges.push({
         id,
         source: link.source,
         sourceHandle: link.handle,
         target: link.target,
         targetHandle: 'in',
         type: 'smoothstep',
         label: label || undefined,
         selected: options.selectedEdgeId === id,
         deletable: options.editable,
         markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
         style: link.handle === 'each' ? { strokeDasharray: '6 4' } : undefined,
         data: { link },
      });
   }
   return { nodes, edges };
}

/** Which of a step's fields name other steps: for reading a node's outgoing links in the panel. */
export function outgoingOf(definition: WorkflowDefinitionInput, stepId: string): StepLink[] {
   return stepLinks(definition).filter((link) => link.source === stepId);
}

export function incomingOf(definition: WorkflowDefinitionInput, stepId: string): StepLink[] {
   return stepLinks(definition).filter((link) => link.target === stepId);
}

/** The ids a step's `dependsOn` names, for the panel's "runs after" line. */
export function dependsOnOf(step: WorkflowStepInput): string[] {
   return stringList(step.dependsOn);
}
