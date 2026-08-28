import { Hono } from 'hono';
import { encodeFrame, type ExecEvent } from './protocol.ts';
import { authorize } from './auth.ts';
import { toBerryEvents } from './translate.ts';

/**
 * The routes, separated from the bindings that satisfy them.
 *
 * `index.ts` supplies the real Sandbox Durable Object; a test supplies a fake.
 * That split exists because the one thing in this worker that must never be
 * wrong is the authorization check, and a check that can only be exercised by
 * deploying a container is a check nobody exercises.
 */

export interface Env {
   Sandbox: unknown;
   /** Shared secret Berry presents. Set with `wrangler secret put`. */
   BERRY_RUNTIME_TOKEN: string;
}

/**
 * What this worker needs from a sandbox, and nothing more.
 *
 * Structural on purpose: the real `Sandbox` satisfies it, and so does a stub,
 * without either being named here.
 */
export interface SandboxLike {
   exec(
      command: string,
      options?: { cwd?: string; env?: Record<string, string>; timeout?: number }
   ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
   execStream(
      command: string,
      options?: { cwd?: string; env?: Record<string, string>; timeout?: number }
   ): Promise<ReadableStream<Uint8Array>>;
   writeFile(path: string, content: string): Promise<unknown>;
   readFile(path: string): Promise<{ content: string }>;
   killAllProcesses(): Promise<unknown>;
   destroy(): Promise<unknown>;
}

/** Resolves a run to its sandbox. The only place the run-to-sandbox mapping lives. */
export type ResolveSandbox = (env: Env, runId: string) => SandboxLike;

/** Bounds a command that would otherwise hold a container open indefinitely. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The workspace root a relative `cwd` is resolved against.
 *
 * The protocol lets a caller say `repo/packages/api` without knowing where the
 * substrate puts a workspace. Resolving it the same way here as in `runtime/`
 * is what keeps the two interchangeable.
 */
export const WORKSPACE_ROOT = '/workspace';

function resolveCwd(cwd: unknown): string | undefined {
   if (typeof cwd !== 'string') return undefined;
   if (cwd.startsWith('/')) return cwd;
   return `${WORKSPACE_ROOT}/${cwd.replace(/^\.\//, '')}`;
}

/**
 * Reads the SSE frames one sandbox stream produces. Injectable so a test can
 * drive the translation without the SDK's parser.
 */
export type ParseStream = <T>(stream: ReadableStream<Uint8Array>) => AsyncIterable<T>;

export interface AppOptions {
   sandbox: ResolveSandbox;
   parseStream: ParseStream;
}

export function createApp(options: AppOptions): Hono<{ Bindings: Env }> {
   const app = new Hono<{ Bindings: Env }>();
   const { sandbox: resolve, parseStream } = options;

   /** Public: reachability only, and says nothing about the caller. */
   app.get('/health', (context) => context.json({ status: 'ok' }));

   // Everything else needs the bearer token. `/sessions/*` does not match the
   // bare collection, so the create route is guarded separately rather than
   // left open by a wildcard that looks like it covers it.
   app.use('/sessions/*', authorize);
   app.post('/sessions', authorize);

   app.post('/sessions', async (context) => {
      const body = await context.req.json<{ runId?: unknown }>();
      if (typeof body.runId !== 'string' || body.runId === '') {
         return context.json({ error: 'runId is required' }, 400);
      }
      // Touching the sandbox here surfaces a substrate that cannot start now,
      // while Berry can still refuse admission, rather than on the first
      // command when the run is already recorded as started.
      await resolve(context.env, body.runId).exec('true');
      return context.json({ sessionId: body.runId });
   });

   app.post('/sessions/:id/exec', async (context) => {
      const request = await context.req.json<ExecRequestBody>();
      if (typeof request.command !== 'string' || request.command === '') {
         return context.json({ error: 'command is required' }, 400);
      }
      const result = await resolve(context.env, context.req.param('id')).exec(
         request.command,
         execOptions(request)
      );
      return context.json({
         stdout: result.stdout,
         stderr: result.stderr,
         exitCode: result.exitCode,
      });
   });

   app.post('/sessions/:id/exec/stream', async (context) => {
      const request = await context.req.json<ExecRequestBody>();
      if (typeof request.command !== 'string' || request.command === '') {
         return context.json({ error: 'command is required' }, 400);
      }
      const command = request.command;
      const upstream = await resolve(context.env, context.req.param('id')).execStream(
         command,
         execOptions(request)
      );

      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
         async start(controller) {
            const emit = (event: ExecEvent): void => {
               controller.enqueue(encoder.encode(encodeFrame(event)));
            };
            let seq = 0;
            let terminal = false;
            try {
               for await (const upstreamEvent of parseStream<unknown>(upstream)) {
                  for (const event of toBerryEvents(upstreamEvent, command, () => seq++)) {
                     if (event.type === 'exit' || event.type === 'error') terminal = true;
                     emit(event);
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
      const body = await context.req.json<{ path?: unknown; content?: unknown }>();
      if (typeof body.path !== 'string' || typeof body.content !== 'string') {
         return context.json({ error: 'path and content are required' }, 400);
      }
      await resolve(context.env, context.req.param('id')).writeFile(body.path, body.content);
      return context.json({ written: true });
   });

   app.get('/sessions/:id/files', async (context) => {
      const path = context.req.query('path');
      if (!path) return context.json({ error: 'path is required' }, 400);
      const file = await resolve(context.env, context.req.param('id')).readFile(path);
      return context.json({ content: file.content });
   });

   app.post('/sessions/:id/stop', async (context) => {
      // Kills what is running and leaves the workspace intact, so a stopped
      // run's output can still be read back before it is torn down.
      await resolve(context.env, context.req.param('id')).killAllProcesses();
      return context.json({ stopped: true });
   });

   app.delete('/sessions/:id', async (context) => {
      // "The workspace is destroyed when the run ends" — this is that sentence.
      await resolve(context.env, context.req.param('id')).destroy();
      return context.json({ destroyed: true });
   });

   app.onError((error, context) => {
      // The message reaches Berry's logs, not a browser: this worker has
      // exactly one caller and it is a server holding a shared secret.
      return context.json({ error: describe(error) }, 500);
   });

   return app;
}

interface ExecRequestBody {
   command?: unknown;
   cwd?: unknown;
   env?: unknown;
   timeoutMs?: unknown;
}

function execOptions(request: ExecRequestBody): {
   cwd?: string;
   env?: Record<string, string>;
   timeout: number;
} {
   const cwd = resolveCwd(request.cwd);
   return {
      ...(cwd !== undefined ? { cwd } : {}),
      ...(isStringMap(request.env) ? { env: request.env } : {}),
      timeout:
         typeof request.timeoutMs === 'number' && request.timeoutMs > 0
            ? request.timeoutMs
            : DEFAULT_COMMAND_TIMEOUT_MS,
   };
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
