import { Hono } from 'hono';
import type { FirstRunSetup } from '../auth/first-run-setup.ts';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import type { BoardRepository } from '../core/boards.ts';
import { ConnectionUnavailable, type ConnectionRepository } from '../integrations/connections.ts';
import { GitHubClient, GitHubError } from '../integrations/github.ts';
import { listRepositoriesAcrossAccounts } from '../integrations/github-repositories.ts';
import {
   AuthorizationNotPending,
   ExchangeFailed,
   exchangeGitHubCode,
   githubAuthorizeUrl,
   type GitHubOAuthOptions,
   type OAuthStateStore,
} from '../integrations/oauth.ts';
import { BUILT_IN_PROVIDER, PROVIDERS, findProvider, needsConnection } from '../integrations/providers.ts';
import {
   GitHubAppUnavailable,
   buildManifest,
   convertManifest,
   type GitHubAppRepository,
   type StoredApp,
} from '../integrations/github-app.ts';

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

/**
 * Where an install that began at sign-in comes back to.
 *
 * Not the settings page: nobody asked for settings, they asked to log in. This
 * is the one hand-off after auth, and it routes on into the workspace — so the
 * detour through GitHub ends where the login would have ended anyway.
 */
const SIGN_IN_PATH = '/onboarding';

/** An install somebody started from the settings page. */
const INSTALL_PROVIDER = 'github_install';

/**
 * An install offered by the login itself, told apart from the one above only so
 * the browser can be sent back to where it actually came from.
 */
const SIGN_IN_INSTALL_PROVIDER = 'github_install_signin';

/**
 * A redirect the app shell can still stamp its headers onto.
 *
 * `Response.redirect()` returns a response whose headers are immutable, and the
 * shell sets the security headers and the request id on every finished
 * response — so a redirect built that way throws `TypeError: immutable` and the
 * browser is told 500 instead of where to go. Every callback here ends in a
 * redirect, so every one of them has to be built like this.
 */
function redirectTo(location: string): Response {
   return new Response(null, { status: 302, headers: { location } });
}

export interface IntegrationsOptions {
   sessions: SessionService;
   boards: BoardRepository;
   /** Null without an encryption key: nothing can be sealed, so nothing connects. */
   connections: ConnectionRepository | null;
   states: OAuthStateStore | null;
   /** OAuth credentials per provider. Absent means "Connect cannot work here". */
   github: GitHubOAuthOptions | null;
   /**
    * The App this deployment created for itself, when it has one.
    *
    * Preferred over `github` above: an App's credentials are stored rather than
    * configured, and its installation tokens do not expire out from under an
    * unattended run.
    */
   githubApp: GitHubAppRepository | null;
   /** This deployment's own origin, which the provider redirects back to. */
   publicUrl: string | null;
   /** Where to send the browser after the callback. Defaults to the API's own origin. */
   appUrl?: string | null;
   /**
    * The one-time way in for a deployment nobody can sign into yet.
    *
    * Sign-in runs on the App, and the App is created by a signed-in user, so on
    * a fresh deployment neither can happen first. Null on a deployment that
    * cannot hold an App at all.
    */
   firstRunSetup?: FirstRunSetup | null;
}

/** Where the setup token is presented. A header, so it is never in a URL. */
const SETUP_TOKEN_HEADER = 'x-berry-setup-token';

