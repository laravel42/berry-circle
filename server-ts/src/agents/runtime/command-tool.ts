import { tool, type Tool, type ToolContext } from '@strands-agents/sdk';
import { z } from 'zod';
import type { ExecutionSession } from '../../execution/driver.ts';
import { ExecutionUnavailable } from '../../execution/driver.ts';
import type { RunLedger } from '../../runs/ledger.ts';

/** The three ledger writes a command makes. The runtime passes an emitter instead. */
export type CommandLedger = Pick<
   RunLedger,
   'appendCommandStarted' | 'appendCommandOutput' | 'appendCommandCompleted'
>;

/**
 * The tool that makes a run something you can watch.
 *
 * Everything else an agent can do here happens in a database. This one happens
 * in a container, and its output is the live log a person reads while a run is
 * in flight — so unlike the other tools, the command and its output are
 * recorded rather than summarised away.
 *
 * Three properties are load-bearing, and each of them is a bug somewhere else
 * if it is missing:
 *
 *   - A non-zero exit is a *result*, not an exception. The model has to see
 *     that the tests failed in order to fix them; throwing would hide the one
 *     fact the run exists to discover.
 *   - Output is coalesced before it reaches the ledger. A build emits
 *     thousands of small writes, and one row per write would make `run_events`
 *     a character log.
 *   - What the model is handed is bounded separately from what is recorded.
 *     A 200,000-line test log belongs in the ledger and does not belong in the
 *     next prompt.
 *
 * What is *not* here any more: the permission check. It lives in the
 * permission plugin, in front of every tool rather than inside one, so a
 * scope built without a permission set cannot quietly grant commands. And the
 * run's checkout directory and cancellation arrive through the SDK's own
 * tool context rather than through closures threaded in from the executor.
 */

/** Where the checkout is, on the agent's state. Set by the executor after cloning. */
export const WORKDIR_KEY = 'workdir';

export interface CommandToolScope {
   ledger: CommandLedger;
   runId: string;
   /**
    * The run's workspace, opened on first use.
    *
    * Lazy because most runs never call this tool, and a sandbox created for
    * every run would pay a container start for nothing. Memoising is the
    * caller's job — it also owns tearing the session down.
    */
   session: () => Promise<ExecutionSession>;
   newId: () => string;
   clock?: () => Date;
}

/** Ledger bytes per command. Beyond this the run is still recorded as truncated. */
const MAX_RECORDED_BYTES = 256 * 1024;

/** What the model sees. Enough to diagnose a failure, not enough to fill a context. */
const MAX_MODEL_BYTES = 4 * 1024;

/** One ledger row per this much output, or per the interval below. */
const FLUSH_BYTES = 2 * 1024;
const FLUSH_MS = 300;

export function runCommandTool(scope: CommandToolScope): Tool {
   const clock = scope.clock ?? (() => new Date());

   return tool({
      name: 'run_command',
      description:
         'Run a shell command in this task\'s isolated workspace and return its output and exit code. ' +
         'The files saved on this task (see list_files) are present in the workspace at the same paths. ' +
         'The workspace is yours alone and is destroyed when the run ends; a file a command produces ' +
         'is kept only if you collect_file it. ' +
         'A non-zero exit code is a result you should read and act on, not an error.',
      inputSchema: z.object({
         command: z.string().describe('A shell command, e.g. "pnpm install" or "pnpm test"'),
         cwd: z
            .string()
            .optional()
            .describe('Directory to run in, relative to the workspace root. Defaults to the root.'),
      }),
      callback: async ({ command, cwd }, context?: ToolContext) => {
         const trimmed = command.trim();
         if (trimmed === '') {
            return { error: 'command was empty', exitCode: null };
         }

         let session: ExecutionSession;
         try {
            session = await scope.session();
         } catch (error) {
            // The substrate being unreachable is not the agent's failure and
            // must not read like one: it is told plainly so it can say so
            // rather than retrying a command that cannot run.
            if (error instanceof ExecutionUnavailable) {
               return { error: `no workspace is available: ${error.message}`, exitCode: null };
            }
            throw error;
         }

         const commandId = scope.newId();
         const startedAt = clock().getTime();
         // The checkout, when the run has one, read at call time: the tools are
         // built before the repository is cloned.
         const workdir = context?.agent.appState.get(WORKDIR_KEY);
         const directory = cwd ?? (typeof workdir === 'string' ? workdir : null);
         // The run's cancellation, so a `pnpm test` three minutes in stops
         // with the run rather than finishing in a container nobody will reap.
         const signal = context?.cancelSignal;

         await scope.ledger.appendCommandStarted(scope.runId, {
            commandId,
            command: trimmed,
            cwd: directory,
         });

         const recorder = new OutputRecorder(scope.ledger, scope.runId, commandId, clock);
         const tail = new Tail(MAX_MODEL_BYTES);
         let exitCode: number | null = null;
         let failure: string | null = null;

         try {
            const options = {
               ...(directory === null ? {} : { cwd: directory }),
               ...(signal ? { signal } : {}),
            };
            for await (const event of session.stream(trimmed, options)) {
               switch (event.type) {
                  case 'stdout':
                  case 'stderr':
                     await recorder.write(event.type, event.data);
                     tail.write(event.type, event.data);
                     break;
                  case 'exit':
                     exitCode = event.exitCode;
                     break;
                  case 'error':
                     failure = event.message;
                     break;
                  default:
                     break;
               }
            }
         } catch (error) {
            // Cancellation is not a broken stream, and must not be recorded as
            // one: the person asked for this, and the agent should say so
            // rather than report an infrastructure fault it can retry.
            failure = signal?.aborted
               ? 'the run was cancelled'
               : error instanceof Error
                 ? error.message
                 : String(error);
         }

         // The ledger refuses an append to a run that has ended, which is
         // exactly the case a cancellation creates: the run went terminal
         // while this command was still draining. That is not the command's
         // failure and must not be raised as one — the tool still owes the
         // model a result, and the run's own ending is already recorded.
         await recorder.flush().catch(() => undefined);
         await scope.ledger
            .appendCommandCompleted(scope.runId, {
               commandId,
               exitCode,
               durationMs: clock().getTime() - startedAt,
               truncated: recorder.truncated,
            })
            .catch(() => undefined);

         if (failure !== null && exitCode === null) {
            return { error: failure, exitCode: null };
         }
         return {
            exitCode,
            stdout: tail.text('stdout'),
            stderr: tail.text('stderr'),
            ...(recorder.truncated ? { note: 'output was truncated in the run log' } : {}),
         };
      },
   });
}

