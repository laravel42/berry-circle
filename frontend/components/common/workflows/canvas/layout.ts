import { TRIGGER_NODE_ID, stepLinks, type LinkHandle } from '@/lib/workflow-definition';
import type { WorkflowDefinitionInput } from '@/lib/workflows';

/**
 * Where nodes sit when nobody has dragged them: the trigger on the left,
 * each step one column to the right of whatever leads into it, siblings
 * stacked. Positions a person set are kept as they are; only nodes without
 * one are placed, beside the column they belong to and clear of anything
 * already there.
 */

export const NODE_WIDTH = 224;
export const NODE_HEIGHT = 84;
const COLUMN_GAP = 96;
const ROW_GAP = 36;

export interface Point {
   x: number;
   y: number;
}

export type CanvasLayout = Record<string, Point>;

/** The stored layout with anything that is not an `{x, y}` pair dropped. */
export function layoutFromStored(stored: Record<string, unknown>): CanvasLayout {
   const layout: CanvasLayout = {};
   for (const [id, value] of Object.entries(stored)) {
      if (typeof value !== 'object' || value === null) continue;
      const { x, y } = value as { x?: unknown; y?: unknown };
      if (
         typeof x === 'number' &&
         typeof y === 'number' &&
         Number.isFinite(x) &&
         Number.isFinite(y)
      ) {
         layout[id] = { x: Math.round(x), y: Math.round(y) };
      }
   }
   return layout;
}

/** Column per node: the trigger in 0, every step one past the furthest node that leads to it. */
function ranks(definition: WorkflowDefinitionInput): Map<string, number> {
   const rank = new Map<string, number>([[TRIGGER_NODE_ID, 0]]);
   const links = stepLinks(definition);
   // Relaxation with a cap: a loop would otherwise push ranks forever.
   for (let pass = 0; pass <= definition.steps.length; pass += 1) {
      let changed = false;
      for (const link of links) {
         const from = rank.get(link.source);
         if (from === undefined) continue;
         const current = rank.get(link.target) ?? -1;
         if (from + 1 > current) {
            rank.set(link.target, from + 1);
            changed = true;
         }
      }
      if (!changed) break;
   }
   const furthest = Math.max(0, ...rank.values());
   for (const step of definition.steps) {
      if (!rank.has(step.id)) rank.set(step.id, furthest + 1);
   }
   return rank;
}

/** Branch handles fan out in this order, so a true branch sits above a false one. */
function handleOrder(handle: LinkHandle): number {
   if (handle === 'true' || handle === 'each') return 0;
   if (handle === 'false' || handle === 'default') return 2;
   if (handle.startsWith('case:')) return 1;
   return 1;
}

export function autoLayout(definition: WorkflowDefinitionInput): CanvasLayout {
   const rank = ranks(definition);
   const links = stepLinks(definition);
   const firstLink = new Map<string, { sourceOrder: number; handle: LinkHandle }>();
   const order = new Map<string, number>([[TRIGGER_NODE_ID, 0]]);
   definition.steps.forEach((step, index) => order.set(step.id, index + 1));
   for (const link of links) {
      if (!firstLink.has(link.target)) {
         firstLink.set(link.target, {
            sourceOrder: order.get(link.source) ?? 0,
            handle: link.handle,
         });
      }
   }
   const columns = new Map<number, string[]>();
   for (const [id, column] of rank) {
      const list = columns.get(column) ?? [];
      list.push(id);
      columns.set(column, list);
   }
   const layout: CanvasLayout = {};
   for (const [column, ids] of columns) {
      ids.sort((left, right) => {
         const a = firstLink.get(left);
         const b = firstLink.get(right);
         const bySource = (a?.sourceOrder ?? 0) - (b?.sourceOrder ?? 0);
         if (bySource !== 0) return bySource;
         const byHandle = handleOrder(a?.handle ?? 'next') - handleOrder(b?.handle ?? 'next');
         if (byHandle !== 0) return byHandle;
         return (order.get(left) ?? 0) - (order.get(right) ?? 0);
      });
      ids.forEach((id, row) => {
         layout[id] = {
            x: column * (NODE_WIDTH + COLUMN_GAP),
            y: row * (NODE_HEIGHT + ROW_GAP),
         };
      });
   }
   return layout;
}

function overlaps(a: Point, b: Point): boolean {
   return Math.abs(a.x - b.x) < NODE_WIDTH && Math.abs(a.y - b.y) < NODE_HEIGHT;
}

/**
 * The stored positions, with every node that has none placed by the
 * automatic layout and nudged down until it sits clear of the others.
 */
export function completeLayout(
   definition: WorkflowDefinitionInput,
   stored: CanvasLayout
): CanvasLayout {
   const ids = [TRIGGER_NODE_ID, ...definition.steps.map((step) => step.id)];
   const missing = ids.filter((id) => !stored[id]);
   if (missing.length === 0) return stored;
   const automatic = autoLayout(definition);
   const placed: CanvasLayout = {};
   for (const id of ids) {
      if (stored[id]) placed[id] = stored[id];
   }
   const taken = Object.values(placed);
   for (const id of missing) {
      const point = { ...automatic[id] };
      // A fresh layout has nothing to collide with; a grown one may.
      while (taken.some((other) => overlaps(point, other))) {
         point.y += NODE_HEIGHT + ROW_GAP;
      }
      placed[id] = point;
      taken.push(point);
   }
   return placed;
}
