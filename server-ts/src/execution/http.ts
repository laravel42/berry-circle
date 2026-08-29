import { decodeEvents, isTerminal } from './events.ts';
import {
   ExecutionFailed,
   ExecutionUnavailable,
   type CreateSessionInput,
   type ExecEvent,
   type ExecOptions,
   type ExecResult,
   type ExecutionDriver,
   type ExecutionSession,
} from './driver.ts';

/**
 * The driver for any substrate that speaks `runtime-worker/PROTOCOL.md`.
 *
 * There are two, and this file cannot tell them apart — which is the point.
 * `runtime/` runs containers on the operator's own Docker daemon;
 * `runtime-worker/` runs them on Cloudflare. Both answer the same routes with
 * the same event shapes, so the choice is a URL and a name in a log line.
 *
 * Berry calls out to the substrate and never the reverse. That direction is
 * not incidental: a self-hosted Berry sits behind NAT and could not receive a
 * callback, so keeping the caller on Berry's side means one code path for both
 * rather than a hosted-only inversion.
 */

export interface HttpDriverOptions {
   /** Origin of the substrate, e.g. http://runtime:4300 or https://runtime.example. */
   baseUrl: string;
   /** Presented as a bearer token. The substrate refuses every request without it. */
   token: string;
   /** Reported in logs and the ledger, so an operator can tell which ran. */
   name?: string;
   /** Ceiling on a single non-streaming call. Streams are bounded per command. */
   requestTimeoutMs?: number;
   /** Injected in tests. Defaults to the global. */
   fetch?: typeof globalThis.fetch;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function httpDriver(options: HttpDriverOptions): ExecutionDriver {
   const base = normalizeBase(options.baseUrl);
   const doFetch = options.fetch ?? globalThis.fetch;
   const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

   const call = async (
      path: string,
      init: RequestInit & { stream?: boolean; abort?: AbortSignal | undefined }
   ): Promise<Response> => {
      const { stream, abort, ...rest } = init;
      // A stream is bounded by the command's own timeout, not by this one —
      // aborting a live test suite after 30s because the client got bored is
      // exactly the failure this call exists to avoid. The caller's own signal
      // still applies: that one means the run was cancelled.
      // Both, for a non-stream call: the request still has a ceiling, and a
      // cancelled run still stops it early. `any` rather than a choice,
      // because keeping only one of them loses a guarantee either way.
      const signal = stream
         ? abort
         : abort
           ? AbortSignal.any([abort, AbortSignal.timeout(requestTimeoutMs)])
           : AbortSignal.timeout(requestTimeoutMs);
      let response: Response;
      try {
         response = await doFetch(`${base}${path}`, {
            ...rest,
            ...(signal ? { signal } : {}),
            headers: {
               authorization: `Bearer ${options.token}`,
               'content-type': 'application/json',
               ...(rest.headers ?? {}),
            },
         });
      } catch (cause) {
         throw new ExecutionUnavailable(`execution substrate is unreachable: ${path}`, { cause });
      }
      if (!response.ok) {
         const detail = await response.text().catch(() => '');
         // 5xx and 429 are the substrate having a bad time; 4xx is Berry
         // asking for something it should not have. Only the first is worth a
         // caller retrying, so they are different exceptions.
         const Failure =
            response.status >= 500 || response.status === 429
               ? ExecutionUnavailable
               : ExecutionFailed;
         throw new Failure(`execution substrate refused ${path}: ${response.status} ${clip(detail)}`);
      }
      return response;
   };

   return {
      name: options.name ?? 'http',

      async health(): Promise<void> {
         await call('/health', { method: 'GET' });
      },

      async createSession(input: CreateSessionInput): Promise<ExecutionSession> {
         const response = await call('/sessions', {
            method: 'POST',
            body: JSON.stringify({
               runId: input.runId,
               ...(input.cwd ? { cwd: input.cwd } : {}),
               ...(input.env ? { env: input.env } : {}),
            }),
         });
         const body = (await response.json()) as { sessionId?: unknown };
         if (typeof body.sessionId !== 'string' || body.sessionId === '') {
            throw new ExecutionFailed('execution substrate created a session with no id');
         }
         return session(body.sessionId);
      },
   };

   function session(id: string): ExecutionSession {
      const at = (path: string) => `/sessions/${encodeURIComponent(id)}${path}`;

      return {
         id,

         async exec(command: string, execOptions?: ExecOptions): Promise<ExecResult> {
            const response = await call(at('/exec'), {
               method: 'POST',
               body: JSON.stringify({ command, ...serializeOptions(execOptions) }),
            });
            const body = (await response.json()) as Partial<ExecResult>;
            if (
               typeof body.stdout !== 'string' ||
               typeof body.stderr !== 'string' ||
               typeof body.exitCode !== 'number'
            ) {
               throw new ExecutionFailed('execution substrate returned a malformed result');
            }
            return { stdout: body.stdout, stderr: body.stderr, exitCode: body.exitCode };
         },

         stream(command: string, execOptions?: ExecOptions): AsyncIterable<ExecEvent> {
            return {
               async *[Symbol.asyncIterator]() {
                  const response = await call(at('/exec/stream'), {
                     method: 'POST',
                     stream: true,
                     abort: execOptions?.signal,
                     body: JSON.stringify({ command, ...serializeOptions(execOptions) }),
                  });
                  if (!response.body) {
                     throw new ExecutionFailed('execution substrate returned an empty stream');
                  }

                  let sawTerminal = false;
                  for await (const event of decodeEvents(response.body)) {
                     if (isTerminal(event)) sawTerminal = true;
                     yield event;
                  }
                  // A stream that stops without saying how the command ended is
                  // the one failure that must never look like success: the run
                  // would be recorded as finished with whatever exit code was
                  // never sent.
                  if (!sawTerminal) {
                     throw new ExecutionFailed(
                        'execution stream ended before the command reported an exit'
                     );
                  }
               },
            };
         },

         async writeFile(path: string, content: string): Promise<void> {
            await call(at('/files'), {
               method: 'PUT',
               body: JSON.stringify({ path, content }),
            });
         },

         async readFile(path: string): Promise<string> {
            const response = await call(
               at(`/files?path=${encodeURIComponent(path)}`),
               { method: 'GET' }
            );
            const body = (await response.json()) as { content?: unknown };
            if (typeof body.content !== 'string') {
               throw new ExecutionFailed(`execution substrate returned no content for ${path}`);
            }
            return body.content;
         },

         async stop(): Promise<void> {
            await call(at('/stop'), { method: 'POST' });
         },

         async destroy(): Promise<void> {
            // Teardown runs on the failure path too, so a substrate that has
            // already forgotten this session must not turn a failed run into a
            // failed cleanup. Anything else still raises.
            try {
               await call(at(''), { method: 'DELETE' });
            } catch (error) {
               if (error instanceof ExecutionFailed) return;
               throw error;
            }
         },
      };
   }
}

function serializeOptions(options: ExecOptions | undefined): Record<string, unknown> {
   if (!options) return {};
   return {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
   };
}

/** Origin only, no trailing slash — paths below are absolute. */
function normalizeBase(value: string): string {
   let parsed: URL;
   try {
      parsed = new URL(value);
   } catch (cause) {
      throw new ExecutionUnavailable(`execution base URL is not a URL: ${value}`, { cause });
   }
   if (parsed.protocol !== 'https:' && !isPrivateHost(parsed.hostname)) {
      // The bearer token is on every request, so plaintext is only acceptable
      // where the request cannot leave a network the operator controls.
      throw new ExecutionUnavailable(
         `execution base URL must be https unless the host is private: ${value}`
      );
   }
   return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
}

/**
 * Whether plaintext to this host stays on a network the operator controls.
 *
 * Three cases, and the middle one is the interesting one. A single-label
 * hostname — `runtime`, the Compose service name — has no public DNS meaning,
 * so it can only resolve on a private network. That is the normal deployment,
 * and refusing it would force either TLS between two containers or an
 * exception flag that gets left on.
 *
 * A dotted name is refused because `http://runtime.example.com` is a request
 * that can cross the internet carrying the token.
 */
function isPrivateHost(hostname: string): boolean {
   const host = hostname.replace(/^\[|\]$/g, '');
   if (host === 'localhost' || host === '::1') return true;

   const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
   if (ipv4) {
      const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
      if (a === 127 || a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      return false;
   }

   // Unique local IPv6 (fc00::/7), the address range Docker hands out.
   if (host.includes(':')) return /^f[cd]/i.test(host);

   // No dot: a container or LAN name, which cannot be a public DNS record.
   return !host.includes('.');
}

function clip(value: string): string {
   return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}
