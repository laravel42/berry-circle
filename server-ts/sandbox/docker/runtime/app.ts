import { Hono } from 'hono';
import { encodeFrame, type ExecEvent } from './protocol.ts';
import { authorize } from './auth.ts';
import type { Frame } from './demux.ts';

/**
 * The routes, separated from the Docker client that satisfies them.
 *
 * `index.ts` supplies the real daemon; a test supplies a fake. The
 * authorization check is why that split exists: it is the only thing between
 * the network and a process that runs arbitrary commands, and a check that can
 * only be exercised against a live daemon is one nobody exercises.
 *
 * Every route here answers exactly the wire contract in `protocol.ts`, which
 * the execution driver in `server-ts/src/execution/http.ts` speaks.
 */

export interface Env {
   token: string;
   /**
    * The workspace root a relative `cwd` is resolved against.
    *
    * The protocol lets a caller say `repo/packages/api` without knowing where
    * the substrate puts a workspace — and Docker rejects a relative Cwd
    * outright, so resolving here is what keeps the two substrates
    * interchangeable rather than subtly different.
    */
   workdir: string;
}

/** What this service needs from a container runtime, and nothing more. */
export interface Runtime {
   ping(): Promise<void>;
   /** Creates the workspace for a run, or returns the existing one. */
   open(runId: string, input: { cwd?: string; env?: Record<string, string> }): Promise<string>;
   /** Resolves a run to its workspace, or null when it has none. */
   find(runId: string): Promise<string | null>;
   exec(
      containerId: string,
      command: string,
      options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }
   ): AsyncGenerator<Frame | { exitCode: number }>;
   putFile(containerId: string, path: string, content: string): Promise<void>;
   getFile(containerId: string, path: string): Promise<string>;
   kill(containerId: string): Promise<void>;
   remove(containerId: string): Promise<void>;
   /** Refuses a new workspace when the host is already at its ceiling. */
   atCapacity(): Promise<boolean>;
}

