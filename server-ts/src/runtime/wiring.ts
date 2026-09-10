import type { CompleteFn, EnqueueTask } from '../agents/seams.ts';
import type { EnqueueTask as AutopilotEnqueue } from '../autopilots/fire.ts';
import type { IssueRepository } from '../core/issues.ts';
import type { Sql } from '../db/pool.ts';
import { enqueueTask } from '../runs/queue.ts';
import { delegateTool } from '../squads/delegate-tool.ts';
import type { QuickActionEnqueue } from '../work/quick-actions.ts';
import { registerAgentTool } from './agent-tools/registry.ts';
import { runCompletion, type CompletionDeps } from './completion.ts';

/**
 * Where the runtime's real functions meet the seams other workstreams were
 * written against.
 *
 * Work tracking, the agent layer and autopilots each declared the shape of
 * `enqueueTask` (and friends) structurally, so they could be built and tested
 * before the runtime existed. Each binding below is typed with that seam: if
 * the runtime's signature drifts from a contract, this file stops compiling
 * rather than a caller silently losing a field. `index.ts` takes its
 * functions from here, and `wiring.test.ts` pins that each seam is the real
 * function and not a stand-in.
 */

/** Quick actions (work tracking): run a prompt template on an issue. */
export const quickActionEnqueue: QuickActionEnqueue = enqueueTask;

/** The agent layer: chat, comment triggers, squads. */
export const agentEnqueue: EnqueueTask = enqueueTask;

/** The agent layer's single model calls (chat titles, the agent builder), as completion tasks. */
export function agentCompletion(deps: CompletionDeps): CompleteFn {
   return (request) => runCompletion(deps, request);
}

/** A squad leader's `delegate_to_member` tool, on the runtime's tool registry. Once per process. */
export function registerDelegateTool(deps: { sql: Sql; issues: IssueRepository }): void {
   registerAgentTool('delegate_to_member', delegateTool(deps));
}

/**
 * Autopilots: a firing queues the assignee's task. Typed with the autopilot
 * seam and never widened: if the runtime's signature drifts from that
 * contract, this stops compiling.
 */
export const autopilotEnqueue: AutopilotEnqueue = enqueueTask;
