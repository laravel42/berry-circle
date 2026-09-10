import { enqueueTask } from '../runs/queue.ts';
import type { QuickActionEnqueue } from '../work/quick-actions.ts';

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
