'use client';

import '@xyflow/react/dist/style.css';

import { BerryMark } from '@/components/brand/berry-mark';
import { Button } from '@/components/ui/button';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuLabel,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useWorkflow } from '@/hooks/use-workflow';
import { loadProviders } from '@/lib/integrations';
import {
   TRIGGER_NODE_ID,
   applyDefinitionOperation,
   type LinkHandle,
} from '@/lib/workflow-definition';
import type { Workflow } from '@/lib/workflows';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/store/agents-store';
import { useProvidersStore } from '@/store/providers-store';
import { useSessionStore } from '@/store/session-store';
import {
   Background,
   BackgroundVariant,
   Controls,
   ReactFlow,
   ReactFlowProvider,
   useReactFlow,
   type Connection,
   type EdgeChange,
   type IsValidConnection,
   type NodeChange,
   type NodeTypes,
} from '@xyflow/react';
import { LayoutGrid, Pause, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo } from 'react';
import { useWorkflowActions } from '../use-workflow-actions';
import { GROUP_LABEL, GROUP_TONE, NODE_KINDS, type NodeGroup } from './nodes/node-kinds';
import { StepNode } from './nodes/step-node';
import { TriggerNode } from './nodes/trigger-node';
import { FindingList, StepPanel } from './step-panel';
import { toFlow, type CanvasEdge, type CanvasNode } from './to-flow';
import { TriggerPanel } from './trigger-panel';
import { useCanvasEditor, type CanvasEditor } from './use-canvas-editor';
import type { StepKind } from '../create-workflow-steps';

const nodeTypes: NodeTypes = { trigger: TriggerNode, step: StepNode };

const PALETTE: NodeGroup[] = ['work', 'logic', 'actions'];

function isLinkHandle(value: string | null | undefined): value is LinkHandle {
   return (
      value === 'next' ||
      value === 'true' ||
      value === 'false' ||
      value === 'default' ||
      value === 'each' ||
      (typeof value === 'string' && value.startsWith('case:'))
   );
}

function Toolbar({ editor, workflow }: { editor: CanvasEditor; workflow: Workflow }) {
   const { busy, pause } = useWorkflowActions(workflow.id);
   const status = editor.saving
      ? 'Saving…'
      : editor.dirty
        ? 'Unsaved changes'
        : `Saved · v${workflow.version} · revision ${workflow.revision}`;
   return (
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
         {editor.editable ? (
            <DropdownMenu>
               <DropdownMenuTrigger asChild>
                  <Button type="button" size="xs" variant="secondary">
                     <Plus className="size-3.5" />
                     Add step
                  </Button>
               </DropdownMenuTrigger>
               <DropdownMenuContent align="start" className="min-w-60">
                  {PALETTE.map((group, index) => (
                     <div key={group}>
                        {index > 0 && <DropdownMenuSeparator />}
                        <DropdownMenuLabel
                           className={cn('uppercase tracking-[0.14em]', GROUP_TONE[group])}
                        >
                           {GROUP_LABEL[group]}
                        </DropdownMenuLabel>
                        {NODE_KINDS.filter((kind) => kind.group === group && kind.supported).map(
                           (kind) => (
                              <DropdownMenuItem
                                 key={kind.type}
                                 onClick={() => editor.addStep(kind.type as StepKind)}
                              >
                                 <kind.icon className={cn('size-3.5', GROUP_TONE[group])} />
                                 <span className="flex flex-col">
                                    <span>{kind.label}</span>
                                    <span className="text-muted-foreground">{kind.hint}</span>
                                 </span>
                              </DropdownMenuItem>
                           )
                        )}
                     </div>
                  ))}
               </DropdownMenuContent>
            </DropdownMenu>
         ) : (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
               <BerryMark size="sm" tone="attention" state="hollow" />
               {workflow.status === 'active'
                  ? 'Active — pause to edit'
                  : 'Archived workflows are read-only'}
            </span>
         )}
         {editor.editable && (
            <Button type="button" size="xs" variant="ghost" onClick={editor.tidy}>
               <LayoutGrid className="size-3.5" />
               Tidy up
            </Button>
         )}
         {!editor.editable && workflow.status === 'active' && (
            <Button
               type="button"
               size="xs"
               variant="secondary"
               disabled={busy !== null}
               onClick={() => void pause()}
            >
               <Pause className="size-3.5" />
               {busy === 'pausing' ? 'Pausing…' : 'Pause to edit'}
            </Button>
         )}
         <span className="ml-auto text-muted-foreground" role="status">
            {status}
         </span>
         {editor.dirty && (
            <>
               <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={editor.saving}
                  onClick={editor.discard}
               >
                  Discard
               </Button>
               <Button
                  type="button"
                  size="xs"
                  disabled={editor.saving || editor.blocked}
                  title={editor.blocked ? 'Fix the marked steps first' : 'Save (⌘S)'}
                  onClick={() => void editor.save()}
               >
                  {editor.saving ? 'Saving…' : 'Save'}
               </Button>
            </>
         )}
      </div>
   );
}

