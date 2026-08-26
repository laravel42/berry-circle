import type { WorkflowDefinitionInput, WorkflowStepInput, WorkflowTriggerInput } from './workflows';

/**
 * Pure edits on a `WorkflowDefinition v1` as the canvas makes them: add,
 * remove and update steps, wire and unwire the links between them, and the
 * structural checks a definition has to pass before it is worth sending.
 * Nothing here touches the network or React; the canvas applies an
 * operation to its working copy and the result is what `PATCH` sends.
 *
 * A definition has two kinds of link. `dependsOn` says a step runs after
 * another; the trigger's `entry` list and the branch lists of a condition
 * (`trueSteps` / `falseSteps`), a switch (`cases[].steps` / `defaultSteps`)
 * and a loop (`steps`) say which steps a step hands the run to. On the
 * canvas both are edges; the handle on the source end says which.
 */

/** The node that stands for the trigger; it is not a step and has no row in `steps`. */
export const TRIGGER_NODE_ID = 'trigger';

/** Where an edge leaves its source: after it, or down one of its branches. */
export type LinkHandle = 'next' | 'true' | 'false' | 'default' | 'each' | `case:${number}`;

export interface StepLink {
   source: string;
   handle: LinkHandle;
   target: string;
}

export type DefinitionOperation =
   | { type: 'add_step'; step: WorkflowStepInput; from?: { source: string; handle: LinkHandle } }
   | { type: 'remove_step'; stepId: string }
   | { type: 'update_step'; stepId: string; step: WorkflowStepInput }
   | { type: 'connect'; source: string; handle: LinkHandle; target: string }
   | { type: 'disconnect'; source: string; handle: LinkHandle; target: string }
   | { type: 'set_trigger'; trigger: WorkflowTriggerInput };

export interface DefinitionProblem {
   /** The step it belongs to, or null for the trigger and the definition as a whole. */
   stepId: string | null;
   message: string;
   severity: 'error' | 'warning';
}

export type OperationResult =
   { ok: true; definition: WorkflowDefinitionInput } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Reading

/** A list of step ids from a loosely typed field, or nothing. */
export function stringList(value: unknown): string[] {
   return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [];
}

function caseList(value: unknown): { equals: unknown; steps: string[] }[] {
   if (!Array.isArray(value)) return [];
   return value.map((entry) => {
      const record =
         typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
      return { equals: record.equals, steps: stringList(record.steps) };
   });
}

/** Every edge the definition draws, trigger first. */
export function stepLinks(definition: WorkflowDefinitionInput): StepLink[] {
   const links: StepLink[] = [];
   for (const target of definition.entry) {
      links.push({ source: TRIGGER_NODE_ID, handle: 'next', target });
   }
   for (const step of definition.steps) {
      for (const source of stringList(step.dependsOn)) {
         links.push({ source, handle: 'next', target: step.id });
      }
      for (const target of stringList(step.trueSteps)) {
         links.push({ source: step.id, handle: 'true', target });
      }
      for (const target of stringList(step.falseSteps)) {
         links.push({ source: step.id, handle: 'false', target });
      }
      caseList(step.cases).forEach((entry, index) => {
         for (const target of entry.steps) {
            links.push({ source: step.id, handle: `case:${index}`, target });
         }
      });
      for (const target of stringList(step.defaultSteps)) {
         links.push({ source: step.id, handle: 'default', target });
      }
      if (step.type === 'foreach') {
         for (const target of stringList(step.steps)) {
            links.push({ source: step.id, handle: 'each', target });
         }
      }
   }
   return links;
}

/** The handles a step of this type offers on its outgoing side. */
export function sourceHandles(step: WorkflowStepInput): LinkHandle[] {
   switch (step.type) {
      case 'condition':
         return ['true', 'false'];
      case 'switch':
         return [...caseList(step.cases).map((_, index): LinkHandle => `case:${index}`), 'default'];
      case 'foreach':
         return ['each', 'next'];
      default:
         return ['next'];
   }
}

/** Steps a run can reach from the trigger by following the links. */
export function reachableSteps(definition: WorkflowDefinitionInput): Set<string> {
   const out = new Map<string, string[]>();
   for (const link of stepLinks(definition)) {
      const list = out.get(link.source) ?? [];
      list.push(link.target);
      out.set(link.source, list);
   }
   const seen = new Set<string>();
   const stack = [TRIGGER_NODE_ID];
   while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const next of out.get(current) ?? []) {
         if (seen.has(next)) continue;
         seen.add(next);
         stack.push(next);
      }
   }
   return seen;
}

/** The first loop among the links, as the ids on its way round, or null. */
export function findCycle(definition: WorkflowDefinitionInput): string[] | null {
   const out = new Map<string, string[]>();
   for (const link of stepLinks(definition)) {
      if (link.source === TRIGGER_NODE_ID) continue;
      const list = out.get(link.source) ?? [];
      list.push(link.target);
      out.set(link.source, list);
   }
   const state = new Map<string, 'open' | 'done'>();
   const path: string[] = [];
   const visit = (id: string): string[] | null => {
      const mark = state.get(id);
      if (mark === 'done') return null;
      if (mark === 'open') {
         const start = path.indexOf(id);
         return [...path.slice(start), id];
      }
      state.set(id, 'open');
      path.push(id);
      for (const next of out.get(id) ?? []) {
         const found = visit(next);
         if (found) return found;
      }
      path.pop();
      state.set(id, 'done');
      return null;
   };
   for (const step of definition.steps) {
      const found = visit(step.id);
      if (found) return found;
   }
   return null;
}