export function integrationMounts(options: IntegrationsOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();

   // The callback is mounted before the session middleware: the browser
   // arrives from GitHub, and whether this is a session Berry knows is
   // answered by the state row rather than by a cookie that a cross-site
   // redirect may not carry.
   route.get('/callback/:provider', (context) => handleCallback(context, options));

   // Both App callbacks arrive from GitHub in a browser, so they sit beside the
   // OAuth one, before the session middleware, and are authorised by their
   // state row rather than by a cookie a cross-site redirect may not carry.
   route.get('/github/app/callback', (context) => handleAppCallback(context, options));
   route.get('/github/installation/callback', (context) =>
      handleInstallationCallback(context, options)
   );

   /**
    * First-run setup, which is the only route in Berry a session is not the
    * authority for — and only while there is nothing to have a session in.
    *
    * Registered before the session middleware, and it hands the request on
    * untouched when no token is presented: without one this is the ordinary
    * admin route below, 401 and all.
    */
   route.post('/github/app/manifest', async (context, next) => {
      const presented = context.req.header(SETUP_TOKEN_HEADER);
      if (!presented) return next();
      if (!options.firstRunSetup || !(await options.firstRunSetup.claim(presented))) {
         // One answer for a wrong token and for a path that has closed. Telling
         // them apart would say whether a deployment is still unclaimed, which
         // is the one fact worth probing for here.
         throw new ApiError(
            403,
            'SETUP_UNAVAILABLE',
            'First-run setup is not available on this deployment.'
         );
      }
      if (!options.githubApp || !options.states) {
         throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'This deployment cannot store an App.');
      }
      return json(await manifestOffer(context, options, { workspaceId: null, userId: null }));
   });

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

      // GitHub's state is the App's, and only the App's. A deployment that can
      // hold an App has no other GitHub path, so a leftover user connection
      // must not colour the card — reporting a credential as expired next to
      // no way to renew it describes a product that does not exist.
      const app = options.githubApp ? await options.githubApp.app() : null;
      const installation = app ? await options.githubApp!.installation(workspaceId) : null;

      return json({
         providers: PROVIDERS.map((provider) => {
            const connection = byProvider.get(provider.id);
            const viaApp = provider.id === 'github' && options.githubApp !== null;
            return {
               id: provider.id,
               name: provider.name,
               description: provider.description,
               // Berry's own is always available; the rest need both a
               // credential on the deployment and a key to seal it with.
               configured:
                  viaApp || !needsConnection(provider.id) || configuredFor(provider.id, options),
               connected: viaApp
                  ? installation !== null
                  : !needsConnection(provider.id) || connection?.status === 'connected',
               // No App yet is not a broken connection, it is a setup nobody
               // has done: null, so the card says "Not connected" and the
               // panel below it says what to press.
               status: viaApp
                  ? app === null
                     ? null
                     : installation
                       ? 'connected'
                       : 'not_installed'
                  : (connection?.status ?? null),
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

   /**
    * The App this deployment owns and where this workspace installed it.
    *
    * Three states the settings page has to tell apart: no App yet, an App that
    * this workspace has not installed, and installed — each with a different
    * next action.
    */
   route.get('/github/app', async (context) => {
      const workspaceId = await requireWorkspace(context, options, 'product.read');
      if (!options.githubApp) {
         return json({ app: null, installation: null, installPending: false });
      }
      const app = await options.githubApp.app();
      const installations = app ? await options.githubApp.installations(workspaceId) : [];
      // The first account answers the old singular field, which the surfaces
      // that only ask "is GitHub connected" still read. `installations` is the
      // whole answer: a workspace reaches a personal account and its
      // organisations at once, and "Add another account" appends to this list.
      const installation = installations[0] ?? null;
      // A fourth state, and the one a settings page would otherwise have to
      // describe as a failure: an organisation install an owner has not
      // approved yet. Nothing is installed, and nobody need do anything but
      // wait — which is only sayable because the request was recorded.
      const installPending =
         app !== null && installation === null
            ? await options.githubApp.installPending(workspaceId)
            : false;
      return json({
         installPending,
         installations: installations.map((row) => ({
            installationId: row.installationId,
            accountLogin: row.accountLogin,
            accountType: row.accountType,
         })),
         app: app && {
            appId: app.appId,
            slug: app.slug,
            name: app.name,
            htmlUrl: app.htmlUrl,
            createdAt: app.createdAt,
            installUrl: `https://github.com/apps/${app.slug}/installations/new`,
         },
         installation: installation && {
            installationId: installation.installationId,
            accountLogin: installation.accountLogin,
            accountType: installation.accountType,
         },
      });
   });

   /**
    * What the browser posts to GitHub to create the App.
    *
    * Returned rather than redirected to: GitHub's manifest endpoint takes a
    * form POST, so the page has to submit it. The state is carried in the query
    * of the POST target and comes back on the redirect.
    */
   route.post('/github/app/manifest', async (context) => {
      const workspaceId = await requireWorkspace(context, options, 'settings.write');
      if (!options.githubApp || !options.states) {
         throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'This deployment cannot store an App.');
      }
      return json(
         await manifestOffer(context, options, { workspaceId, userId: context.get('user').id })
      );
   });

   /**
    * Where to send someone to install the App on an account they own.
    *
    * A state is minted here rather than relying on GitHub's own redirect,
    * because the installation has to be recorded against *this* workspace and
    * the setup URL is the same for every one of them.
    */
   route.post('/github/app/install', async (context) => {
      const workspaceId = await requireWorkspace(context, options, 'settings.write');
      if (!options.githubApp || !options.states) {
         throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'This deployment cannot store an App.');
      }
      const app = await options.githubApp.app();
      if (!app) {
         throw new ApiError(409, 'GITHUB_APP_MISSING', 'Create the GitHub App first.');
      }
      return json({
         installUrl: await startInstall(options, {
            app,
            workspaceId,
            userId: context.get('user').id,
            provider: INSTALL_PROVIDER,
         }),
      });
   });

   /**
    * What this person still has to do about repository access, asked once per
    * login by the page that hands them on after auth.
    *
    * The promise is that access is granted once, at a first login: whoever has
    * no installation Berry knows of is sent to GitHub to choose an account and
    * its repositories, and every login after that only identifies them. What
    * makes the second login quiet is the offer row this writes — not a guess,
    * because somebody who skipped the install and somebody who has never been
    * asked look identical from the installation table alone.
    *
    * `settings.write`, like every other install route: choosing which
    * repositories a whole workspace's agents may reach is an admin act. An
    * ordinary member is refused here, and the page that asked simply lets them
    * in — being unable to install is not being unable to log in.
    */
   route.post('/github/app/repository-access', async (context) => {
      const workspaceId = await requireWorkspace(context, options, 'settings.write');
      const nothingToDo = json({ next: 'no_app', installUrl: null });
      if (!options.githubApp || !options.states) return nothingToDo;
      const app = await options.githubApp.app();
      if (!app) return nothingToDo;

      if (await options.githubApp.installation(workspaceId)) {
         return json({ next: 'installed', installUrl: null });
      }
      const userId = context.get('user').id;
      const offered = await options.githubApp.installOffer(workspaceId, userId);
      // Asked already: they either declined GitHub's form or are waiting on an
      // owner. Either way they are not sent back, which is what keeps a login
      // from becoming a loop.
      if (offered) return json({ next: offered.status, installUrl: null });

      return json({
         next: 'install',
         installUrl: await startInstall(options, {
            app,
            workspaceId,
            userId,
            provider: SIGN_IN_INSTALL_PROVIDER,
         }),
      });
   });

   /** Forgets where this workspace installed the App; the App itself stays. */
   route.delete('/github/app/install', async (context) => {
      const workspaceId = await requireWorkspace(context, options, 'settings.write');
      if (options.githubApp) await options.githubApp.removeInstallation(workspaceId);
      return json({ ok: true });
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

      // Merged across the workspace's accounts: a personal account and an
      // organisation are both ordinary, and a listing that used one token would
      // show whichever account happened to be first and hide the rest.
      let listing: Awaited<ReturnType<typeof listRepositoriesAcrossAccounts>>;
      try {
         listing = await listRepositoriesAcrossAccounts(workspaceId, {
            githubApp: options.githubApp,
            connections: options.connections,
         });
      } catch (error) {
         if (error instanceof GitHubAppUnavailable) {
            throw new ApiError(
               409,
               error.reason === 'not_installed' ? 'NOT_CONNECTED' : 'CONNECTION_UNUSABLE',
               error.reason === 'not_installed'
                  ? 'The GitHub App is not installed for this workspace.'
                  : `The GitHub App needs attention: ${error.message}.`
            );
         }
         if (error instanceof ConnectionUnavailable) {
            throw new ApiError(
               409,
               error.reason === 'missing' ? 'NOT_CONNECTED' : 'CONNECTION_UNUSABLE',
               error.reason === 'missing'
                  ? 'GitHub is not connected to this workspace.'
                  : `The GitHub connection needs attention: ${error.message}.`
            );
         }
         if (error instanceof GitHubError) {
            throw new ApiError(502, 'PROVIDER_ERROR', `GitHub refused the request: ${error.message}`);
         }
         throw error;
      }

      const repositories = listing.repositories;
      const accounts = [...new Set(listing.accounts.map((account) => account.accountLogin))].filter(
         (login) => login !== ''
      );
      const viaApp = listing.kind === 'installation';
      // A run clones, commits and pushes, so `contents: write` is the grant
      // that decides whether linking a repository leads anywhere. It is asked
      // of the installation because the per-repository `permissions` object is
      // not meaningful for an installation token. Reported so the UI can say a
      // read-only App is read-only, instead of accepting the link and failing
      // at the push after the work is already done.
      const granted = viaApp ? await options.githubApp?.grantedPermissions(workspaceId) : null;
      return json({
         repositories,
         access: {
            canPush: viaApp ? granted?.contents === 'write' : true,
            // An installation sees only what it was granted; a classic OAuth
            // token sees everything the person can. Saying which is what lets
            // an empty picker be read as "grant more repositories" rather than
            // as a broken list.
            selectedOnly: viaApp,
            installed: viaApp,
            manageUrl: viaApp
               ? 'https://github.com/settings/installations'
               : 'https://github.com/settings/applications',
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
      redirectTo(
         new URL(
            `${SETTINGS_PATH}?integration=${encodeURIComponent(providerId)}&status=${encodeURIComponent(status)}`,
            options.appUrl || options.publicUrl || url.origin
         ).toString()
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
   // A connection belongs to a workspace and records who made it. Only the
   // first-run App setup starts a state without either, and it is not this flow.
   if (pending.workspaceId === null || pending.userId === null) return back('invalid_state');

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
 * The manifest to post and the state that will come back with it.
 *
 * Shared by the two ways in, because they differ in exactly one thing — who the
 * state belongs to. Everything GitHub is told, and every URL it will redirect
 * to, is the same whether an admin pressed the button or the first person ever
 * to open the deployment did.
 */
/**
 * Mints the state an install is recognised by and says where to send someone.
 *
 * The offer is recorded before the browser leaves rather than when it comes
 * back, because the case that matters is the one where it never comes back:
 * somebody who closes GitHub's tab has still been asked, and asking them again
 * on every login is the loop this avoids.
 */
async function startInstall(
   options: IntegrationsOptions,
   input: { app: StoredApp; workspaceId: string; userId: string; provider: string }
): Promise<string> {
   const installPath = `https://github.com/apps/${encodeURIComponent(input.app.slug)}/installations/new`;
   const pending = await options.states!.start({
      workspaceId: input.workspaceId,
      userId: input.userId,
      provider: input.provider,
      redirectUri: installPath,
      scopes: [],
   });
   await options.githubApp!.offerInstall(input.workspaceId, input.userId);
   return `${installPath}?state=${encodeURIComponent(pending.state)}`;
}

async function manifestOffer(
   context: { req: { url: string; json(): Promise<unknown> } },
   options: IntegrationsOptions,
   actor: { workspaceId: string | null; userId: string | null }
): Promise<{ postUrl: string; organizationPostPath: string; manifest: Record<string, unknown> }> {
   const url = new URL(context.req.url);
   const apiOrigin = options.publicUrl || url.origin;
   const appOrigin = options.appUrl || apiOrigin;
   const pending = await options.states!.start({
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      provider: 'github_app',
      redirectUri: new URL('/api/v1/integrations/github/app/callback', apiOrigin).toString(),
      scopes: [],
   });
   const body = (await context.req.json().catch(() => ({}))) as Record<string, unknown>;
   const requested = typeof body.name === 'string' ? body.name.trim() : '';
   return {
      postUrl: `https://github.com/settings/apps/new?state=${encodeURIComponent(pending.state)}`,
      organizationPostPath: '/organizations/{org}/settings/apps/new',
      manifest: buildManifest({ name: requested || 'Berry', appOrigin, apiOrigin }),
   };
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

/**
 * GitHub returns here once someone presses Create on the manifest form.
 *
 * The code is single-use and short-lived, and the conversion is the only
 * moment GitHub ever discloses the private key — so a failure means creating
 * the App again rather than retrying this URL.
 */
async function handleAppCallback(
   context: { req: { url: string } },
   options: IntegrationsOptions
): Promise<Response> {
   const url = new URL(context.req.url);
   const back = (status: string): Response =>
      redirectTo(
         new URL(
            `${SETTINGS_PATH}?integration=github&status=${encodeURIComponent(status)}`,
            options.appUrl || options.publicUrl || url.origin
         ).toString()
      );

   const code = url.searchParams.get('code') ?? '';
   const state = url.searchParams.get('state') ?? '';
   if (code === '' || state === '') return back('invalid_response');
   if (!options.githubApp || !options.states) return back('exchange_failed');

   let pending: Awaited<ReturnType<OAuthStateStore['consume']>>;
   try {
      pending = await options.states.consume(state);
   } catch (error) {
      if (error instanceof AuthorizationNotPending) return back('invalid_state');
      throw error;
   }
   if (pending.provider !== 'github_app') return back('invalid_state');

   try {
      const converted = await convertManifest(code);
      // A null actor is the first-run setup: the App is being created by
      // somebody who does not have an account yet, because this is the App they
      // will sign in with.
      await options.githubApp.saveApp(converted, pending.userId);
      return back('app_created');
   } catch (error) {
      if (error instanceof GitHubAppUnavailable) return back('exchange_failed');
      throw error;
   }
}

/**
 * GitHub returns here after the App is installed on an account.
 *
 * Two things arrive rather than one. `setup_action=request` means the person
 * could not install it themselves and asked an owner to: there is no
 * installation, and the request is recorded so the product can say it is
 * pending instead of reporting a failure or pretending it worked. Otherwise an
 * installation id arrives, and what follows is the checking of it.
 */
async function handleInstallationCallback(
   context: { req: { url: string } },
   options: IntegrationsOptions
): Promise<Response> {
   const url = new URL(context.req.url);
   // Where the browser came from, filled in once the state says. Until then the
   // settings page: an install nobody can attribute was not a login's.
   let landing = SETTINGS_PATH;
   const back = (status: string): Response =>
      redirectTo(
         new URL(
            `${landing}?integration=github&status=${encodeURIComponent(status)}`,
            options.appUrl || options.publicUrl || url.origin
         ).toString()
      );

   const requested = url.searchParams.get('setup_action') === 'request';
   const installationId = Number(url.searchParams.get('installation_id') ?? '');
   const state = url.searchParams.get('state') ?? '';
   if (!options.githubApp || !options.states) return back('exchange_failed');
   // Without a state there is nobody to record anything against — not the
   // installation, and not the request for one either.
   if (state === '') return back(requested ? 'install_requested' : 'invalid_state');

   let pending: Awaited<ReturnType<OAuthStateStore['consume']>>;
   try {
      pending = await options.states.consume(state);
   } catch (error) {
      if (error instanceof AuthorizationNotPending) return back('invalid_state');
      throw error;
   }
   if (pending.provider !== INSTALL_PROVIDER && pending.provider !== SIGN_IN_INSTALL_PROVIDER) {
      return back('invalid_state');
   }
   if (pending.provider === SIGN_IN_INSTALL_PROVIDER) landing = SIGN_IN_PATH;
   // An installation is recorded against a workspace and a person, so a state
   // naming neither cannot be the one that installed it.
   if (pending.workspaceId === null || pending.userId === null) return back('invalid_state');

   // The row says which workspace, but what the person may do in it is asked
   // again here rather than taken from when the state was minted. A row is the
   // only authorisation this route has: read without this check, one written for
   // a workspace somebody has since left — or was never in — would install the
   // App there on their behalf.
   const permitted = await options.boards
      .authorizeWorkspace(pending.userId, pending.workspaceId, 'settings.write')
      .then(() => true)
      .catch((error: unknown) => {
         if (error instanceof NotFound || error instanceof Forbidden) return false;
         throw error;
      });
   if (!permitted) return back('install_not_permitted');

   if (requested) {
      await options.githubApp.recordInstallRequested(pending.workspaceId, pending.userId);
      return back('install_requested');
   }
   if (!Number.isFinite(installationId) || installationId <= 0) return back('invalid_response');

   // The id came out of a query parameter the person could have edited, so it
   // is checked against GitHub before it is believed, and refused if another
   // workspace already mints tokens against it. Without both, a member of one
   // workspace could aim it at another account's installation and get a token
   // for repositories they were never given.
   let account: { accountLogin: string | null; accountType: string | null };
   try {
      account = await options.githubApp.describeInstallation(installationId);
   } catch (error) {
      if (error instanceof GitHubAppUnavailable) return back('installation_not_found');
      throw error;
   }

   const claimed = await options.githubApp.claimedBy(installationId);
   if (claimed !== null && claimed !== pending.workspaceId) {
      return back('installation_not_owned');
   }

   await options.githubApp.saveInstallation(
      {
         workspaceId: pending.workspaceId,
         installationId,
         accountLogin: account.accountLogin,
         accountType: account.accountType,
      },
      pending.userId
   );
   return back('installed');
}

/**
 * The credential GitHub work runs on, App first.
 *
 * An installation token is preferred because it is minted on demand and cannot
 * lapse between one run and the next. The user connection remains the fallback
 * for a deployment still on the older flow — and only when there is no App at
 * all, so a half-finished App setup does not silently send work through
 * somebody's personal token.
 */
export async function githubCredential(
   workspaceId: string,
   options: Pick<IntegrationsOptions, 'connections' | 'githubApp'>,
   /**
    * The account holding the repository this credential is for, when the caller
    * knows it. A workspace reaches several accounts at once and each
    * installation sees only its own, so without it the first account's token is
    * minted — which cannot see an organisation's repository at all.
    */
   owner?: string | null
): Promise<{ token: string; kind: 'installation' | 'user' }> {
   if (options.githubApp && (await options.githubApp.app())) {
      return { token: await options.githubApp.token(workspaceId, owner), kind: 'installation' };
   }
   if (!options.connections) {
      throw new GitHubAppUnavailable('this deployment has no GitHub App', 'no_app');
   }
   return { token: await options.connections.token(workspaceId, 'github'), kind: 'user' };
}

export async function githubToken(
   workspaceId: string,
   options: Pick<IntegrationsOptions, 'connections' | 'githubApp'>,
   owner?: string | null
): Promise<string> {
   if (options.githubApp && (await options.githubApp.app())) {
      return options.githubApp.token(workspaceId, owner);
   }
   if (!options.connections) {
      throw new GitHubAppUnavailable('this deployment has no GitHub App', 'no_app');
   }
   return options.connections.token(workspaceId, 'github');
}
