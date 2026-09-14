import { z } from 'zod';
import { BerryApiError, apiFetch } from './api';

/**
 * Integrations: the provider catalog with this workspace's connection state
 * folded in, the connections themselves, the OAuth start and disconnect
 * calls, and the grants that say which tools an agent may reach. Settings
 * shows the catalog with Connect and Disconnect beside each provider.
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
   // A status that says what went wrong is read before the generic "not
   // connected". An expired connection is not unconnected — it worked until it
   // lapsed, and the two want different things from the reader.
   switch (provider.status) {
      case 'not_installed':
         return { label: 'Not installed', tone: 'attention' };
      case 'expired':
         return { label: 'Expired', tone: 'attention' };
      case 'revoked':
         return { label: 'Revoked', tone: 'danger' };
      case 'error':
         return { label: 'Needs attention', tone: 'danger' };
      default:
         break;
   }
   if (!provider.connected) return { label: 'Not connected', tone: 'attention' };
   switch (provider.status) {
      case 'connected':
      case undefined:
      case null:
      case '':
         return { label: 'Connected', tone: 'complete' };
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
      // The App's own flow, which comes back through the same query. Said here
      // rather than left to the fallback below: "an owner has to approve this"
      // is not a failure, and reporting it as one has somebody install it twice.
      case 'app_created':
         return { ok: true, message: `The ${providerName} App was created.` };
      case 'installed':
         return { ok: true, message: `${providerName} is installed on the account you chose.` };
      case 'install_requested':
         return {
            ok: true,
            message: 'An owner of that organisation was asked to approve the install.',
         };
      case 'install_not_permitted':
         return { ok: false, message: `Only an admin can install ${providerName} here.` };
      case 'installation_not_found':
         return { ok: false, message: `${providerName} does not know that installation.` };
      case 'installation_not_owned':
         return {
            ok: false,
            message: 'That installation already belongs to another workspace.',
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

// ---------------------------------------------------------------------------
// The GitHub App this deployment owns

export const githubAppSchema = z.object({
   appId: z.number(),
   slug: z.string(),
   name: z.string(),
   htmlUrl: z.string().nullish(),
   createdAt: z.string(),
   installUrl: z.string(),
});

export const githubInstallationSchema = z.object({
   installationId: z.number(),
   accountLogin: z.string().nullish(),
   accountType: z.string().nullish(),
});

export type GitHubApp = z.infer<typeof githubAppSchema>;
export type GitHubInstallation = z.infer<typeof githubInstallationSchema>;

export interface GitHubAppState {
   app: GitHubApp | null;
   /** The first account connected; null when none is. */
   installation: GitHubInstallation | null;
   /**
    * Every account this workspace reaches. A workspace installs the App on a
    * personal account and on its organisations at once, so "installed" is a
    * list rather than a fact.
    */
   installations: GitHubInstallation[];
   /** An organisation install an owner has not approved yet. */
   installPending: boolean;
   /**
    * Where to send someone to grant repository access, App row or not.
    *
    * A deployment can sign people in with an App whose credentials it was given
    * and store no App of its own; the slug is configured there, and this is the
    * link built from it. Null when there is no App to install at all.
    */
   installUrl: string | null;
   /** Why there is no install to offer, for the operator who can fix it. */
   installReason: string | null;
}

/**
 * Four states worth telling apart: no App, App but not installed, an install
 * an owner was asked to approve, and installed. The third is the one that would
 * otherwise read as the second and have somebody install it twice.
 */
export async function loadGitHubApp(): Promise<GitHubAppState> {
   const json: unknown = await apiFetch('/api/v1/integrations/github/app');
   const parsed = z
      .object({
         app: githubAppSchema.nullish(),
         installation: githubInstallationSchema.nullish(),
         installations: z.array(githubInstallationSchema).default([]),
         installPending: z.boolean().default(false),
         installUrl: z.string().nullish(),
         installReason: z.string().nullish(),
      })
      .safeParse(json);
   if (!parsed.success) {
      return {
         app: null,
         installation: null,
         installations: [],
         installPending: false,
         installUrl: null,
         installReason: null,
      };
   }
   return {
      app: parsed.data.app ?? null,
      installation: parsed.data.installation ?? null,
      installations: parsed.data.installations,
      installPending: parsed.data.installPending,
      installUrl: parsed.data.installUrl ?? null,
      installReason: parsed.data.installReason ?? null,
   };
}

/**
 * The manifest to post to GitHub, and where to post it.
 *
 * GitHub takes the manifest as a form POST rather than a query parameter, so
 * the caller builds and submits a form; there is nothing to redirect to.
 */
export async function startGitHubAppCreation(
   name?: string
): Promise<{ postUrl: string; manifest: unknown }> {
   const json: unknown = await apiFetch('/api/v1/integrations/github/app/manifest', {
      method: 'POST',
      body: JSON.stringify(name ? { name } : {}),
   });
   const parsed = z.object({ postUrl: z.string(), manifest: z.unknown() }).safeParse(json);
   if (!parsed.success) throw new Error('Manifest response was not recognized');
   return { postUrl: parsed.data.postUrl, manifest: parsed.data.manifest };
}

/**
 * Where to send the person to install the App on an account they own.
 *
 * The same call adds the first account and every one after it: GitHub's install
 * page is where an account is chosen, so "Add another account" is this again
 * rather than a second flow.
 */
export async function startGitHubInstall(): Promise<string> {
   const json: unknown = await apiFetch('/api/v1/integrations/github/app/install', {
      method: 'POST',
      body: '{}',
   });
   const parsed = z.object({ installUrl: z.string() }).safeParse(json);
   if (!parsed.success) throw new Error('Install response was not recognized');
   return parsed.data.installUrl;
}

/** What a login still has to settle about repository access. */
export type GitHubInstallStep =
   | 'install'
   | 'installed'
   | 'offered'
   | 'pending'
   | 'no_app'
   /** No App to install: a slug an operator has not set. Said, never silent. */
   | 'no_slug';

export interface GitHubInstallNext {
   next: GitHubInstallStep;
   /** Where to send the browser; only ever set on `install`. */
   installUrl: string | null;
   /** Why nothing was offered, when that is the answer. */
   reason: string | null;
}

/**
 * Whether this person still has to grant repository access, asked once by the
 * page that hands them on after sign-in.
 *
 * Access is granted once, at a first login. Somebody who has been asked before
 * is never sent back — including somebody who declined, which is why the answer
 * comes from the server rather than from whether an installation exists. A
 * refusal (no permission to install, no workspace yet) is not an obstacle to
 * logging in, so the caller reads it as "nothing to do".
 */
export async function nextGitHubInstallStep(): Promise<GitHubInstallNext> {
   const nothing: GitHubInstallNext = { next: 'no_app', installUrl: null, reason: null };
   try {
      const json: unknown = await apiFetch('/api/v1/integrations/github/app/repository-access', {
         method: 'POST',
         body: '{}',
      });
      const parsed = z
         .object({
            next: z.enum(['install', 'installed', 'offered', 'pending', 'no_app', 'no_slug']),
            installUrl: z.string().nullish(),
            reason: z.string().nullish(),
         })
         .safeParse(json);
      if (!parsed.success) return nothing;
      return {
         next: parsed.data.next,
         installUrl: parsed.data.installUrl ?? null,
         reason: parsed.data.reason ?? null,
      };
   } catch {
      return nothing;
   }
}

/** Forgets every account this workspace reached. */
export async function forgetGitHubInstall(): Promise<void> {
   await apiFetch('/api/v1/integrations/github/app/install', { method: 'DELETE' });
}
