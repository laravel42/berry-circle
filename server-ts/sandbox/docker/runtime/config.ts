/**
 * What this service needs to know, and the reasoning behind each default.
 *
 * Every limit here bounds a container that will run code an agent wrote. The
 * defaults are deliberately modest: a run that needs more should say so in
 * configuration, rather than a runaway one being able to take the host down
 * because nothing was set.
 */

export interface Config {
   addr: { host: string; port: number };
   /** The shared secret Berry presents. Empty makes every route refuse. */
   token: string;
   dockerSocket: string;
   /** The image runs happen in. Must contain the toolchain an agent expects. */
   image: string;
   workdir: string;
   memoryBytes: number;
   nanoCpus: number;
   pidsLimit: number;
   networkMode: string;
   maxContainers: number;
}

export class ConfigError extends Error {
   override readonly name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
   const addr = (env.RUNTIME_ADDR ?? '0.0.0.0:4300').trim();
   const separator = addr.lastIndexOf(':');
   const port = Number(separator > 0 ? addr.slice(separator + 1) : addr);
   if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ConfigError(`RUNTIME_ADDR must end in a port, got ${addr}`);
   }

   return {
      addr: { host: separator > 0 ? addr.slice(0, separator) : '0.0.0.0', port },
      // Not defaulted and not required at boot: an operator who starts this
      // without a token gets a service that refuses every call and says why,
      // which is more useful than a process that will not start.
      token: (env.BERRY_RUNTIME_TOKEN ?? '').trim(),
      dockerSocket: (env.DOCKER_SOCKET ?? '/var/run/docker.sock').trim(),
      // node:22-alpine has no git, so it is enough to run commands and not
      // enough to clone a repository. `sandbox/docker/Dockerfile` builds the image
      // that is, and the README says how.
      image: (env.BERRY_SANDBOX_IMAGE ?? 'node:22-alpine').trim(),
      workdir: (env.BERRY_SANDBOX_WORKDIR ?? '/workspace').trim(),
      // 2 GiB and one core: enough to install a dependency tree and run a test
      // suite, and not enough for one run to starve the host.
      memoryBytes: positive(env.BERRY_SANDBOX_MEMORY_MB, 2048) * 1024 * 1024,
      nanoCpus: Math.round(positiveFloat(env.BERRY_SANDBOX_CPUS, 1) * 1e9),
      // A fork bomb is the cheapest way for generated code to take a host down.
      pidsLimit: positive(env.BERRY_SANDBOX_PIDS, 512),
      // Agents install packages and clone repositories, so the default has
      // network. `none` is the setting for a deployment that does not want it.
      networkMode: (env.BERRY_SANDBOX_NETWORK ?? 'bridge').trim(),
      // The ceiling that turns "the host fell over" into "the run waited".
      maxContainers: positive(env.BERRY_SANDBOX_MAX_CONTAINERS, 8),
   };
}

function positive(value: string | undefined, fallback: number): number {
   const trimmed = (value ?? '').trim();
   if (!/^\d+$/.test(trimmed)) return fallback;
   const parsed = Number(trimmed);
   return parsed > 0 ? parsed : fallback;
}

function positiveFloat(value: string | undefined, fallback: number): number {
   const parsed = Number((value ?? '').trim());
   return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
