import { z } from 'zod';
import { apiFetch } from './api';

/**
 * The tool catalog: providers, whether the workspace has connected them, and
 * the tools each one registers. Workflow `action` steps name a tool by
 * provider and operation; everything else about integrations (connecting,
 * grants, audit) lives in settings and arrives with the canvas phase.
 */

export const providerToolSchema = z.object({
   name: z.string(),
   description: z.string().nullish(),
   effect: z.string(),
   requiresApproval: z.boolean().default(false),
   enabledByDefault: z.boolean().nullish(),
   kind: z.string().nullish(),
});

export const providerSchema = z.object({
   id: z.string(),
   name: z.string(),
   description: z.string().nullish(),
   configured: z.boolean().default(false),
   connected: z.boolean().default(false),
   tools: z.array(providerToolSchema).default([]),
});

export type ProviderTool = z.infer<typeof providerToolSchema>;
export type Provider = z.infer<typeof providerSchema>;

export async function listProviders(workspaceId: string): Promise<Provider[]> {
   const params = new URLSearchParams({ workspaceId });
   const json: unknown = await apiFetch(`/api/v1/integrations/providers?${params.toString()}`);
   const parsed = z.object({ providers: z.array(providerSchema) }).safeParse(json);
   if (!parsed.success) {
      throw new Error('Provider list was not recognized');
   }
   return parsed.data.providers;
}

/** Providers for a picker; a failed read leaves the catalog empty. */
export async function loadProviders(workspaceId: string): Promise<Provider[]> {
   if (!workspaceId) return [];
   try {
      return await listProviders(workspaceId);
   } catch {
      return [];
   }
}

/** `slack.post_message` → `post_message`: the operation a step names. */
export function toolOperation(toolName: string): string {
   const dot = toolName.indexOf('.');
   return dot >= 0 ? toolName.slice(dot + 1) : toolName;
}

export function findTool(
   providers: Provider[],
   provider: string,
   operation: string
): { provider: Provider; tool: ProviderTool } | undefined {
   const owner = providers.find((candidate) => candidate.id === provider);
   if (!owner) return undefined;
   const tool = owner.tools.find((candidate) => toolOperation(candidate.name) === operation);
   return tool ? { provider: owner, tool } : undefined;
}

/**
 * Tools a person can put in an action step: writes and side effects, not
 * the read-only lookups an agent would use, and not Berry's own event
 * topics, which are triggers rather than actions.
 */
export function actionTools(provider: Provider): ProviderTool[] {
   return provider.tools.filter((tool) => tool.effect !== 'read');
}

export function describeToolEffect(effect: string): string {
   switch (effect) {
      case 'read':
         return 'reads';
      case 'write':
         return 'writes';
      case 'external_side_effect':
         return 'external';
      case 'destructive':
         return 'destructive';
      default:
         return effect;
   }
}
