import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import type { BoardRepository } from '../core/boards.ts';
import { ConnectionUnavailable, type ConnectionRepository } from '../integrations/connections.ts';
import { GitHubClient, GitHubError } from '../integrations/github.ts';
import {
   AuthorizationNotPending,
   ExchangeFailed,
   exchangeGitHubCode,
   githubAuthorizeUrl,
   type GitHubOAuthOptions,
   type OAuthStateStore,
} from '../integrations/oauth.ts';
import { BUILT_IN_PROVIDER, PROVIDERS, findProvider, needsConnection } from '../integrations/providers.ts';

/**
 * `/api/v1/integrations`.
 *
 * What a workspace can reach outside itself, and the OAuth handshake that
 * lets it. Everything an agent does against GitHub — the checkout, the
 * branch, the pull request — depends on a connection existing, and until this
 * mount there was no way to make one from the product.
 *
 * Two rules run through the whole file:
 *
 *   - **No response ever carries a credential.** The connection resource has
 *     no field that could hold one, and the OAuth code lands here rather than
 *     in a page, so a token never reaches a browser even in transit.
 *   - **Connecting is an admin act.** A connection is workspace-wide: it
 *     decides what every agent in the workspace can reach, so it needs
 *     `settings.write` rather than the `product.write` an ordinary member has.
 */

/** Where the browser is sent back to after the provider is done with it. */
const SETTINGS_PATH = '/settings/integrations';

export interface IntegrationsOptions {
   sessions: SessionService;
   boards: BoardRepository;
   /** Null without an encryption key: nothing can be sealed, so nothing connects. */
   connections: ConnectionRepository | null;
   states: OAuthStateStore | null;
   /** OAuth credentials per provider. Absent means "Connect cannot work here". */
   github: GitHubOAuthOptions | null;
   /** This deployment's own origin, which the provider redirects back to. */
   publicUrl: string | null;
   /** Where to send the browser after the callback. Defaults to the API's own origin. */
   appUrl?: string | null;
}

