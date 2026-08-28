/**
 * The wire contract between Berry and this worker.
 *
 * These types are duplicated in `server-ts/src/execution/`, deliberately: the
 * two packages deploy separately and must not share a build. `PROTOCOL.md` is
 * the normative description, and `server-ts` pins these shapes in a test so a
 * change on one side fails on the other rather than at runtime.
 *
 * Nothing from `@cloudflare/sandbox` appears here. The translation happens in
 * this worker so Berry never learns a provider's vocabulary — which is the
 * whole reason a second driver can exist later.
 */

export type ExecEvent =
   | { type: 'start'; seq: number; command: string }
   | { type: 'stdout'; seq: number; data: string }
   | { type: 'stderr'; seq: number; data: string }
   | { type: 'exit'; seq: number; exitCode: number }
   | { type: 'error'; seq: number; message: string };

export interface CreateSessionRequest {
   runId: string;
   cwd?: string;
   env?: Record<string, string>;
}

export interface ExecRequest {
   command: string;
   cwd?: string;
   env?: Record<string, string>;
   timeoutMs?: number;
}

export interface WriteFileRequest {
   path: string;
   content: string;
}

/** One SSE frame. The payload is the whole event, so a frame stands alone. */
export function encodeFrame(event: ExecEvent): string {
   return `data: ${JSON.stringify(event)}\n\n`;
}
