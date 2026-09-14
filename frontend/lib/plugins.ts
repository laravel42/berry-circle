import { z } from 'zod';
import { apiFetch } from './api';

/**
 * Workspace plugins, as `/api/v1/plugins/{workspaceId}` serves them.
 * Secret values are write-only: the server says whether one is set, never what it is.
 */

const configValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const configFieldSchema = z.object({
   key: z.string(),
   label: z.string(),
   type: z.enum(['string', 'number', 'boolean']),
   required: z.boolean(),
});

const installationSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   key: z.string(),
   name: z.string(),
   version: z.string(),
   description: z.string(),
   source: z.enum(['url', 'upload']),
   sourceUrl: z.string().nullable(),
   enabled: z.boolean(),
   config: z.record(configValueSchema),
   configFields: z.array(configFieldSchema),
   secrets: z.array(z.object({ name: z.string(), description: z.string(), set: z.boolean() })),
   scopes: z.array(z.string()),
   hooks: z.array(
      z.object({
         key: z.string(),
         trigger: z.enum(['event', 'schedule']),
         events: z.array(z.string()).optional(),
         everyMinutes: z.number().optional(),
      })
   ),
   surfaces: z.array(z.object({ key: z.string(), title: z.string() })),
   mcpTools: z.array(
      z.object({ name: z.string(), description: z.string(), approved: z.boolean() })
   ),
   installedBy: z.string(),
   createdAt: z.string(),
   updatedAt: z.string(),
});

const previewSchema = z.object({
   key: z.string(),
   name: z.string(),
   version: z.string(),
   description: z.string(),
   baseUrl: z.string(),
   scopes: z.array(z.string()),
   config: z.array(configFieldSchema),
   secrets: z.array(z.object({ name: z.string(), description: z.string() })),
   events: z.array(z.string()),
   schedules: z.array(z.object({ key: z.string(), everyMinutes: z.number() })),
   surfaces: z.array(z.object({ key: z.string(), title: z.string() })),
   mcpTools: z.array(z.string()),
   files: z.array(z.object({ path: z.string(), size: z.number() })),
});

const invocationSchema = z.object({
   id: z.string(),
   kind: z.enum(['event', 'schedule', 'surface', 'mcp']),
   trigger: z.string(),
   status: z.enum(['ok', 'error']),
   httpStatus: z.number().nullable(),
   durationMs: z.number(),
   error: z.string().nullable(),
   createdAt: z.string(),
});

const storedValueSchema = z.object({ key: z.string(), value: z.unknown(), updatedAt: z.string() });

export type PluginConfigValue = z.infer<typeof configValueSchema>;
export type PluginConfigField = z.infer<typeof configFieldSchema>;
export type PluginInstallation = z.infer<typeof installationSchema>;
export type PluginPreview = z.infer<typeof previewSchema>;
export type PluginInvocation = z.infer<typeof invocationSchema>;
export type PluginStoredValue = z.infer<typeof storedValueSchema>;
export type PluginSource = { url: string } | { package: unknown };

const base = (workspaceId: string) => `/api/v1/plugins/${encodeURIComponent(workspaceId)}`;
const one = (workspaceId: string, id: string) =>
   `${base(workspaceId)}/installations/${encodeURIComponent(id)}`;

function parse<T extends z.ZodTypeAny>(schema: T, json: unknown, what: string): z.infer<T> {
   const parsed = schema.safeParse(json);
   if (!parsed.success) throw new Error(`${what} response was not recognized`);
   return parsed.data;
}

export async function loadPlugins(workspaceId: string): Promise<PluginInstallation[]> {
   return parse(
      z.object({ nodes: z.array(installationSchema) }),
      await apiFetch(`${base(workspaceId)}/installations`),
      'Plugins'
   ).nodes;
}

export async function previewPlugin(
   workspaceId: string,
   source: PluginSource
): Promise<PluginPreview> {
   return parse(
      previewSchema,
      await apiFetch(`${base(workspaceId)}/preview`, {
         method: 'POST',
         body: JSON.stringify(source),
      }),
      'Preview'
   );
}

export async function installPlugin(
   workspaceId: string,
   source: PluginSource,
   config: Record<string, PluginConfigValue>
): Promise<{ installation: PluginInstallation; signingSecret: string }> {
   return parse(
      z.object({ installation: installationSchema, signingSecret: z.string() }),
      await apiFetch(`${base(workspaceId)}/installations`, {
         method: 'POST',
         body: JSON.stringify({ ...source, config }),
      }),
      'Plugin'
   );
}

export async function loadPlugin(
   workspaceId: string,
   id: string
): Promise<PluginInstallation & { files: { path: string; size: number }[] }> {
   return parse(
      installationSchema.extend({
         files: z.array(z.object({ path: z.string(), size: z.number() })),
      }),
      await apiFetch(one(workspaceId, id)),
      'Plugin'
   );
}

export async function updatePlugin(
   workspaceId: string,
   id: string,
   patch: { enabled?: boolean; config?: Record<string, PluginConfigValue> }
): Promise<PluginInstallation> {
   return parse(
      installationSchema,
      await apiFetch(one(workspaceId, id), { method: 'PATCH', body: JSON.stringify(patch) }),
      'Plugin'
   );
}

export async function uninstallPlugin(workspaceId: string, id: string): Promise<void> {
   await apiFetch(one(workspaceId, id), { method: 'DELETE' });
}

export async function setPluginSecret(
   workspaceId: string,
   id: string,
   name: string,
   value: string
): Promise<void> {
   await apiFetch(`${one(workspaceId, id)}/secrets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
   });
}

export async function deletePluginSecret(
   workspaceId: string,
   id: string,
   name: string
): Promise<void> {
   await apiFetch(`${one(workspaceId, id)}/secrets/${encodeURIComponent(name)}`, {
      method: 'DELETE',
   });
}

export async function setPluginTool(
   workspaceId: string,
   id: string,
   tool: string,
   approved: boolean
): Promise<PluginInstallation> {
   return parse(
      installationSchema,
      await apiFetch(`${one(workspaceId, id)}/tools/${encodeURIComponent(tool)}`, {
         method: 'PUT',
         body: JSON.stringify({ approved }),
      }),
      'Plugin'
   );
}

export async function loadPluginInvocations(
   workspaceId: string,
   id: string
): Promise<PluginInvocation[]> {
   return parse(
      z.object({ nodes: z.array(invocationSchema) }),
      await apiFetch(`${one(workspaceId, id)}/invocations?first=50`),
      'Invocations'
   ).nodes;
}

export async function loadPluginStorage(
   workspaceId: string,
   id: string
): Promise<PluginStoredValue[]> {
   return parse(
      z.object({ nodes: z.array(storedValueSchema) }),
      await apiFetch(`${one(workspaceId, id)}/storage?first=50`),
      'Storage'
   ).nodes;
}

export async function launchPluginSurface(
   workspaceId: string,
   id: string,
   surface: string
): Promise<{ url: string; expiresAt: string }> {
   return parse(
      z.object({ url: z.string(), expiresAt: z.string() }),
      await apiFetch(`${one(workspaceId, id)}/surfaces/${encodeURIComponent(surface)}/launch`, {
         method: 'POST',
      }),
      'Surface'
   );
}