/**
 * Buffers command output into ledger rows.
 *
 * Flushed by size or by age, whichever comes first: size keeps a noisy build
 * from writing a row per line, and age keeps a slow command's first output
 * from sitting in a buffer while someone watches an empty log.
 */
class OutputRecorder {
   readonly #ledger: CommandLedger;
   readonly #runId: string;
   readonly #commandId: string;
   readonly #clock: () => Date;
   readonly #buffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
   #lastFlush: number;
   #recorded = 0;
   #truncated = false;

   constructor(ledger: CommandLedger, runId: string, commandId: string, clock: () => Date) {
      this.#ledger = ledger;
      this.#runId = runId;
      this.#commandId = commandId;
      this.#clock = clock;
      this.#lastFlush = clock().getTime();
   }

   get truncated(): boolean {
      return this.#truncated;
   }

   async write(stream: 'stdout' | 'stderr', text: string): Promise<void> {
      if (this.#recorded >= MAX_RECORDED_BYTES) {
         this.#truncated = true;
         return;
      }
      const room = MAX_RECORDED_BYTES - this.#recorded;
      const slice = text.length > room ? text.slice(0, room) : text;
      if (slice.length < text.length) this.#truncated = true;

      this.#buffers[stream] += slice;
      this.#recorded += slice.length;

      const due =
         this.#buffers[stream].length >= FLUSH_BYTES ||
         this.#clock().getTime() - this.#lastFlush >= FLUSH_MS;
      if (due) await this.flush();
   }

   async flush(): Promise<void> {
      for (const stream of ['stdout', 'stderr'] as const) {
         const text = this.#buffers[stream];
         if (text === '') continue;
         this.#buffers[stream] = '';
         await this.#ledger.appendCommandOutput(this.#runId, { commandId: this.#commandId, stream, text });
      }
      this.#lastFlush = this.#clock().getTime();
   }
}

/**
 * The last N bytes of each stream, for the model.
 *
 * The tail rather than the head: a failing command says why at the end, and
 * the first four kilobytes of a build are the part nobody needs.
 */
class Tail {
   readonly #limit: number;
   readonly #parts: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
   readonly #dropped: Record<'stdout' | 'stderr', boolean> = { stdout: false, stderr: false };

   constructor(limit: number) {
      this.#limit = limit;
   }

   write(stream: 'stdout' | 'stderr', text: string): void {
      const combined = this.#parts[stream] + text;
      if (combined.length > this.#limit) {
         this.#dropped[stream] = true;
         this.#parts[stream] = combined.slice(combined.length - this.#limit);
      } else {
         this.#parts[stream] = combined;
      }
   }

   text(stream: 'stdout' | 'stderr'): string {
      const body = this.#parts[stream];
      // Said explicitly, so the model does not read a truncated log as the
      // whole story and conclude the build printed nothing before it failed.
      return this.#dropped[stream] ? `…earlier output omitted…\n${body}` : body;
   }
}
