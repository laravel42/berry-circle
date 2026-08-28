import type { ExecEvent } from './protocol.ts';

/**
 * The Sandbox SDK's event vocabulary, translated into Berry's.
 *
 * This function is the entire reason Berry can have a second execution driver.
 * Upstream emits `start | stdout | stderr | complete | error`; Berry's ledger
 * speaks `start | stdout | stderr | exit | error`. Translating here rather
 * than in Berry means the local container driver, when it lands, emits Berry's
 * shapes directly and nothing above the seam knows either dialect.
 *
 * Written against `ExecEvent` in @cloudflare/sandbox 0.7.0, whose fields are
 * all optional:
 *
 *   { type: 'start'|'stdout'|'stderr'|'complete'|'error'; timestamp: string;
 *     data?: string; command?: string; exitCode?: number; result?: ExecResult;
 *     error?: string; sessionId?: string; pid?: number }
 *
 * It takes `unknown` rather than that type so it can be tested without the
 * SDK, and reads defensively because the SDK is at 1.0-preview: a field that
 * moves should cost one line here and surface as a visible `error` event,
 * never as a run that silently loses its output.
 */

/** Assigns the next sequence number. Sequencing belongs to the caller, which owns the stream. */
export type NextSeq = () => number;

export function toBerryEvents(upstream: unknown, command: string, next: NextSeq): ExecEvent[] {
   if (typeof upstream !== 'object' || upstream === null) return [];
   const event = upstream as Record<string, unknown>;

   switch (event.type) {
      case 'start':
         return [{ type: 'start', seq: next(), command: text(event.command) || command }];

      case 'stdout':
      case 'stderr': {
         const data = text(event.data);
         // An empty chunk is not worth a ledger row.
         if (data === '') return [];
         return [{ type: event.type, seq: next(), data }];
      }

      case 'complete':
      case 'exit': {
         // `exitCode` is the documented field; `result` carries the same code
         // for callers that asked for a full ExecResult, and is checked second
         // rather than assumed absent.
         const exitCode = integer(event.exitCode) ?? integer(nested(event.result, 'exitCode'));
         if (exitCode === null) {
            // A completion with no code cannot be recorded as a success, and
            // guessing zero is how a failed run gets merged.
            return [
               {
                  type: 'error',
                  seq: next(),
                  message: 'command completed without an exit code',
               },
            ];
         }
         return [{ type: 'exit', seq: next(), exitCode }];
      }

      case 'error':
         return [
            {
               type: 'error',
               seq: next(),
               message:
                  text(event.error) ||
                  'the execution substrate reported an error with no message',
            },
         ];

      default:
         // Unknown event types are dropped rather than surfaced: the SDK may
         // add one, and a new heartbeat should not become a ledger row or an
         // error in a run that is going fine.
         return [];
   }
}

function text(value: unknown): string {
   return typeof value === 'string' ? value : '';
}

function integer(value: unknown): number | null {
   return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function nested(value: unknown, key: string): unknown {
   return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;
}
