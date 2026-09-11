import { z } from 'zod';
import { apiFetch } from './api';

/**
 * Where a workspace's agents run: `/api/v1/runtimes`. Profile env values are
 * sealed on the server and never come back; only their names do.
 */

const runtimeSchema = z.object({
   id: z.string(),
   name: z.string(),
   kind: z.enum(['platform', 'custom']),
   driver: z.enum(['agentcore', 'http']),
   arn: z.string().nullable(),
   endpointUrl: z.string().nullable(),
   qualifier: z.string(),
   region: z.string().nullable(),
   status: z.enum(['active', 'unreachable', 'disabled']),
   lastHealthAt: z.string().nullable(),
   lastHealthError: z.string().nullable(),
   concurrencyLimit: z.number().nullable(),
   visibility: z.enum(['private', 'workspace']),
   idleTimeoutS: z.number(),
   maxLifetimeS: z.number(),
   isDefault: z.boolean(),
   activeRuns: z.number(),
});

const runtimeDetailSchema = runtimeSchema.extend({
   activity: z.array(z.object({ day: z.string(), runs: z.number(), failed: z.number() })),
});

const profileSchema = z.object({
   id: z.string(),
   runtimeId: z.string(),
   name: z.string(),
   envKeys: z.array(z.string()),
   modelDefault: z.string().nullable(),
   timeoutS: z.number().nullable(),
   maxConcurrency: z.number().nullable(),
   idleTimeoutS: z.number().nullable(),
   lifecycleApplied: z.boolean().optional(),
   lifecycleError: z.string().optional(),
});

export type Runtime = z.infer<typeof runtimeSchema>;
export type RuntimeDetail = z.infer<typeof runtimeDetailSchema>;
export type RuntimeProfile = z.infer<typeof profileSchema>;

export interface RuntimeInput {
   name?: string;
   driver?: 'agentcore' | 'http';
   arn?: string | null;
   endpointUrl?: string | null;
   concurrencyLimit?: number | null;
   idleTimeoutS?: number;
   isDefault?: boolean;
   status?: 'active' | 'disabled';
}

export interface ProfileInput {
   name: string;
   env?: Record<string, string>;
   modelDefault?: string | null;
   idleTimeoutS?: number | null;
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, json: unknown, what: string): T {
   const parsed = schema.safeParse(json);
   if (!parsed.success) throw new Error(`${what} response was not recognized`);
   return parsed.data;
}

const send = (method: string, body: unknown): RequestInit => ({
   method,
   headers: { 'content-type': 'application/json' },
   body: JSON.stringify(body),
});

const path = (id: string) => `/api/v1/runtimes/${encodeURIComponent(id)}`;

export async function listRuntimes(): Promise<Runtime[]> {
   const json = await apiFetch<unknown>('/api/v1/runtimes');
   return parse(z.object({ nodes: z.array(runtimeSchema) }), json, 'Runtime list').nodes;
}

export async function getRuntime(id: string): Promise<RuntimeDetail> {
   return parse(runtimeDetailSchema, await apiFetch<unknown>(path(id)), 'Runtime');
}

export async function createRuntime(input: RuntimeInput): Promise<Runtime> {
   return parse(
      runtimeSchema,
      await apiFetch<unknown>('/api/v1/runtimes', send('POST', input)),
      'Runtime'
   );
}

export async function updateRuntime(id: string, input: RuntimeInput): Promise<Runtime> {
   return parse(runtimeSchema, await apiFetch<unknown>(path(id), send('PATCH', input)), 'Runtime');
}

export async function checkRuntimeHealth(id: string): Promise<Runtime> {
   return parse(
      runtimeSchema,
      await apiFetch<unknown>(`${path(id)}/health`, send('POST', {})),
      'Runtime'
   );
}

export async function listProfiles(runtimeId: string): Promise<RuntimeProfile[]> {
   const json = await apiFetch<unknown>(`${path(runtimeId)}/profiles`);
   return parse(z.object({ nodes: z.array(profileSchema) }), json, 'Profile list').nodes;
}

export async function createProfile(
   runtimeId: string,
   input: ProfileInput
): Promise<RuntimeProfile> {
   const json = await apiFetch<unknown>(`${path(runtimeId)}/profiles`, send('POST', input));
   return parse(profileSchema, json, 'Profile');
}

/**
 * Puts an agent on a runtime, or takes it off one.
 *
 * The binding lives on the runtime rather than on the agent, so changing it
 * from the agent's own settings page is still a write to this route. Passing
 * no runtime clears the binding, which is what "no runtime" means: the agent
 * keeps existing and its work cannot run.
 */
export async function bindAgentRuntime(
   runtimeId: string,
   agentId: string,
   profileId: string | null = null
): Promise<void> {
   await apiFetch(
      `${path(runtimeId)}/agents/${encodeURIComponent(agentId)}`,
      send('PUT', { profileId })
   );
}

export async function unbindAgentRuntime(runtimeId: string, agentId: string): Promise<void> {
   await apiFetch(`${path(runtimeId)}/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
}

/** "1 h", "8 h", "45 min": how a lifecycle reads to a person. */
export function formatSeconds(seconds: number): string {
   if (seconds % 3600 === 0) return `${seconds / 3600} h`;
   return `${Math.round(seconds / 60)} min`;
}
