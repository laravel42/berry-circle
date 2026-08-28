/**
 * The wire contract between Berry and this worker.
 *
 * Duplicated in `server-ts/src/execution/` and in `runtime-worker/`,
 * deliberately: the three packages deploy separately and must not share a
 * build. `runtime-worker/PROTOCOL.md` is the normative description, and
 * `server-ts` pins these shapes in a test so a change in one place fails in
 * another rather than at runtime.
 *
 * Berry cannot tell which service answered. That is the point — this one runs
 * containers on the operator's own Docker daemon, the other runs them on
 * Cloudflare, and the wire format says nothing about either.
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
