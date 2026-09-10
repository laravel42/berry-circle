import type { Run } from './ledger.ts';

/**
 * What happens after a run reaches a terminal state, outside the ledger.
 *
 * A chat reply and a squad leader's re-trigger both depend on a run having
 * finished, and neither belongs inside the ledger's transaction: a hook that
 * failed there would roll back the fact that the run ended. They run after the
 * commit instead, and must be idempotent — an idempotent cancel notifies again.
 */

export type TerminalHook = (run: Run) => Promise<void>;

const hooks: TerminalHook[] = [];

export function onRunTerminal(hook: TerminalHook): () => void {
   hooks.push(hook);
   return () => {
      const index = hooks.indexOf(hook);
      if (index >= 0) hooks.splice(index, 1);
   };
}

export async function notifyRunTerminal(
   run: Run,
   report: (error: unknown) => void = () => undefined
): Promise<void> {
   for (const hook of [...hooks]) {
      try {
         await hook(run);
      } catch (error) {
         report(error);
      }
   }
}
