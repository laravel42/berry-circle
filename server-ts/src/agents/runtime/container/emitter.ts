import type { LifecycleEvent } from '../../../runtime/lifecycle.ts';
import type { CommandLedger } from '../command-tool.ts';
import type { LedgerSink } from '../plugins/ledger.ts';

export type Emit = (event: LifecycleEvent) => void;

export interface RepositoryLedger {
   appendRepositoryReady(runId: string, params: { repository: string; branch: string; baseCommit: string }): Promise<void>;
   appendVerified(
      runId: string,
      params: {
         passed: boolean;
         complete: boolean;
         durationMs: number;
         results: Array<{ command: string; exitCode: number | null; passed: boolean; durationMs: number; error: string | null }>;
      }
   ): Promise<void>;
}

/**
 * The ledger, as the runtime sees it: every write becomes a `task.message`.
 *
 * The same `LedgerPlugin` and `run_command` the server used write here, so
 * the rows the server records from the stream are the rows it used to record
 * itself. The run id argument is ignored — the stream belongs to one run.
 */
export function emitterSink(emit: Emit): LedgerSink & CommandLedger & RepositoryLedger {
   const message = (value: Extract<LifecycleEvent, { type: 'task.message' }>['message']) => {
      emit({ type: 'task.message', message: value });
      return Promise.resolve();
   };
   return {
      appendOutput: (_runId, channel, text) => message({ kind: 'output', channel, text }),
      appendToolStarted: (_runId, toolCallId, name) => message({ kind: 'tool.started', toolCallId, name }),
      appendToolCompleted: (_runId, toolCallId, succeeded) => message({ kind: 'tool.completed', toolCallId, succeeded }),
      appendCommandStarted: (_runId, params) => message({ kind: 'command.started', ...params }),
      appendCommandOutput: (_runId, params) => message({ kind: 'command.output', ...params }),
      appendCommandCompleted: (_runId, params) => message({ kind: 'command.completed', ...params }),
      appendRepositoryReady: (_runId, params) => message({ kind: 'repository.ready', ...params }),
      appendVerified: (_runId, params) => message({ kind: 'verified', ...params }),
   };
}