function ConflictBanner({ editor }: { editor: CanvasEditor }) {
   if (!editor.conflict) return null;
   return (
      <div
         role="alert"
         className="flex flex-wrap items-center gap-2 border-b border-status-warning/50 bg-status-warning/10 px-4 py-2"
      >
         <BerryMark size="sm" tone="attention" state="hollow" />
         <span className="min-w-0 flex-1">
            Someone else saved this workflow (revision {editor.conflict.revision}) while you were
            editing. Take their version and drop your changes, or save yours over theirs.
         </span>
         <Button type="button" size="xs" variant="secondary" onClick={editor.takeTheirs}>
            Take theirs
         </Button>
         <Button
            type="button"
            size="xs"
            disabled={editor.saving || editor.blocked}
            onClick={() => void editor.keepMine()}
         >
            Save mine
         </Button>
      </div>
   );
}

function OverviewPanel({ editor, workflow }: { editor: CanvasEditor; workflow: Workflow }) {
   const general = editor.findings.get(null) ?? [];
   return (
      <div className="flex flex-col gap-4">
         <div>
            <h3 className="font-medium">{workflow.name}</h3>
            <p className="text-muted-foreground">
               {editor.working.steps.length} step{editor.working.steps.length === 1 ? '' : 's'} · v
               {workflow.version}
            </p>
         </div>
         <FindingList findings={general} />
         <ol className="flex flex-col gap-0.5">
            <li>
               <button
                  type="button"
                  className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent/60"
                  onClick={() => editor.select(TRIGGER_NODE_ID)}
               >
                  <span className={cn('font-medium', GROUP_TONE.trigger)}>Trigger</span>
                  <span className="truncate text-muted-foreground">
                     {editor.working.trigger.type}
                  </span>
               </button>
            </li>
            {editor.working.steps.map((step) => {
               const kind = NODE_KINDS.find((candidate) => candidate.type === step.type);
               const findings = editor.findings.get(step.id) ?? [];
               return (
                  <li key={step.id}>
                     <button
                        type="button"
                        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent/60"
                        onClick={() => editor.select(step.id)}
                     >
                        <span className="font-medium">{kind?.label ?? step.type}</span>
                        <span className="truncate font-mono text-muted-foreground">{step.id}</span>
                        {findings.length > 0 && (
                           <BerryMark
                              size="sm"
                              tone={
                                 findings.some((finding) => finding.severity === 'error')
                                    ? 'danger'
                                    : 'attention'
                              }
                              state="hollow"
                              className="ml-auto"
                           />
                        )}
                     </button>
                  </li>
               );
            })}
         </ol>
         <p className="text-muted-foreground">
            {editor.editable
               ? 'Select a node to edit it. Drag from a handle to another node to connect them; select an edge and press Delete to break it. Nothing is sent until you save.'
               : 'The canvas is read-only while the workflow is active.'}
         </p>
      </div>
   );
}