const STEP_ID_BASE: Record<string, string> = {
   create_issue: 'create_task',
   update_issue: 'update_task',
   agent: 'ask_agent',
   condition: 'check',
   switch: 'choose',
   wait: 'wait',
   approval: 'approve',
   action: 'act',
   foreach: 'each',
   transform: 'shape',
   subworkflow: 'run_workflow',
};

/** The readable stem a new step of this type gets: `create_task`, `check`, `act`. */
export function stepIdBase(type: string): string {
   return STEP_ID_BASE[type] ?? 'step';
}

/** A step id nobody else has, following the server grammar `^[a-z][a-z0-9_]{0,63}$`. */
export function nextStepId(definition: WorkflowDefinitionInput, type: string): string {
   const taken = new Set(definition.steps.map((step) => step.id));
   const base = stepIdBase(type);
   for (let index = definition.steps.length + 1; ; index += 1) {
      const candidate = `${base}_${index}`;
      if (!taken.has(candidate)) return candidate;
   }
}

// ---------------------------------------------------------------------------
// Writing

function withoutId(list: unknown, id: string): string[] {
   return stringList(list).filter((entry) => entry !== id);
}

function withId(list: unknown, id: string): string[] {
   const current = stringList(list);
   return current.includes(id) ? current : [...current, id];
}

function setLink(
   definition: WorkflowDefinitionInput,
   link: StepLink,
   present: boolean
): OperationResult {
   const change = present ? withId : withoutId;
   if (link.source === TRIGGER_NODE_ID) {
      if (link.handle !== 'next') return { ok: false, error: 'The trigger has one outgoing edge.' };
      return {
         ok: true,
         definition: { ...definition, entry: change(definition.entry, link.target) },
      };
   }
   const source = definition.steps.find((step) => step.id === link.source);
   if (!source) return { ok: false, error: `There is no step "${link.source}".` };
   if (link.handle === 'next') {
      const steps = definition.steps.map((step) =>
         step.id === link.target
            ? { ...step, dependsOn: change(step.dependsOn, link.source) }
            : step
      );
      return { ok: true, definition: { ...definition, steps } };
   }
   let updated: WorkflowStepInput;
   if (link.handle === 'true' || link.handle === 'false') {
      if (source.type !== 'condition') {
         return { ok: false, error: 'Only an If step has true and false branches.' };
      }
      const key = link.handle === 'true' ? 'trueSteps' : 'falseSteps';
      updated = { ...source, [key]: change(source[key], link.target) };
   } else if (link.handle === 'default') {
      if (source.type !== 'switch') return { ok: false, error: 'Only a switch has a default.' };
      updated = { ...source, defaultSteps: change(source.defaultSteps, link.target) };
   } else if (link.handle === 'each') {
      if (source.type !== 'foreach') return { ok: false, error: 'Only a loop has a body.' };
      updated = { ...source, steps: change(source.steps, link.target) };
   } else {
      const index = Number.parseInt(link.handle.slice('case:'.length), 10);
      const cases = caseList(source.cases);
      if (source.type !== 'switch' || Number.isNaN(index) || !cases[index]) {
         return { ok: false, error: 'That switch has no such case.' };
      }
      cases[index] = { ...cases[index], steps: change(cases[index].steps, link.target) };
      updated = { ...source, cases };
   }
   const steps = definition.steps.map((step) => (step.id === link.source ? updated : step));
   return { ok: true, definition: { ...definition, steps } };
}

/** Every reference to a step, gone: `entry`, `dependsOn` and each branch list. */
function unlinkEverywhere(
   definition: WorkflowDefinitionInput,
   stepId: string
): WorkflowDefinitionInput {
   const steps = definition.steps.map((step) => {
      const next: WorkflowStepInput = { ...step };
      if (Array.isArray(step.dependsOn)) next.dependsOn = withoutId(step.dependsOn, stepId);
      if (Array.isArray(step.trueSteps)) next.trueSteps = withoutId(step.trueSteps, stepId);
      if (Array.isArray(step.falseSteps)) next.falseSteps = withoutId(step.falseSteps, stepId);
      if (Array.isArray(step.defaultSteps)) {
         next.defaultSteps = withoutId(step.defaultSteps, stepId);
      }
      if (step.type === 'foreach' && Array.isArray(step.steps)) {
         next.steps = withoutId(step.steps, stepId);
      }
      if (Array.isArray(step.cases)) {
         next.cases = caseList(step.cases).map((entry) => ({
            ...entry,
            steps: withoutId(entry.steps, stepId),
         }));
      }
      return next;
   });
   return { ...definition, steps, entry: withoutId(definition.entry, stepId) };
}

