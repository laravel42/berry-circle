import { createServer, type IncomingMessage, type Server } from 'node:http';
import { taskEnvelopeSchema } from '../../../runtime/envelope.ts';
import { encodeLifecycle } from '../../../runtime/lifecycle.ts';
import { handleInvocation, type HandlerDeps } from './handler.ts';

/**
 * The AgentCore Runtime service contract: `GET /ping` and `POST /invocations`
 * on 0.0.0.0:8080.
 *
 * `/ping` is how AgentCore decides whether the microVM is idle: `HealthyBusy`
 * while any loop works keeps it from being reaped after the invoke stream has
 * closed. `/invocations` answers with the lifecycle stream and keeps working
 * if the caller goes away — the work is committed and the conversation kept
 * warm, and the server records the broken stream as retryable.
 */

const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const KEEPALIVE_MS = 15_000;

export function createRuntimeServer(deps: HandlerDeps & { localControl?: boolean }): Server {
   let lastUpdate = Math.floor(Date.now() / 1000);
   const touch = () => {
      lastUpdate = Math.floor(Date.now() / 1000);
   };

   return createServer((request, response) => {
      const path = (request.url ?? '/').split('?')[0] ?? '/';
      const reply = (status: number, body: unknown) => {
         const payload = JSON.stringify(body);
         response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
         response.end(payload);
      };

      if (request.method === 'GET' && path === '/ping') {
         return reply(200, { status: deps.registry.busy ? 'HealthyBusy' : 'Healthy', time_of_last_update: lastUpdate });
      }

      if (deps.localControl && request.method === 'DELETE' && path.startsWith('/sessions/')) {
         const stopped = deps.registry.stop(decodeURIComponent(path.slice('/sessions/'.length)));
         response.writeHead(stopped ? 204 : 404).end();
         return;
      }

      if (request.method === 'POST' && path === '/invocations') {
         void readBody(request)
            .then((raw) => {
               let parsedJson: unknown;
               try {
                  parsedJson = JSON.parse(raw);
               } catch {
                  return reply(400, { error: 'the body is not JSON' });
               }
               const parsed = taskEnvelopeSchema.safeParse(parsedJson);
               if (!parsed.success) {
                  return reply(400, { error: 'the task envelope is not valid', fields: parsed.error.issues.map((i) => i.path.join('.')) });
               }
               const envelope = parsed.data;
               const header = request.headers[SESSION_HEADER];
               if (typeof header === 'string' && header !== envelope.runtimeSessionId) {
                  return reply(400, { error: 'the session header does not match the envelope' });
               }
               response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
               const keepalive = setInterval(() => {
                  if (!response.writableEnded && !response.destroyed) response.write(': keepalive\n\n');
               }, KEEPALIVE_MS);
               keepalive.unref();
               touch();
               void handleInvocation(
                  envelope,
                  (event) => {
                     touch();
                     if (!response.writableEnded && !response.destroyed) response.write(encodeLifecycle(event));
                  },
                  deps
               ).finally(() => {
                  clearInterval(keepalive);
                  touch();
                  if (!response.writableEnded && !response.destroyed) response.end();
               });
            })
            .catch(() => reply(413, { error: 'the body is too large' }));
         return;
      }

      reply(404, { error: `no route for ${request.method} ${path}` });
   });
}

function readBody(request: IncomingMessage): Promise<string> {
   return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on('data', (chunk: Buffer) => {
         size += chunk.byteLength;
         if (size > MAX_BODY_BYTES) {
            reject(new Error('too large'));
            request.destroy();
            return;
         }
         chunks.push(chunk);
      });
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      request.on('error', reject);
   });
}