function Editor({ workflow }: { workflow: Workflow }) {
   const editor = useCanvasEditor(workflow);
   const agents = useAgentsStore((state) => state.agents);
   const providers = useProvidersStore((state) => state.providers);
   const { fitView } = useReactFlow();

   const { nodes, edges } = useMemo(
      () =>
         toFlow(editor.working, editor.layout, {
            editable: editor.editable,
            findings: editor.findings,
            agents,
            providers,
            selectedNodeId: editor.selectedNodeId,
            selectedEdgeId: editor.selectedEdgeId,
         }),
      [
         editor.working,
         editor.layout,
         editor.editable,
         editor.findings,
         editor.selectedNodeId,
         editor.selectedEdgeId,
         agents,
         providers,
      ]
   );

   // A fresh copy from the server deserves a fresh viewport.
   useEffect(() => {
      const frame = requestAnimationFrame(() => {
         void fitView({ padding: 0.2, maxZoom: 1, duration: 200 });
      });
      return () => cancelAnimationFrame(frame);
   }, [editor.resetKey, fitView]);

   useEffect(() => {
      const onKey = (event: KeyboardEvent) => {
         if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            if (editor.dirty && !editor.saving) void editor.save();
         }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
   }, [editor]);

   const onNodesChange = useCallback(
      (changes: NodeChange<CanvasNode>[]) => {
         // Selection arrives as one change per node whose state flipped, in
         // node order, so the net effect is read before anything is set: a
         // deselect of the old node must not undo the select of the new one.
         let selected: string | null | undefined;
         for (const change of changes) {
            if (change.type === 'position' && change.position) {
               editor.moveNode(change.id, change.position, change.dragging === false);
            } else if (change.type === 'select') {
               if (change.selected) selected = change.id;
               else if (selected === undefined && editor.selectedNodeId === change.id) {
                  selected = null;
               }
            } else if (change.type === 'remove' && change.id !== TRIGGER_NODE_ID) {
               editor.apply({ type: 'remove_step', stepId: change.id });
            }
         }
         if (selected !== undefined) editor.select(selected);
      },
      [editor]
   );

   const onEdgesChange = useCallback(
      (changes: EdgeChange<CanvasEdge>[]) => {
         let selected: string | null | undefined;
         for (const change of changes) {
            if (change.type === 'select') {
               if (change.selected) selected = change.id;
               else if (selected === undefined && editor.selectedEdgeId === change.id) {
                  selected = null;
               }
            } else if (change.type === 'remove') {
               const edge = edges.find((candidate) => candidate.id === change.id);
               if (edge?.data) editor.apply({ type: 'disconnect', ...edge.data.link });
            }
         }
         if (selected !== undefined) editor.selectEdge(selected);
      },
      [editor, edges]
   );

   const onConnect = useCallback(
      (connection: Connection) => {
         const handle = isLinkHandle(connection.sourceHandle) ? connection.sourceHandle : 'next';
         editor.apply({
            type: 'connect',
            source: connection.source,
            handle,
            target: connection.target,
         });
      },
      [editor]
   );

   const isValidConnection = useCallback<IsValidConnection<CanvasEdge>>(
      (candidate) => {
         if (!candidate.source || !candidate.target) return false;
         const handle = isLinkHandle(candidate.sourceHandle) ? candidate.sourceHandle : 'next';
         return applyDefinitionOperation(editor.working, {
            type: 'connect',
            source: candidate.source,
            handle,
            target: candidate.target,
         }).ok;
      },
      [editor.working]
   );

   const selectedStep = editor.selectedNodeId
      ? editor.working.steps.find((step) => step.id === editor.selectedNodeId)
      : undefined;

   return (
      <div className="flex h-full min-h-0 w-full overflow-hidden bg-container">
         <div className="flex h-full min-w-0 flex-1 flex-col">
            <Toolbar editor={editor} workflow={workflow} />
            <ConflictBanner editor={editor} />
            <div className="berry-canvas relative min-h-0 flex-1">
               <ReactFlow<CanvasNode, CanvasEdge>
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  isValidConnection={isValidConnection}
                  onPaneClick={() => {
                     editor.select(null);
                     editor.selectEdge(null);
                  }}
                  nodesDraggable={editor.editable}
                  nodesConnectable={editor.editable}
                  elementsSelectable
                  deleteKeyCode={editor.editable ? ['Backspace', 'Delete'] : null}
                  fitView
                  fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
                  minZoom={0.25}
                  maxZoom={1.5}
                  defaultEdgeOptions={{ type: 'smoothstep' }}
               >
                  <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
                  <Controls showInteractive={false} position="bottom-left" />
               </ReactFlow>
            </div>
         </div>
         <aside className="flex h-full w-[300px] shrink-0 flex-col overflow-y-auto border-l bg-muted/15 px-4 pt-4 pb-6">
            {editor.selectedNodeId === TRIGGER_NODE_ID ? (
               <TriggerPanel
                  key={`trigger-${editor.resetKey}`}
                  trigger={editor.working.trigger}
                  findings={editor.findings.get(null) ?? []}
                  editable={editor.editable}
                  onChange={editor.setTrigger}
               />
            ) : selectedStep ? (
               <StepPanel
                  key={`${selectedStep.id}-${editor.resetKey}`}
                  step={selectedStep}
                  definition={editor.working}
                  findings={editor.findings.get(selectedStep.id) ?? []}
                  editable={editor.editable}
                  onChange={editor.updateStep}
                  onRemove={() => editor.apply({ type: 'remove_step', stepId: selectedStep.id })}
                  onDisconnect={(link) => editor.apply({ type: 'disconnect', ...link })}
                  onSelect={editor.select}
               />
            ) : (
               <OverviewPanel editor={editor} workflow={workflow} />
            )}
         </aside>
      </div>
   );
}

/**
 * The workflow as a graph: the trigger on the left, steps to its right,
 * edges for what leads where. Editable while the workflow is a draft or
 * paused; read-only while it is active. Edits are sent with the revision
 * they were read at, so two people never overwrite each other unknowingly.
 */
export default function WorkflowCanvas({ workflowId }: { workflowId: string }) {
   const { workflow, error, loading } = useWorkflow(workflowId);
   const status = useSessionStore((state) => state.status);
   const workspace = useSessionStore((state) => state.workspace);
   const providersLoaded = useProvidersStore((state) => state.loaded);
   const hydrateProviders = useProvidersStore((state) => state.hydrateProviders);

   useEffect(() => {
      if (providersLoaded || status !== 'ready' || !workspace) return;
      let cancelled = false;
      void loadProviders(workspace.id).then((providers) => {
         if (!cancelled) hydrateProviders(providers);
      });
      return () => {
         cancelled = true;
      };
   }, [providersLoaded, status, workspace, hydrateProviders]);

   if (!workflow) {
      return (
         <div className="p-6 text-muted-foreground" role={error ? 'alert' : 'status'}>
            {error ?? (loading ? 'Loading workflow…' : 'Workflow not found.')}
         </div>
      );
   }

   return (
      <ReactFlowProvider>
         <Editor workflow={workflow} />
      </ReactFlowProvider>
   );
}
