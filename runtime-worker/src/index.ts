import { getSandbox, parseSSEStream } from '@cloudflare/sandbox';
import { createApp, type Env as AppEnv, type SandboxLike } from './app.ts';

// The Sandbox Durable Object has to be re-exported for the worker to deploy at
// all. Without this line wrangler accepts the config and the binding resolves
// to nothing.
export { Sandbox } from '@cloudflare/sandbox';

/**
 * Berry's execution substrate for the hosted workspace.
 *
 * One sandbox per run, addressed by the run's own id. The SDK guarantees the
 * same id returns the same instance, which is what makes a retried request
 * land in the workspace the run was already using rather than a fresh one.
 *
 * There is deliberately no shell session. Every command carries its own `cwd`
 * and `env`, so what a command sees is a function of the request rather than of
 * whatever the previous one left behind — a run that fails halfway and is
 * retried behaves the way it did the first time. Sessions can be added behind
 * the same wire contract if an agent ever needs them; predictability is worth
 * more today.
 *
 * The routes live in `app.ts` so they can be tested without a container. This
 * file is only the wiring.
 */

export interface Env extends AppEnv {
   Sandbox: DurableObjectNamespace<import('@cloudflare/sandbox').Sandbox>;
}

/**
 * The run id namespaced, so a sandbox cannot be addressed by guessing a bare
 * uuid that means something else elsewhere in the account.
 */
function sandboxFor(env: AppEnv, runId: string): SandboxLike {
   return getSandbox((env as Env).Sandbox, `run-${runId}`);
}

export default createApp({ sandbox: sandboxFor, parseStream: parseSSEStream });
