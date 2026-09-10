import type { z } from 'zod';
import type { Sql } from '../db/pool.ts';

/**
 * The two things the agent layer needs from the runtime, as shapes.
 *
 * Workstream A owns `enqueueTask` (runs/queue.ts) and `runCompletion`
 * (runtime/completion.ts). These mirrors are structural, so A's real functions
 * are assignable to them and every test here can pass a fake without A merged.
 * Never widen them: a field A does not accept would be silently dropped.
 */

export type TaskSource =
   | 'assignment'
   | 'mention'
   | 'chat'
   | 'autopilot'
   | 'squad'
   | 'quick_action'
   | 'builder'
   | 'completion';

export interface EnqueueInput {
   workspaceId: string;
   agentId: string;
   issueId?: string;
   kind: 'agent' | 'completion';
   source: TaskSource;
   prompt?: string;
   chatSessionId?: string;
   autopilotRunId?: string;
   priority?: number;
}

export type EnqueueTask = (sql: Sql, input: EnqueueInput) => Promise<{ runId: string }>;

export interface CompletionRequest<T> {
   workspaceId: string;
   purpose: string;
   system: string;
   prompt: string;
   schema: z.ZodType<T>;
}

export type CompleteFn = <T>(request: CompletionRequest<T>) => Promise<T>;