export function integrationMounts(options: IntegrationsOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();

   // The callback is mounted before the session middleware: the browser
   // arrives from GitHub, and whether this is a session Berry knows is
   // answered by the state row rather than by a cookie that a cross-site
   // redirect may not carry.
   route.get('/callback/:provider', (context) => handleCallback(context, options));

   route.use('*', requireSession(options.sessions));

   /**
    * The catalogue, with this workspace's connection state folded in.
    *
    * One read rather than a list of providers plus a list of connections,
    * because every caller wants them joined and joining them in three places
    * is how two of them end up disagreeing.
    */
   route.get('/providers', async (context) => {
      const workspaceId = await requireWorkspace(context, options, 'product.read');
      const connections = options.connections
         ? await options.connections.list(workspaceId)
         : [];
      const byProvider = new Map(connections.map((connection) => [connection.provider, connection]));

      return json({
         providers: PROVIDERS.map((provider) => {
            const connection = byProvider.get(provider.id);
            return {
               id: provider.id,
               name: provider.name,
               description: provider.description,
               // Berry's own is always available; the rest need both a
               // credential on the deployment and a key to seal it with.
               configured: !needsConnection(provider.id) || configuredFor(provider.id, options),
               connected: !needsConnection(provider.id) || connection?.status === 'connected',
               status: connection?.status ?? null,
               accountName: connection?.externalAccountName ?? null,
               scopes: connection?.scopes ?? provider.scopes,
               tools: provider.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  effect: tool.effect,
                  requiresApproval: tool.requiresApproval,
                  enabledByDefault: tool.enabledByDefault,
               })),
            };
         }),
      });
   });

   route.get('/connections', async (context) => {
      const workspaceId = await requireWorkspace(context, options, 'product.read');
      const connections = options.connections ? await options.connections.list(workspaceId) : [];
      return json({
         connections: connections.map((connection) => ({
            id: connection.id,
            provider: connection.provider,
            status: connection.status,
            statusDetail: connection.statusDetail,
            accountId: connection.externalAccountId,
            accountName: connection.externalAccountName,
            scopes: connection.scopes,
            expiresAt: connection.expiresAt,
            createdAt: connection.createdAt,
            updatedAt: connection.updatedAt,
         })),
      });
   });

   /**
    * Starts the handshake and says where to send the browser.
    *
    * The redirect is returned rather than performed, because the caller is a
    * page doing `fetch` — a 302 here would be followed by the fetch and land
    * GitHub's HTML in a JSON parser.
    */
   route.post('/connections/:provider/authorize', async (context) => {
      const workspaceId = await requireWorkspace(context, options, 'settings.write');
      const provider = requireProvider(context.req.param('provider'));

      if (!needsConnection(provider.id)) {
         throw new ApiError(409, 'CONFLICT', 'Berry needs no connection to itself.');
      }
      if (!options.connections || !options.states) {
         throw new ApiError(
            503,
            'INTEGRATIONS_NOT_CONFIGURED',
            'This deployment has no encryption key, so it cannot hold a credential.'
         );
      }
      const credentials = credentialsFor(provider.id, options);
      if (!credentials || !options.publicUrl) {
         throw new ApiError(
            503,
            'PROVIDER_NOT_CONFIGURED',
            `This deployment has no OAuth credentials for ${provider.name}.`
         );
      }

      const redirectUri = new URL(
         `/api/v1/integrations/callback/${provider.id}`,
         options.publicUrl
      ).toString();
      const pending = await options.states.start({
         workspaceId,
         userId: context.get('user').id,
         provider: provider.id,
         redirectUri,
         scopes: provider.scopes,
      });
      // Opportunistic, and after the row that matters is written: a sweep that
      // fails must not cost someone their sign-in.
      void options.states.sweep().catch(() => undefined);

      return json({ authorizeUrl: githubAuthorizeUrl(credentials, pending) });
   });

   route.delete('/connections/:provider', async (context) => {
      const workspaceId = await requireWorkspace(context, options, 'settings.write');
      const provider = requireProvider(context.req.param('provider'));
      if (!options.connections) throw ApiError.notFound('Connection');

      const removed = await options.connections.disconnect(workspaceId, provider.id);
      if (!removed) throw ApiError.notFound('Connection');
      return new Response(null, { status: 204 });
   });

   /**
    * Which tools each agent may reach.
    *
    * Empty is not "everything": a workspace with no rows recorded grants
    * whatever each provider marks `enabledByDefault`, and the tool that can
    * merge without a review is not among them.
    */
   route.get('/grants', async (context) => {
      const workspaceId = await requireWorkspace(context, options, 'product.read');
      const grants = options.connections ? await listGrants(options, workspaceId) : [];
      return json({ grants });
   });

   /**
    * The repository picker.
    *
    * `access` says why the list is what it is, so an empty picker can be told
    * apart from a picker that could not load — the fixes are opposite, and a
    * spinner that ends in nothing teaches nobody which one happened.
    */
   route.get('/github/repositories', async (context) => {
      const workspaceId = await requireWorkspace(context, options, 'product.read');
      if (!options.connections) {
         throw new ApiError(
            503,
            'INTEGRATIONS_NOT_CONFIGURED',
            'This deployment has no encryption key, so it cannot hold a credential.'
         );
      }

      let token: string;
      try {
         token = await options.connections.token(workspaceId, 'github');
      } catch (error) {
         if (error instanceof ConnectionUnavailable) {
            throw new ApiError(
               409,
               error.reason === 'missing' ? 'NOT_CONNECTED' : 'CONNECTION_UNUSABLE',
               error.reason === 'missing'
                  ? 'GitHub is not connected to this workspace.'
                  : `The GitHub connection needs attention: ${error.message}.`
            );
         }
         throw error;
      }

      const client = new GitHubClient({ token });
      const repositories = await client.listRepositories().catch((error: unknown) => {
         if (error instanceof GitHubError) {
            throw new ApiError(502, 'PROVIDER_ERROR', `GitHub refused the request: ${error.message}`);
         }
         throw error;
      });

      const accounts = [...new Set(repositories.map((repository) => repository.fullName.split('/')[0]!))];
      return json({
         repositories,
         access: {
            // A classic OAuth token sees everything the person can; only a
            // GitHub App installation is narrowed to selected repositories.
            selectedOnly: false,
            installed: true,
            manageUrl: 'https://github.com/settings/applications',
            accounts,
         },
      });
   });

   return [{ prefix: '/api/v1/integrations', handler: route }];
}

// ------------------------------------------------------------------ callback

/**
 * Where the provider sends the person back.
 *
 * Always a redirect to the settings page, never a JSON body: whatever
 * happened, the thing on the other end of this request is a browser window a
 * person is looking at. `?status=` carries the outcome and the page words it.
 *
 * No session is required. The state row is the authorisation — it names the
 * workspace and the person who started the flow, it can be used once, and it
 * expires. A cookie would be the weaker check here, because a cross-site
 * redirect may not carry one at all.
 */
