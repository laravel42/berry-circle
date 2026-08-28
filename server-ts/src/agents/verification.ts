import type { ExecutionSession } from '../execution/driver.ts';

/**
 * The evidence a pull request arrives with.
 *
 * "Nothing merges because an agent said it was finished" needs something other
 * than the agent's word, and this is it: the project's own commands, run in
 * the tree that is about to be pushed, with their exit codes recorded.
 *
 * Three rules shape it.
 *
 * A failing command does **not** stop the delivery. The reviewer is the point
 * — they need to see the failure, on the branch, with the diff that caused it.
 * Withholding the pull request would hide the one thing they most need to
 * look at.
 *
 * Every command is bounded, and the whole set is bounded again. A verification
 * step that hangs must not hold a run open indefinitely, and a suite that
 * prints a hundred megabytes must not become the pull request body.
 *
 * The commands come from the project rather than from the branch, so a run
 * cannot weaken its own evidence by editing the file that defines it.
 */

export interface VerificationResult {
   command: string;
   /** Null when the command never reported one — a timeout, or a broken substrate. */
   exitCode: number | null;
   passed: boolean;
   durationMs: number;
   /** The tail of the combined output, for a reviewer. Bounded. */
   output: string;
   /** Set when the substrate failed rather than the command. */
   error: string | null;
}

export interface VerificationReport {
   results: VerificationResult[];
   /** True only when every command ran and every one passed. */
   passed: boolean;
   /** False when the set was cut short by the overall budget. */
   complete: boolean;
   durationMs: number;
}

export interface VerifyOptions {
   session: ExecutionSession;
   /** The checkout, so commands run where the code is. */
   directory: string;
   commands: string[];
   /** Per command. A hung step must not hold the run open. */
   commandTimeoutMs?: number;
   /** Across the whole set, so ten slow steps cannot add up to an hour. */
   totalBudgetMs?: number;
   clock?: () => Date;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TOTAL_BUDGET_MS = 20 * 60_000;

/** Per command. A reviewer reads the end of a failure, not the middle of a build. */
const MAX_OUTPUT_BYTES = 4 * 1024;

export async function verify(options: VerifyOptions): Promise<VerificationReport> {
   const clock = options.clock ?? (() => new Date());
   const startedAt = clock().getTime();
   const budget = options.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
   const perCommand = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

   const results: VerificationResult[] = [];
   let complete = true;

   for (const raw of options.commands) {
      const command = raw.trim();
      if (command === '') continue;

      const spent = clock().getTime() - startedAt;
      if (spent >= budget) {
         // Said rather than silently dropped: a report missing its last two
         // commands reads as though they passed.
         complete = false;
         break;
      }

      const began = clock().getTime();
      let exitCode: number | null = null;
      let error: string | null = null;
      let output = '';

      try {
         const result = await options.session.exec(command, {
            cwd: options.directory,
            // Whichever is smaller: a command may not exceed what is left.
            timeoutMs: Math.min(perCommand, budget - spent),
         });
         exitCode = result.exitCode;
         // stdout then stderr, because a test runner reports its summary on one
         // and its failures on the other and a reviewer wants both.
         output = tail(`${result.stdout}${result.stderr}`, MAX_OUTPUT_BYTES);
      } catch (cause) {
         // The substrate broke, which is not the same as the command failing —
         // and must not be recorded as a verification that did not pass.
         error = cause instanceof Error ? cause.message : String(cause);
      }

      results.push({
         command,
         exitCode,
         passed: exitCode === 0,
         durationMs: clock().getTime() - began,
         output,
         error,
      });
   }

   return {
      results,
      // A set that was cut short has not passed, whatever the commands that
      // did run reported.
      passed: complete && results.length > 0 && results.every((result) => result.passed),
      complete,
      durationMs: clock().getTime() - startedAt,
   };
}

/**
 * A one-line-per-command summary for a pull request body.
 *
 * Deliberately plain text: it goes into a GitHub description, where a reviewer
 * reads it before opening anything.
 */
export function summarise(report: VerificationReport): string {
   if (report.results.length === 0) return '';
   const lines = report.results.map((result) => {
      if (result.error !== null) return `- \`${result.command}\` — could not run: ${result.error}`;
      const verdict = result.passed ? 'passed' : `failed (exit ${result.exitCode})`;
      return `- \`${result.command}\` — ${verdict} in ${seconds(result.durationMs)}`;
   });
   if (!report.complete) {
      lines.push('- _the remaining checks did not run: the verification budget was spent_');
   }
   return lines.join('\n');
}

function seconds(ms: number): string {
   return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The end, not the beginning: a command explains its failure last. */
function tail(text: string, limit: number): string {
   if (text.length <= limit) return text;
   return `…earlier output omitted…\n${text.slice(text.length - limit)}`;
}
