/**
 * The wire contract between Berry and the runtime service.
 *
 * Mirrored by the execution driver's copy in `server-ts/src/execution/`: the
 * runtime image ships only `sandbox/docker/runtime/`, so it carries its own copy of these
 * shapes rather than importing across the tree. `server-ts` pins them in a test
 * so a change on one side fails the build rather than a run.
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