async function handleCallback(
   context: { req: { url: string; param: (key: string) => string | undefined } },
   options: IntegrationsOptions
): Promise<Response> {
   const providerId = context.req.param('provider') ?? '';
   const url = new URL(context.req.url);
   const back = (status: string): Response =>
      Response.redirect(
         new URL(
            `${SETTINGS_PATH}?integration=${encodeURIComponent(providerId)}&status=${encodeURIComponent(status)}`,
            options.appUrl || options.publicUrl || url.origin
         ).toString(),
         302
      );

   // The person pressed Cancel on the provider's own page.
   if (url.searchParams.get('error') === 'access_denied') return back('denied');

   const code = url.searchParams.get('code') ?? '';
   const state = url.searchParams.get('state') ?? '';
   if (code === '' || state === '') return back('invalid_response');
   if (!options.connections || !options.states) return back('exchange_failed');

   let pending: Awaited<ReturnType<OAuthStateStore['consume']>>;
   try {
      pending = await options.states.consume(state);
   } catch (error) {
      // Expired and never-started look the same from here, and telling them
      // apart would mean saying whether a state was ever real.
      if (error instanceof AuthorizationNotPending) return back('invalid_state');
      throw error;
   }
   if (pending.provider !== providerId) return back('invalid_state');

   const credentials = credentialsFor(providerId, options);
   if (!credentials) return back('exchange_failed');

   try {
      const exchanged = await exchangeGitHubCode(credentials, {
         code,
         redirectUri: pending.redirectUri,
      });
      await options.connections.save({
         workspaceId: pending.workspaceId,
         provider: providerId,
         connectedByUserId: pending.userId,
         accessToken: exchanged.accessToken,
         refreshToken: exchanged.refreshToken,
         expiresAt: exchanged.expiresAt,
         // What the provider actually granted, not what was asked for.
         scopes: exchanged.scopes.length > 0 ? exchanged.scopes : pending.scopes,
         externalAccountId: exchanged.accountId,
         externalAccountName: exchanged.accountName,
      });
      return back('connected');
   } catch (error) {
      if (error instanceof ExchangeFailed) return back(error.outcome);
      throw error;
   }
}

// ------------------------------------------------------------------- helpers

function configuredFor(providerId: string, options: IntegrationsOptions): boolean {
   return credentialsFor(providerId, options) !== null && options.connections !== null;
}

function credentialsFor(providerId: string, options: IntegrationsOptions): GitHubOAuthOptions | null {
   return providerId === 'github' ? options.github : null;
}

function requireProvider(id: string | undefined) {
   const provider = id ? findProvider(id) : undefined;
   if (!provider) throw ApiError.notFound('Provider');
   return provider;
}

/**
 * The caller's current workspace, and whether they may do this in it.
 *
 * Integrations are workspace-wide rather than addressed by id in the path, so
 * the workspace comes from the session — the same one every other settings
 * page is looking at.
 */
async function requireWorkspace(
   context: { get: (key: 'user') => { id: string; currentWorkspaceId?: string | null } },
   options: IntegrationsOptions,
   permission: 'product.read' | 'settings.write'
): Promise<string> {
   const user = context.get('user');
   const workspaceId = user.currentWorkspaceId;
   if (!workspaceId) throw ApiError.notFound('Workspace');
   await options.boards.authorizeWorkspace(user.id, workspaceId, permission).catch((error: unknown) => {
      if (error instanceof NotFound) throw ApiError.notFound('Workspace');
      if (error instanceof Forbidden) {
         throw new ApiError(403, 'FORBIDDEN', 'Only an admin can connect or disconnect a provider.');
      }
      throw error;
   });
   return workspaceId;
}

/**
 * Recorded grants, with each provider's defaults filled in behind them.
 *
 * A workspace that has never opened this page has no rows, and reading that
 * as "nothing is allowed" would break every agent. It means "the defaults",
 * and the defaults deliberately exclude merging without a review.
 */
async function listGrants(
   options: IntegrationsOptions,
   workspaceId: string
): Promise<Array<{ agentId: string | null; provider: string; tool: string; maxEffect: string }>> {
   const recorded = await options.connections!.grants(workspaceId);
   const seen = new Set(recorded.map((grant) => `${grant.agentId ?? ''}:${grant.tool}`));
   const defaults = PROVIDERS.flatMap((provider) =>
      provider.tools
         .filter((tool) => tool.enabledByDefault)
         .map((tool) => ({
            agentId: null,
            provider: provider.id,
            tool: tool.name,
            maxEffect: tool.effect,
         }))
   ).filter((grant) => !seen.has(`:${grant.tool}`));
   return [...recorded, ...defaults];
}

export { BUILT_IN_PROVIDER };
