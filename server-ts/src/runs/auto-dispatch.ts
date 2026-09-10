import type { Run } from './ledger.ts';
import { ActiveRunExists, NoAgentAssigned, type RunRepository } from './repository.ts';

/**
 * A task assigned to an agent, and ready, gets a run without anyone asking.
 *
 * The product's loop is issue → assign → work. Plan triage admits runs for the
 * tasks it routes, but a task a person made by hand and handed to an agent
 * had no path to a run at all: it sat in todo with an assignee and nothing
 * happened. This is that path, applied after a task is created or changed.
 *
 * Three conditions, each a reason not to start: the assignee is an agent (a
 * person's task is theirs to pick up), the task is in `todo` (backlog is not
 * yet wanted, blocked is waiting on something, and anything later is already
 * under way or done), and no run is active. Admission itself is the run
 * repository's, with its own lock against a second run.
 */
export interface DispatchCandidate {
   id: string;
   boardId: string;
   status: string;
   assignee: { type: string; id: string } | null;
   activeRunId: string | null;
}

/**
 * Whether a task's earlier-stage siblings are still open. A sub-issue in stage
 * N+1 must not start while any stage <= N sibling is unfinished.
 */
export interface StageGate {
   blockedByEarlierStage(issueId: string): Promise<boolean>;
}

export function readyForAgent(issue: DispatchCandidate, stageOpen = true): boolean {
   return (
      stageOpen &&
      issue.assignee?.type === 'agent' &&
      issue.status === 'todo' &&
      issue.activeRunId === null
   );
}

export async function autoDispatch(
   runs: Pick<RunRepository, 'admit'>,
   issue: DispatchCandidate,
   context: { workspaceId: string; requestedBy: string },
   stages?: StageGate
): Promise<Run | null> {
   if (!readyForAgent(issue)) return null;
   if (stages && (await stages.blockedByEarlierStage(issue.id))) return null;
   try {
      return await runs.admit({
         issueId: issue.id,
         boardId: issue.boardId,
         workspaceId: context.workspaceId,
         agentId: null,
         requestedBy: context.requestedBy,
         instructions: null,
      });
   } catch (error) {
      // Both mean the task is already someone's: a run got there first, or the
      // assignee changed under us. Neither is a failure of the edit that
      // triggered this.
      if (error instanceof ActiveRunExists || error instanceof NoAgentAssigned) return null;
      throw error;
   }
}
