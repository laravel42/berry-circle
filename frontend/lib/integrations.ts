import { z } from 'zod';
import { BerryApiError, apiFetch } from './api';

/**
 * Integrations: the provider catalog with this workspace's connection state
 * folded in, the connections themselves, the OAuth start and disconnect
 * calls, and the grants that say which tools an agent may reach. Workflow
 * `action` steps name a tool by provider and operation; settings shows the
 * same catalog with Connect and Disconnect beside each provider.
 *
 * No call here ever returns a credential: the server's resources have no
 * field that could hold one, and the OAuth code lands on the server, not in
 * a page.
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
   status: z.string().nullish(),
   accountName: z.string().nullish(),
   scopes: z.array(z.string()).nullish(),
   tools: z.array(providerToolSchema).default([]),
});

export const providerConnectionSchema = z.object({
   id: z.string(),
   provider: z.string(),
   status: z.string(),
   statusDetail: z.string().nullish(),
   accountId: z.string().nullish(),
   accountName: z.string().nullish(),
   scopes: z.array(z.string()).nullish(),
   expiresAt: z.string().nullish(),
   createdAt: z.string(),
   updatedAt: z.string(),
});

export const toolGrantSchema = z.object({
   agentId: z.string().nullish(),
   provider: z.string(),
   tool: z.string(),
   maxEffect: z.string(),
});

export type ProviderTool = z.infer<typeof providerToolSchema>;
export type Provider = z.infer<typeof providerSchema>;
export type ProviderConnection = z.infer<typeof providerConnectionSchema>;
export type ToolGrant = z.infer<typeof toolGrantSchema>;

/** Berry's own provider: its tools run inside the product and need no connection. */
export const BUILT_IN_PROVIDER = 'berry';

// ---------------------------------------------------------------------------
// Calls

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

export async function listConnections(): Promise<ProviderConnection[]> {
   const json: unknown = await apiFetch('/api/v1/integrations/connections');
   const parsed = z.object({ connections: z.array(providerConnectionSchema) }).safeParse(json);
   if (!parsed.success) {
      throw new Error('Connection list was not recognized');
   }
   return parsed.data.connections;
}

/**
 * Starts the OAuth flow and returns where to send the browser. The
 * provider returns it to the API's callback, which then sends it back to
 * settings with `?integration=<id>&status=<outcome>`.
 * Throws `PROVIDER_NOT_CONFIGURED`, `INTEGRATIONS_NOT_CONFIGURED`, `FORBIDDEN`.
 */
export async function startAuthorize(provider: string): Promise<string> {
   const json: unknown = await apiFetch(
      `/api/v1/integrations/connections/${encodeURIComponent(provider)}/authorize`,
      { method: 'POST' }
   );
   const parsed = z.object({ authorizeUrl: z.string().url() }).safeParse(json);
   if (!parsed.success) {
      throw new Error('Authorize response was not recognized');
   }
   return parsed.data.authorizeUrl;
}

/** Removes the connection and every grant that rode on it. Throws `NOT_FOUND`, `FORBIDDEN`. */
export async function disconnectProvider(provider: string): Promise<void> {
   await apiFetch(`/api/v1/integrations/connections/${encodeURIComponent(provider)}`, {
      method: 'DELETE',
   });
}

export async function listGrants(): Promise<ToolGrant[]> {
   const json: unknown = await apiFetch('/api/v1/integrations/grants');
   const parsed = z.object({ grants: z.array(toolGrantSchema) }).safeParse(json);
   if (!parsed.success) {
      throw new Error('Grant list was not recognized');
   }
   return parsed.data.grants;
}

// ---------------------------------------------------------------------------
// Reading the catalog

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

const EVENT_SUFFIX =
   /_(created|updated|changed|completed|failed|started|assigned|approved|rejected|received|deleted|cancelled|expired)$/;

/**
 * Whether a workflow uses the tool to start a run or to do something. The
 * catalog says so when the server sends `kind`; until it does, a read-only
 * tool named after something that happened is a trigger.
 */
export function toolKind(tool: ProviderTool): 'trigger' | 'action' {
   if (tool.kind === 'trigger' || tool.kind === 'action') return tool.kind;
   return tool.effect === 'read' && EVENT_SUFFIX.test(toolOperation(tool.name))
      ? 'trigger'
      : 'action';
}