/** Bounds a command that would otherwise hold a container open indefinitely. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60 * 1000;

export function createApp(runtime: Runtime, env: Env): Hono {
   const app = new Hono();

   /** Absolute paths are honoured; anything else hangs off the workspace root. */
   const resolveCwd = (cwd: string | undefined): string | undefined => {
      if (cwd === undefined) return undefined;
      if (cwd.startsWith('/')) return cwd;
      return `${env.workdir.replace(/\/$/, '')}/${cwd.replace(/^\.\//, '')}`;
   };

   /** Public: reachability only, and says nothing about the caller. */
   app.get('/health', async (context) => {
      try {
         await runtime.ping();
      } catch {
         // The service is up but the daemon is not, which is a different
         // problem from the service being down and worth distinguishing.
         return context.json({ status: 'degraded', reason: 'container runtime unreachable' }, 503);
      }
      return context.json({ status: 'ok' });
   });

   const guard = authorize(env.token);
   // `/sessions/*` does not match the bare collection, so the create route is
   // guarded separately rather than left open by a wildcard that looks like it
   // covers it.
   app.use('/sessions/*', guard);
   app.post('/sessions', guard);

   app.post('/sessions', async (context) => {
      const body = await context.req.json<{ runId?: unknown; cwd?: unknown; env?: unknown }>();
      if (typeof body.runId !== 'string' || body.runId === '') {
         return context.json({ error: 'runId is required' }, 400);
      }
      if (await runtime.atCapacity()) {
         // 429 is what Berry maps to a retryable failure, so a busy host
         // delays a run rather than recording it as failed.
         return context.json({ error: 'no capacity for another workspace' }, 429);
      }
      await runtime.open(body.runId, {
         ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
         ...(isStringMap(body.env) ? { env: body.env } : {}),
      });
      return context.json({ sessionId: body.runId });
   });

   app.post('/sessions/:id/exec', async (context) => {
      const container = await resolve(context.req.param('id'));
      if (!container) return notFound(context);
      const request = await context.req.json<ExecBody>();
      if (typeof request.command !== 'string' || request.command === '') {
         return context.json({ error: 'command is required' }, 400);
      }

      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;
      for await (const item of runtime.exec(container, request.command, execOptions(request, resolveCwd))) {
         if ('exitCode' in item) exitCode = item.exitCode;
         else if (item.kind === 'stdout') stdout += item.data;
         else stderr += item.data;
      }
      if (exitCode === null) {
         return context.json({ error: 'command ended without an exit code' }, 500);
      }
      return context.json({ stdout, stderr, exitCode });
   });

   app.post('/sessions/:id/exec/stream', async (context) => {
      const container = await resolve(context.req.param('id'));
      if (!container) return notFound(context);
      const request = await context.req.json<ExecBody>();
      if (typeof request.command !== 'string' || request.command === '') {
         return context.json({ error: 'command is required' }, 400);
      }
      const command = request.command;
      const options = execOptions(request, resolveCwd);

      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
         async start(controller) {
            let seq = 0;
            const emit = (event: ExecEvent): void => {
               controller.enqueue(encoder.encode(encodeFrame(event)));
            };
            emit({ type: 'start', seq: seq++, command });

            let terminal = false;
            try {
               for await (const item of runtime.exec(container, command, options)) {
                  if ('exitCode' in item) {
                     emit({ type: 'exit', seq: seq++, exitCode: item.exitCode });
                     terminal = true;
                  } else {
                     emit({ type: item.kind, seq: seq++, data: item.data });
                  }
               }
               // A stream that ends without an exit would let Berry record a
               // run as finished with a code nobody sent. Saying so is the
               // difference between a visible failure and a wrong success.
               if (!terminal) {
                  emit({
                     type: 'error',
                     seq: seq++,
                     message: 'command stream ended without reporting an exit',
                  });
               }
            } catch (error) {
               emit({ type: 'error', seq: seq++, message: describe(error) });
            } finally {
               controller.close();
            }
         },
      });

      return new Response(body, {
         headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            // A proxy buffering this would turn a live log into one that
            // arrives all at once when the run is already over.
            'x-accel-buffering': 'no',
         },
      });
   });

   app.put('/sessions/:id/files', async (context) => {
      const container = await resolve(context.req.param('id'));
      if (!container) return notFound(context);
      const body = await context.req.json<{ path?: unknown; content?: unknown }>();
      if (typeof body.path !== 'string' || typeof body.content !== 'string') {
         return context.json({ error: 'path and content are required' }, 400);
      }
      await runtime.putFile(container, body.path, body.content);
      return context.json({ written: true });
   });

   app.get('/sessions/:id/files', async (context) => {
      const container = await resolve(context.req.param('id'));
      if (!container) return notFound(context);
      const path = context.req.query('path');
      if (!path) return context.json({ error: 'path is required' }, 400);
      return context.json({ content: await runtime.getFile(container, path) });
   });

   app.post('/sessions/:id/stop', async (context) => {
      const container = await resolve(context.req.param('id'));
      if (!container) return notFound(context);
      // Kills what is running and leaves the workspace intact, so a stopped
      // run's output can still be read back before it is torn down.
      await runtime.kill(container);
      return context.json({ stopped: true });
   });

   app.delete('/sessions/:id', async (context) => {
      const container = await resolve(context.req.param('id'));
      // Already gone is the state this asks for, and Berry calls it on the
      // failure path — a 404 here would replace the real reason a run failed
      // with a complaint about tidying up.
      if (!container) return context.json({ destroyed: true });
      await runtime.remove(container);
      return context.json({ destroyed: true });
   });

   app.onError((error, context) => context.json({ error: describe(error) }, 500));

   return app;

   function resolve(runId: string): Promise<string | null> {
      return runtime.find(runId);
   }
}

function execOptions(
   request: ExecBody,
   resolveCwd: (cwd: string | undefined) => string | undefined
): { cwd?: string; env?: Record<string, string>; timeoutMs?: number } {
   const cwd = resolveCwd(typeof request.cwd === 'string' ? request.cwd : undefined);
   // Defaulted here rather than left to the caller: an unbounded command holds
   // a container open until something else reaps it, and the protocol says a
   // substrate bounds what it runs.
   const timeoutMs =
      typeof request.timeoutMs === 'number' && request.timeoutMs > 0
         ? request.timeoutMs
         : DEFAULT_COMMAND_TIMEOUT_MS;
   return {
      ...(cwd !== undefined ? { cwd } : {}),
      ...(isStringMap(request.env) ? { env: request.env } : {}),
      timeoutMs,
   };
}

interface ExecBody {
   command?: unknown;
   cwd?: unknown;
   env?: unknown;
   timeoutMs?: unknown;
}



function notFound(context: { json: (body: unknown, status: 404) => Response }): Response {
   return context.json({ error: 'unknown session' }, 404);
}

function isStringMap(value: unknown): value is Record<string, string> {
   return (
      typeof value === 'object' &&
      value !== null &&
      Object.values(value).every((entry) => typeof entry === 'string')
   );
}

function describe(error: unknown): string {
   return error instanceof Error ? error.message : String(error);
}
