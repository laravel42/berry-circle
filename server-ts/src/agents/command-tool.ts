import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import type { ExecutionSession } from '../execution/driver.ts';
import { ExecutionUnavailable } from '../execution/driver.ts';
import type { RunLedger } from '../runs/ledger.ts';
import { PermissionDenied, type PermissionSet } from './permissions.ts';

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
 */

export interface CommandToolScope {
   ledger: RunLedger;
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
   /**
    * Where a command runs when it does not say.
    *
    * Optional because the substrate has its own root, and Berry knowing the
    * container's directory layout is a coupling with nothing to gain.
    */
   workdir?: string;
   /**
    * The same thing, read at call time.
    *
    * The tools are built before the repository is cloned, so a fixed value
    * would always be the one from before the checkout — which is the workspace
    * root, and the agent's commands would run beside its repository instead of
    * inside it.
    */
   workdirAt?: () => string | undefined;
   /**
    * Checked on every call, not once at construction.
    *
    * Berry's claim is that revoking a permission makes the runtime refuse the
    * call. A check that only decided whether to offer the tool would be a
    * hidden button, and a hidden button is not an enforcement point.
    */
   permissions?: PermissionSet;
   clock?: () => Date;
}

/** Ledger bytes per command. Beyond this the run is still recorded as truncated. */
const MAX_RECORDED_BYTES = 256 * 1024;

/** What the model sees. Enough to diagnose a failure, not enough to fill a context. */
const MAX_MODEL_BYTES = 4 * 1024;

/** One ledger row per this much output, or per the interval below. */
const FLUSH_BYTES = 2 * 1024;
const FLUSH_MS = 300;

export function runCommandTool(scope: CommandToolScope): FunctionTool {
   const clock = scope.clock ?? (() => new Date());

   return new FunctionTool({
      name: 'run_command',
      description:
         'Run a shell command in this task\'s isolated workspace and return its output and exit code. ' +
         'The workspace is yours alone and is destroyed when the run ends. ' +
         'A non-zero exit code is a result you should read and act on, not an error.',
      parameters: z.object({
         command: z.string().describe('A shell command, e.g. "pnpm install" or "pnpm test"'),
         cwd: z
            .string()
            .optional()
            .describe('Directory to run in, relative to the workspace root. Defaults to the root.'),
      }),
      execute: async ({ command, cwd }) => {
         const trimmed = command.trim();
         if (trimmed === '') {
            return { error: 'command was empty', exitCode: null };
         }

         try {
            scope.permissions?.require('run_commands');
         } catch (error) {
            if (error instanceof PermissionDenied) {
               // Told plainly so the agent stops trying and says so, rather
               // than reading a refusal as a transient failure to retry.
               return { error: error.message, exitCode: null, permissionDenied: true };
            }
            throw error;
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
         const directory = cwd ?? scope.workdirAt?.() ?? scope.workdir ?? null;

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
            const options = directory === null ? {} : { cwd: directory };
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
            // A stream that broke mid-command. The command may well have run,
            // so this is reported rather than retried.
            failure = error instanceof Error ? error.message : String(error);
         }

         await recorder.flush();
         await scope.ledger.appendCommandCompleted(scope.runId, {
            commandId,
            exitCode,
            durationMs: clock().getTime() - startedAt,
            truncated: recorder.truncated,
         });

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
   readonly #ledger: RunLedger;
   readonly #runId: string;
   readonly #commandId: string;
   readonly #clock: () => Date;
   readonly #buffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
   #lastFlush: number;
   #recorded = 0;
   #truncated = false;

   constructor(ledger: RunLedger, runId: string, commandId: string, clock: () => Date) {
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