/**
 * Tools a person can put in an action step: writes and side effects, not
 * the read-only lookups an agent would use, and not Berry's own event
 * topics, which are triggers rather than actions.
 */
export function actionTools(provider: Provider): ProviderTool[] {
   return provider.tools.filter((tool) => tool.effect !== 'read');
}

/** The events a provider can start a workflow on: its tools of kind `trigger`. */
export function triggerTools(provider: Provider): ProviderTool[] {
   return provider.tools.filter((tool) => toolKind(tool) === 'trigger');
}

/**
 * True for a provider whose deliveries Berry ingests at
 * `/api/v1/hooks/{provider}`: it publishes trigger events and is not Berry
 * itself, whose triggers are the workspace's own facts.
 */
export function supportsInboundDeliveries(provider: Provider): boolean {
   return provider.id !== BUILT_IN_PROVIDER && triggerTools(provider).length > 0;
}

/** Providers that carry no account id at authorisation, so their hook URL names the workspace. */
const WORKSPACE_ROUTED_PROVIDERS = new Set(['github', 'linear']);

/** The ingestor path to register with the provider, workspace query included where routing needs it. */
export function providerHookPath(providerId: string, workspaceId: string): string {
   const base = `/api/v1/hooks/${encodeURIComponent(providerId)}`;
   return WORKSPACE_ROUTED_PROVIDERS.has(providerId)
      ? `${base}?workspaceId=${encodeURIComponent(workspaceId)}`
      : base;
}

/** Which deployment secret verifies a provider's deliveries, for the note beside the URL. */
export function providerHookSecretName(providerId: string): string | null {
   switch (providerId) {
      case 'github':
         return 'GITHUB_WEBHOOK_SECRET';
      case 'slack':
         return 'SLACK_SIGNING_SECRET';
      case 'linear':
         return 'LINEAR_WEBHOOK_SECRET';
      default:
         return null;
   }
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

/** "Connected", "Not connected", "Built in", or the connection's own trouble. */
export function describeProviderState(provider: Provider): {
   label: string;
   tone: 'complete' | 'attention' | 'neutral' | 'danger';
} {
   if (provider.id === BUILT_IN_PROVIDER) return { label: 'Built in', tone: 'neutral' };
   if (!provider.connected) return { label: 'Not connected', tone: 'attention' };
   switch (provider.status) {
      case 'connected':
      case undefined:
      case null:
      case '':
         return { label: 'Connected', tone: 'complete' };
      case 'expired':
         return { label: 'Expired', tone: 'attention' };
      case 'revoked':
         return { label: 'Revoked', tone: 'danger' };
      case 'error':
         return { label: 'Needs attention', tone: 'danger' };
      default:
         return { label: provider.status, tone: 'attention' };
   }
}

/** The words for the `?status=` a provider callback returns with. */
export function describeConnectionResult(
   status: string,
   providerName: string
): { ok: boolean; message: string } {
   switch (status) {
      case 'connected':
         return { ok: true, message: `${providerName} connected` };
      case 'denied':
         return { ok: false, message: `${providerName} was not connected: access was denied.` };
      case 'expired':
         return {
            ok: false,
            message: `The ${providerName} sign-in took too long. Start again from Connect.`,
         };
      case 'invalid_state':
      case 'invalid_response':
         return {
            ok: false,
            message: `${providerName} sent back something this session did not start. Try Connect again.`,
         };
      case 'exchange_failed':
         return {
            ok: false,
            message: `${providerName} refused the sign-in. Check the app's credentials and try again.`,
         };
      default:
         return { ok: false, message: `Connecting ${providerName} failed. Try again.` };
   }
}

/** Human wording for a refused integration call. */
export function describeIntegrationFailure(error: unknown): string {
   if (error instanceof BerryApiError) {
      switch (error.code) {
         case 'PROVIDER_NOT_CONFIGURED':
            return 'This deployment has no OAuth credentials for that provider.';
         case 'INTEGRATIONS_NOT_CONFIGURED':
            return 'Integration callback URLs are not configured on this deployment.';
         case 'FORBIDDEN':
            return 'Only an admin can connect or disconnect a provider.';
         case 'NOT_FOUND':
            return 'That provider is not connected.';
         default:
            return error.message;
      }
   }
   return 'The integration request failed.';
}
