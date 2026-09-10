import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/pool.ts';
import { nullRunMemory, type RunMemory } from '../agentcore/memory.ts';
import type { GitHubClient } from '../integrations/github.ts';
import type { Executor } from '../runs/dispatcher.ts';
import { RunLedger, type Dispatch, type Failure, type Usage } from '../runs/ledger.ts';
import { postRunResult } from '../runs/result-comment.ts';
import { mintTaskToken, revokeTaskTokens } from './agent-tools/tokens.ts';
import { recordDelivery } from './delivery.ts';
import { loadTask, type EnvelopeBuilder, type TaskRow } from './envelope-builder.ts';
import { LifecycleStreamError, type TaskMessage, type TaskResult } from './lifecycle.ts';
import { directRecorder, ledgerRecorder, type TaskRecorder } from './recorders.ts';
import { RuntimeUnavailable, type RuntimeTarget, type RuntimeTransport } from './transport.ts';

export type UsageRecorder = (
   sql: Sql,
   input: {
      runId: string;
      workspaceId: string;
      agentId: string;
      runtimeId?: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
   }
) => Promise<void>;

export interface TaskOutcome {
   runId: string;
   status: 'succeeded' | 'failed' | 'cancelled';
   summary: string | null;
   usage: Usage;
   failure?: Failure;
   result?: TaskResult;
}

export interface RuntimeTaskExecutorOptions {
   sql: Sql;
   transport: RuntimeTransport;
   builder: EnvelopeBuilder;
   /** The deployment's runtime when a task names none. Null means tasks fail as unconfigured. */
   defaultTarget: RuntimeTarget | null;
   recordUsage: UsageRecorder;
   ledger?: RunLedger;
   memory?: RunMemory;
   gitCredential?: ((workspaceId: string) => Promise<{ username: string; password: string }>) | undefined;
   github?: (token: string) => GitHubClient;
   reviewGate?: { review(runId: string): Promise<unknown> };
   onGateError?: (error: unknown) => void;
   onUsageError?: (error: unknown) => void;
   /** The runtime's maxLifetime: a token never outlives the microVM it was minted for. */
   tokenTtlSeconds?: number;
   clock?: () => Date;
   newId?: () => string;
}

const ZERO: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: null, currency: null };
const STREAM_ENDED: Failure = {
   code: 'RUNTIME_STREAM_ENDED',
   message: 'The runtime stopped reporting before the task finished.',
   retryable: true,
};

/**
 * The dispatcher's executor, now that the loop is in the runtime.
 *
 * It claims, builds the envelope, invokes, and turns each lifecycle event
 * into the ledger write the in-process executor used to make itself. The
 * ledger stays the only writer of run state; this only reads a stream.
 */
export class RuntimeTaskExecutor implements Executor {
   readonly #o: RuntimeTaskExecutorOptions;
   readonly #ledger: RunLedger;
   readonly #memory: RunMemory;

   constructor(options: RuntimeTaskExecutorOptions) {
      this.#o = options;
      this.#ledger = options.ledger ?? new RunLedger({ sql: options.sql });
      this.#memory = options.memory ?? nullRunMemory();
   }

