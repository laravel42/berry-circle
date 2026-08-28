import { serve } from '@hono/node-server';
import { createApp, type Runtime } from './app.ts';
import { Docker } from './docker.ts';
import { loadConfig } from './config.ts';

/**
 * Berry's execution substrate for a self-hosted deployment.
 *
 * It exists as a separate service for one reason: talking to the Docker socket
 * is root-equivalent on the host, and Berry's API container runs read-only with
 * every capability dropped. Putting the socket here keeps that posture intact —
 * the API reaches containers over HTTP with a shared secret, exactly as it
 * reaches the Cloudflare worker, and never touches the daemon itself.
 *
 * One container per run, named for the run. The same id always resolves to the
 * same workspace, so a retried request lands where the run already was.
 */

const config = loadConfig();
const docker = new Docker({ socketPath: config.dockerSocket });

const runtime: Runtime = {
   ping: () => docker.ping(),

   async open(runId, input) {
      const existing = await this.find(runId);
      if (existing) return existing;
      await docker.ensureImage(config.image);
      return docker.createContainer({
         image: config.image,
         name: containerName(runId),
         cwd: input.cwd ?? config.workdir,
         env: { CI: 'true', ...(input.env ?? {}) },
         memoryBytes: config.memoryBytes,
         nanoCpus: config.nanoCpus,
         pidsLimit: config.pidsLimit,
         networkMode: config.networkMode,
      });
   },

   async find(runId) {
      const name = containerName(runId);
      // Addressed by name rather than by a map held in memory, so a restart of
      // this service does not orphan every workspace it was tracking.
      return (await docker.containerExists(name)) ? name : null;
   },

   exec: (containerId, command, options) =>
      docker.execStream({ containerId, command, ...options }),

   putFile: (containerId, path, content) => docker.putFile(containerId, path, content),
   getFile: (containerId, path) => docker.getFile(containerId, path),
   kill: (containerId) => docker.kill(containerId),
   remove: (containerId) => docker.remove(containerId),

   async atCapacity() {
      const running = await docker.listRunContainers();
      return running.length >= config.maxContainers;
   },
};

/** Namespaced so a container cannot be addressed by guessing a bare uuid. */
function containerName(runId: string): string {
   return `berry-run-${runId.replace(/[^a-zA-Z0-9_.-]/g, '')}`;
}

const app = createApp(runtime, { token: config.token, workdir: config.workdir });

serve({ fetch: app.fetch, hostname: config.addr.host, port: config.addr.port });
log('Berry runtime listening', {
   addr: `${config.addr.host}:${config.addr.port}`,
   image: config.image,
   maxContainers: config.maxContainers,
   // Named at boot so an operator can see the daemon this trusts without
   // reading the environment back.
   dockerSocket: config.dockerSocket,
});

docker.ping().then(
   () => log('container runtime reachable'),
   (error: unknown) =>
      // Reported, not fatal: the daemon may come up after this service, and
      // /health already tells a caller the difference.
      log('container runtime is not reachable yet', {
         error: error instanceof Error ? error.message : String(error),
      })
);

function log(msg: string, fields: Record<string, unknown> = {}): void {
   // The same JSON line shape the API emits, so one pipeline reads both.
   console.log(
      JSON.stringify({ time: new Date().toISOString(), level: 'INFO', msg, service: 'berry-runtime', ...fields })
   );
}
