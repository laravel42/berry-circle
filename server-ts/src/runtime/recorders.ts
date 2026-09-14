import type { Sql } from '../db/pool.ts';
import { RunTerminal, type Failure, type RunLedger, type Usage } from '../runs/ledger.ts';
import { RunRepository } from '../runs/repository.ts';
import { notifyRunTerminal } from '../runs/terminal-hooks.ts';
import type { TaskMessage, TaskResult } from './lifecycle.ts';

/**
 * Where a task's lifecycle is written.
 *
 * Issue runs go through the ledger, as they always have: the run stream, the
 * task timeline and the review gate read what it writes. A run with no issue
 * (a completion, a chat task) has no board to publish on, so it writes its
 * status on the row.
 *
 * It also announces the end of the run, as the ledger does. That announcement
 * is what posts a chat reply and what re-triggers a squad leader, so a path
 * that wrote the status and said nothing left a finished chat looking
 * unanswered even though the agent had replied.
 */
export interface TaskRecorder {
   started(): Promise<void>;
   message(message: TaskMessage): Promise<void>;
   succeeded(input: { summary: string | null; usage: Usage; result: TaskResult }): Promise<void>;
   failed(input: { failure: Failure; usage: Usage }): Promise<void>;
   cancelled(usage: Usage): Promise<void>;
}

export function ledgerRecorder(ledger: RunLedger, runId: string): TaskRecorder {
   let running = false;
   const ignoreTerminal = (cause: unknown) => {
      if (!(cause instanceof RunTerminal)) throw cause;
   };
   const ensureRunning = async () => {
      if (running) return;
      running = true;
      await ledger.markRunning(runId);
   };
   return {
      started: ensureRunning,
      async message(message) {
         await ensureRunning();
         const write = (() => {
            switch (message.kind) {
               case 'output':
                  return ledger.appendOutput(runId, message.channel, message.text);
               case 'tool.started':
                  return ledger.appendToolStarted(runId, message.toolCallId, message.name);
               case 'tool.completed':
                  return ledger.appendToolCompleted(runId, message.toolCallId, message.succeeded);
               case 'command.started':
                  return ledger.appendCommandStarted(runId, { commandId: message.commandId, command: message.command, cwd: message.cwd });
               case 'command.output':
                  return ledger.appendCommandOutput(runId, { commandId: message.commandId, stream: message.stream, text: message.text });
               case 'command.completed':
                  return ledger.appendCommandCompleted(runId, {
                     commandId: message.commandId, exitCode: message.exitCode, durationMs: message.durationMs, truncated: message.truncated,
                  });
               case 'repository.ready':
                  return ledger.appendRepositoryReady(runId, { repository: message.repository, branch: message.branch, baseCommit: message.baseCommit });
               case 'verified':
                  return ledger.appendVerified(runId, {
                     passed: message.passed, complete: message.complete, durationMs: message.durationMs, results: message.results,
                  });
            }
         })();
         await write.catch(ignoreTerminal);
      },
      // The issue run's result lives in the ledger (summary, result comment,
      // delivery events); only an issue-less task stores `result` on the row.
      async succeeded({ summary, usage }) {
         await ensureRunning();
         await ledger.completeSuccess({ runId, summary, usage });
      },
      async failed({ failure }) {
         await ledger.fail({ runId, failure }).catch(ignoreTerminal);
      },
      async cancelled() {
         await ledger.markCancelled(runId).catch(ignoreTerminal);
      },
   };
}

export function directRecorder(sql: Sql, runId: string): TaskRecorder {
   // Only on the transition: a repeated terminal write changes no row and must
   // not announce a second time, even though the hooks are idempotent.
   const announce = async (rows: readonly unknown[]) => {
      if (rows.length === 0) return;
      const run = await new RunRepository(sql).get(runId);
      await notifyRunTerminal(run);
   };
   return {
      async started() {
         await sql`
            UPDATE runs SET status = 'running', dispatch_state = 'streaming',
                   started_at = COALESCE(started_at, now()), dispatch_accepted_at = now(), updated_at = now()
             WHERE id = ${runId} AND status = 'queued'`;
      },
      async message() {
         // No stream to publish on; the result is what the caller waits for.
      },
      async succeeded({ summary, usage, result }) {
         const rows = await sql`
            UPDATE runs SET status = 'succeeded', dispatch_state = 'succeeded', summary = ${summary},
                   result = ${sql.json(result as never)},
                   input_tokens = ${usage.inputTokens}, output_tokens = ${usage.outputTokens},
                   total_tokens = ${usage.totalTokens}, completed_at = now(), updated_at = now(),
                   started_at = COALESCE(started_at, now())
             WHERE id = ${runId} AND status IN ('queued', 'running')
         RETURNING id`;
         await announce(rows);
      },
      async failed({ failure, usage }) {
         const rows = await sql`
            UPDATE runs SET status = 'failed', dispatch_state = 'failed',
                   failure_code = ${failure.code}, failure_message = ${failure.message},
                   failure_retryable = ${failure.retryable},
                   input_tokens = ${usage.inputTokens}, output_tokens = ${usage.outputTokens},
                   total_tokens = ${usage.totalTokens}, completed_at = now(), updated_at = now()
             WHERE id = ${runId} AND status IN ('queued', 'running')
         RETURNING id`;
         await announce(rows);
      },
      async cancelled() {
         const rows = await sql`
            UPDATE runs SET status = 'cancelled', dispatch_state = 'cancelled',
                   cancel_completed_at = now(), completed_at = now(), updated_at = now()
             WHERE id = ${runId} AND status IN ('queued', 'running')
         RETURNING id`;
         await announce(rows);
      },
   };
}