   async execute(runId: string, signal?: AbortSignal): Promise<TaskOutcome> {
      const { sql } = this.#o;
      const task = await loadTask(sql, runId);
      const dispatch = task.issueId ? await this.#ledger.claimDispatch(runId) : await claimDirect(sql, runId);
      const recorder: TaskRecorder = task.issueId ? ledgerRecorder(this.#ledger, runId) : directRecorder(sql, runId);
      const usage: Usage = { ...ZERO };
      const abort = signal ?? new AbortController().signal;

      const target = await resolveTarget(sql, task.workspaceId, task.runtimeId, this.#o.defaultTarget);
      if (!target) {
         return this.#fail(task, recorder, usage, { code: 'RUNTIME_UNCONFIGURED', message: 'No agent runtime is configured for this workspace.', retryable: false });
      }

      let envelopeSession = '';
      try {
         const token = await mintTaskToken(sql, {
            runId, workspaceId: task.workspaceId, agentId: task.agentId,
            scopes: task.kind === 'completion' ? [] : ['task:read', 'task:write'],
            ttlSeconds: this.#o.tokenTtlSeconds ?? 28_800,
         });
         let built: Awaited<ReturnType<EnvelopeBuilder['build']>>;
         try {
            built = await this.#o.builder.build({ task, dispatch: task.issueId ? (dispatch as Dispatch) : null, token });
         } catch (error) {
            return await this.#fail(task, recorder, usage, {
               code: 'TASK_PREPARATION_FAILED',
               message: error instanceof Error ? error.message : String(error),
               retryable: false,
            });
         }
         const { envelope, delivery, model } = built;
         envelopeSession = envelope.runtimeSessionId;
         await sql`UPDATE runs SET runtime_session_id = ${envelope.runtimeSessionId} WHERE id = ${runId}`;

         let verified: Extract<TaskMessage, { kind: 'verified' }> | null = null;
         for await (const event of this.#o.transport.invoke({ target, envelope, signal: abort })) {
            if (abort.aborted) break;
            if (event.type === 'task.started') await recorder.started();
            else if (event.type === 'task.message') {
               if (event.message.kind === 'verified') verified = event.message;
               await recorder.message(event.message);
            } else if (event.type === 'task.usage') {
               usage.inputTokens += event.usage.inputTokens;
               usage.outputTokens += event.usage.outputTokens;
               usage.totalTokens = usage.inputTokens + usage.outputTokens;
               await this.#o
                  .recordUsage(sql, {
                     runId, workspaceId: task.workspaceId, agentId: task.agentId,
                     ...(target.id ? { runtimeId: target.id } : {}),
                     model: event.usage.model || model,
                     inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens,
                     cacheReadTokens: event.usage.cacheReadTokens, cacheWriteTokens: event.usage.cacheWriteTokens,
                  })
                  .catch((error: unknown) => this.#o.onUsageError?.(error));
            } else if (event.type === 'task.failed') {
               return await this.#fail(task, recorder, usage, event.failure);
            } else if (event.type === 'task.completed') {
               return await this.#succeed(task, recorder, usage, event.result, delivery, verified);
            }
         }
         if (abort.aborted) return await this.#cancel(task, recorder, usage, target, envelopeSession);
         return await this.#fail(task, recorder, usage, STREAM_ENDED);
      } catch (error) {
         if (abort.aborted) return await this.#cancel(task, recorder, usage, target, envelopeSession);
         if (error instanceof RuntimeUnavailable) {
            return await this.#fail(task, recorder, usage, { code: 'RUNTIME_UNAVAILABLE', message: error.message, retryable: true });
         }
         if (error instanceof LifecycleStreamError) {
            return await this.#fail(task, recorder, usage, { code: 'RUNTIME_PROTOCOL', message: error.message, retryable: true });
         }
         throw error;
      } finally {
         await revokeTaskTokens(sql, runId).catch(() => undefined);
      }
   }

   async #succeed(
      task: TaskRow,
      recorder: TaskRecorder,
      usage: Usage,
      result: TaskResult,
      plan: Awaited<ReturnType<EnvelopeBuilder['build']>>['delivery'],
      verified: Extract<TaskMessage, { kind: 'verified' }> | null
   ): Promise<TaskOutcome> {
      const summary = result.text === '' ? null : result.text;
      if (plan && result.delivery) {
         try {
            const credential = this.#o.gitCredential ? await this.#o.gitCredential(task.workspaceId) : null;
            await recordDelivery({
               sql: this.#o.sql,
               ledger: this.#ledger,
               github: credential && this.#o.github ? this.#o.github(credential.password) : null,
               runId: task.runId,
               plan,
               delivery: result.delivery,
               summary,
               verified,
            });
         } catch (error) {
            return this.#fail(task, recorder, usage, {
               code: 'DELIVERY_FAILED',
               message: `The work was pushed but the pull request could not be opened: ${error instanceof Error ? error.message : String(error)}`,
               retryable: false,
            });
         }
      }
      await recorder.succeeded({ summary, usage, result });
      if (task.issueId) {
         if (summary) {
            await this.#memory.record({ agentId: task.agentId, issueId: task.issueId, role: 'ASSISTANT', text: summary, runId: task.runId });
            await postRunResult(this.#o.sql, {
               issueId: task.issueId, agentId: task.agentId, text: result.text, cut: result.truncated,
               occurredAt: (this.#o.clock ?? (() => new Date()))().toISOString(), newId: this.#o.newId ?? randomUUID,
            }).catch(() => null);
         }
         if (this.#o.reviewGate) {
            await this.#o.reviewGate.review(task.runId).catch((error: unknown) => this.#o.onGateError?.(error));
         }
      }
      return { runId: task.runId, status: 'succeeded', summary, usage, result };
   }

   async #fail(task: TaskRow, recorder: TaskRecorder, usage: Usage, failure: Failure): Promise<TaskOutcome> {
      await recorder.failed({ failure, usage });
      if (task.issueId) {
         if (!failure.retryable) {
            await postRunResult(this.#o.sql, {
               issueId: task.issueId, agentId: task.agentId,
               text: `This run failed (${failure.code}). ${failure.message}`, cut: false,
               occurredAt: new Date().toISOString(),
            }).catch(() => null);
         }
         await this.#memory.record({
            agentId: task.agentId, issueId: task.issueId, role: 'ASSISTANT',
            text: `An earlier run failed with ${failure.code}: ${failure.message}`, runId: task.runId,
         });
      }
      return { runId: task.runId, status: 'failed', summary: null, usage, failure };
   }

   async #cancel(task: TaskRow, recorder: TaskRecorder, usage: Usage, target: RuntimeTarget, session: string): Promise<TaskOutcome> {
      // StopRuntimeSession ends a session later runs may have reused; the
      // cold path restores it from the transcript (spec 2.2a).
      if (session) await this.#o.transport.stop({ target, runtimeSessionId: session });
      await recorder.cancelled(usage);
      return { runId: task.runId, status: 'cancelled', summary: null, usage };
   }
}