/** A step with no outgoing link, or null: where "add a step" attaches by default. */
export function lastOpenStep(definition: WorkflowDefinitionInput): WorkflowStepInput | null {
   const sources = new Set(stepLinks(definition).map((link) => link.source));
   for (let index = definition.steps.length - 1; index >= 0; index -= 1) {
      const step = definition.steps[index];
      if (!sources.has(step.id) && step.type !== 'condition' && step.type !== 'switch') {
         return step;
      }
   }
   return null;
}

/** A new definition with the operation applied, or why it cannot be. */
export function applyDefinitionOperation(
   definition: WorkflowDefinitionInput,
   operation: DefinitionOperation
): OperationResult {
   switch (operation.type) {
      case 'add_step': {
         if (definition.steps.some((step) => step.id === operation.step.id)) {
            return { ok: false, error: `There is already a step "${operation.step.id}".` };
         }
         const added: WorkflowDefinitionInput = {
            ...definition,
            steps: [...definition.steps, operation.step],
         };
         const from =
            operation.from ??
            (definition.steps.length === 0
               ? { source: TRIGGER_NODE_ID, handle: 'next' as const }
               : null);
         if (!from) return { ok: true, definition: added };
         return setLink(added, { ...from, target: operation.step.id }, true);
      }
      case 'remove_step': {
         if (!definition.steps.some((step) => step.id === operation.stepId)) {
            return { ok: false, error: `There is no step "${operation.stepId}".` };
         }
         const unlinked = unlinkEverywhere(definition, operation.stepId);
         return {
            ok: true,
            definition: {
               ...unlinked,
               steps: unlinked.steps.filter((step) => step.id !== operation.stepId),
            },
         };
      }
      case 'update_step': {
         if (operation.step.id !== operation.stepId) {
            return { ok: false, error: 'A step keeps its id; remove it and add another.' };
         }
         if (!definition.steps.some((step) => step.id === operation.stepId)) {
            return { ok: false, error: `There is no step "${operation.stepId}".` };
         }
         const steps = definition.steps.map((step) =>
            step.id === operation.stepId ? operation.step : step
         );
         return { ok: true, definition: { ...definition, steps } };
      }
      case 'connect': {
         if (operation.target === TRIGGER_NODE_ID) {
            return { ok: false, error: 'Nothing leads into the trigger.' };
         }
         if (operation.source === operation.target) {
            return { ok: false, error: 'A step cannot follow itself.' };
         }
         if (!definition.steps.some((step) => step.id === operation.target)) {
            return { ok: false, error: `There is no step "${operation.target}".` };
         }
         const linked = setLink(definition, operation, true);
         if (!linked.ok) return linked;
         const cycle = findCycle(linked.definition);
         if (cycle) {
            return { ok: false, error: `That would make a loop: ${cycle.join(' → ')}.` };
         }
         return linked;
      }
      case 'disconnect':
         return setLink(definition, operation, false);
      case 'set_trigger':
         return { ok: true, definition: { ...definition, trigger: operation.trigger } };
   }
}

// ---------------------------------------------------------------------------
// Checking

/**
 * What is structurally wrong or odd before the server sees it. Field-level
 * checks (a task without a title) belong to the step editors; this is about
 * the shape: ids, references, reachability, loops.
 */
export function definitionProblems(definition: WorkflowDefinitionInput): DefinitionProblem[] {
   const problems: DefinitionProblem[] = [];
   const ids = new Set<string>();
   for (const step of definition.steps) {
      if (ids.has(step.id)) {
         problems.push({
            stepId: step.id,
            severity: 'error',
            message: `Two steps are called "${step.id}".`,
         });
      }
      ids.add(step.id);
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(step.id)) {
         problems.push({
            stepId: step.id,
            severity: 'error',
            message:
               'A step id is lowercase letters, digits and underscores, starting with a letter.',
         });
      }
   }
   for (const link of stepLinks(definition)) {
      if (!ids.has(link.target)) {
         problems.push({
            stepId: link.source === TRIGGER_NODE_ID ? null : link.source,
            severity: 'error',
            message: `"${link.target}" is named as a next step but does not exist.`,
         });
      }
      if (link.source !== TRIGGER_NODE_ID && !ids.has(link.source)) {
         problems.push({
            stepId: link.target,
            severity: 'error',
            message: `It waits on "${link.source}", which does not exist.`,
         });
      }
   }
   if (definition.steps.length === 0) {
      problems.push({ stepId: null, severity: 'warning', message: 'There are no steps yet.' });
   } else if (definition.entry.length === 0) {
      problems.push({
         stepId: null,
         severity: 'error',
         message: 'Connect the trigger to the first step.',
      });
   }
   const cycle = findCycle(definition);
   if (cycle) {
      problems.push({
         stepId: cycle[0],
         severity: 'error',
         message: `Steps form a loop: ${cycle.join(' → ')}.`,
      });
   }
   const reachable = reachableSteps(definition);
   for (const step of definition.steps) {
      if (!reachable.has(step.id)) {
         problems.push({
            stepId: step.id,
            severity: 'warning',
            message: 'Nothing leads here, so it never runs.',
         });
      }
   }
   return problems;
}
