/**
 * The AgentCore Runtime service contract, and nothing more.
 *
 * A runtime will not deploy unless its container answers two endpoints on
 * `0.0.0.0:8080` — `GET /ping` for health and `POST /invocations` for agent
 * calls. Berry does not use the second one: its agent loop runs in Berry's own
 * process (ADR-0008), and the only thing it wants from a runtime is a shell,
 * which arrives out-of-band through `InvokeAgentRuntimeCommand` rather than
 * through this server.
 *
 * So this file exists to satisfy the contract, not to do work. It is
 * deliberately dependency-free — `node:http` only — so the image needs no
 * install step, builds in seconds, and has nothing to audit or patch.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);

const json = (response, status, body) => {
   const payload = JSON.stringify(body);
   response.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
   });
   response.end(payload);
};

const server = createServer((request, response) => {
   const path = (request.url ?? '/').split('?')[0];

   // Health. AgentCore polls this; the exact shape is the contract's.
   if (request.method === 'GET' && path === '/ping') {
      return json(response, 200, { status: 'Healthy' });
   }

   // Agent invocation. Answered rather than implemented: a runtime that 404s
   // here looks broken to anything that probes it, and reporting plainly what
   // this runtime is for beats an empty 200 that implies work happened.
   if (request.method === 'POST' && path === '/invocations') {
      // Drained so the connection closes cleanly even though the body is unused.
      request.resume();
      return json(response, 200, {
         status: 'success',
         response:
            'This runtime is a Berry execution sandbox. Its agent loop runs in Berry, ' +
            'not here; use InvokeAgentRuntimeCommand to run shell commands in this session.',
      });
   }

   return json(response, 404, { status: 'error', message: `no route for ${request.method} ${path}` });
});

// 0.0.0.0, not localhost: the contract requires the port be reachable from
// outside the container, and binding the loopback would pass a local test and
// fail every health check in the runtime.
server.listen(PORT, '0.0.0.0', () => {
   console.log(`berry agentcore sandbox listening on 0.0.0.0:${PORT}`);
});

// Terminate promptly on the signal AgentCore stops a container with, so a
// session teardown does not wait out a kill timeout.
for (const signal of ['SIGTERM', 'SIGINT']) {
   process.once(signal, () => server.close(() => process.exit(0)));
}