/** The claim for a task with no issue: the same one-shot transition the ledger makes. */
async function claimDirect(sql: Sql, runId: string): Promise<null> {
   const rows = await sql`
      UPDATE runs SET dispatch_state = 'dispatching', dispatch_version = dispatch_version + 1,
             dispatch_attempted_at = now(), updated_at = now()
       WHERE id = ${runId} AND status = 'queued' AND dispatch_state = 'pending'
       RETURNING id`;
   if (rows.length === 0) throw new Error(`run ${runId} is not claimable`);
   return null;
}

export async function resolveTarget(
   sql: Sql,
   workspaceId: string,
   runtimeId: string | null,
   fallback: RuntimeTarget | null
): Promise<RuntimeTarget | null> {
   if (!runtimeId) return fallback;
   // `agents.runtime_id` is a plain FK; a runtime of another workspace is never used.
   const [row] = await sql`
      SELECT id, kind, driver, arn, qualifier, region, endpoint_url, status FROM agent_runtimes
       WHERE id = ${runtimeId} AND workspace_id = ${workspaceId}`;
   if (!row || row.status === 'disabled') return fallback;
   // The platform row names no target of its own: it is the configured default.
   if (row.kind === 'platform' || (!row.arn && !row.endpoint_url)) {
      return fallback ? { ...fallback, id: row.id as string } : null;
   }
   return {
      id: row.id as string,
      driver: row.driver as RuntimeTarget['driver'],
      arn: (row.arn as string | null) ?? null,
      qualifier: (row.qualifier as string | null) ?? 'DEFAULT',
      region: (row.region as string | null) ?? null,
      endpointUrl: (row.endpoint_url as string | null) ?? null,
   };
}
