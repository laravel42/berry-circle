import { Hono } from 'hono';
import { z } from 'zod';
import type { SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { decodeTimeCursor, encodeCursor, parsePageQuery } from '../http/cursor.ts';
import { ApiError } from '../http/errors.ts';
import { readJson } from '../http/json-body.ts';
import type { Mount } from '../http/registry.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import { allows, type Permission } from '../identity/roles.ts';
import type { ScopedDb } from '../identity/workspace-context.ts';
import { InvalidPluginInput, PluginAlreadyInstalled, PluginUnreachable } from '../plugins/errors.ts';
import { loadPackage, type PackageSource } from '../plugins/loader.ts';
import { describePackage } from '../plugins/manifest.ts';
import type { PluginNetwork } from '../plugins/net.ts';
import type { PluginInstallation, PluginRepository } from '../plugins/repository.ts';
import type { PluginRuntimeStore } from '../plugins/runtime-store.ts';
import { mountWorkspaceScope, pathId, type ScopedVariables } from './shared.ts';

/**
 * `/api/v1/plugins/:workspaceId/*` — installing and running plugins.
 *
 * Its own prefix rather than a sub-route of `/api/v1/workspaces`, because the
 * registry refuses overlapping prefixes. The workspace gate is the same one
 * `workspace-reads` uses: membership before any handler runs, and the
 * permission each write needs checked inside `ScopedDb.mutate`.
 */

export const SURFACE_TOKEN_TTL_MS = 15 * 60_000;

export interface PluginMountOptions {
   sessions: SessionService;
   sql: Sql;
   /** Null without INTEGRATION_ENCRYPTION_KEY: nothing can seal a plugin's secrets. */
   plugins: PluginRepository | null;
   runtime: PluginRuntimeStore;
   network: PluginNetwork;
   /** Where a plugin reaches `/v1`. BERRY_PUBLIC_URL. */
   publicUrl: string | null;
   clock?: () => Date;
}

const sourceFields = {
   url: z.url().max(500).optional(),
   package: z.unknown().optional(),
};
const oneSource = (value: { url?: string | undefined; package?: unknown }) =>
   (value.url === undefined) !== (value.package === undefined);
const previewSchema = z.object(sourceFields).strict().refine(oneSource, 'Give either url or package.');
const installSchema = z
   .object({ ...sourceFields, config: z.record(z.string(), z.unknown()).optional() })
   .strict()
   .refine(oneSource, 'Give either url or package.');
const patchSchema = z
   .object({ enabled: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional() })
   .strict();
const secretSchema = z.object({ value: z.string().min(1).max(4096) }).strict();
const toolSchema = z.object({ approved: z.boolean() }).strict();

export function pluginMounts(options: PluginMountOptions): Mount[] {
   return [{ prefix: '/api/v1/plugins', handler: pluginRoutes(options) }];
}

function pluginRoutes(options: PluginMountOptions): Hono<{ Variables: ScopedVariables }> {
   const route = new Hono<{ Variables: ScopedVariables }>();
   mountWorkspaceScope(route, { sessions: options.sessions, sql: options.sql });
   const clock = options.clock ?? (() => new Date());
   const repo = (): PluginRepository => {
      if (!options.plugins) {
         throw new ApiError(412, 'PLUGINS_NOT_CONFIGURED', 'Plugins need INTEGRATION_ENCRYPTION_KEY to hold their secrets.');
      }
      return options.plugins;
   };
   const id = (raw: string | undefined) => pathId(raw, 'Plugin');

   route.post('/:workspaceId/preview', async (context) => {
      requirePermission(context.get('scoped'), 'settings.write');
      const body = await readJson(context, previewSchema, 2_000_000);
      const loaded = await loadPackage(options.network, toSource(body)).catch(mapPluginError);
      return json(describePackage(loaded.pkg));
   });

   route.get('/:workspaceId/installations', async (context) => {
      const found = await repo().list(context.get('scoped').ctx.workspaceId);
      return json({ nodes: found.map(serializeInstallation) });
   });

   route.post('/:workspaceId/installations', async (context) => {
      const scoped = context.get('scoped');
      requirePermission(scoped, 'settings.write');
      const body = await readJson(context, installSchema, 2_000_000);
      const loaded = await loadPackage(options.network, toSource(body)).catch(mapPluginError);
      const { installation, signingSecret } = await scoped
         .mutate('settings.write', (tx, ctx) =>
            repo().install(tx, {
               workspaceId: ctx.workspaceId,
               installedBy: ctx.userId,
               pkg: loaded.pkg,
               source: loaded.source,
               sourceUrl: loaded.sourceUrl,
               config: body.config ?? {},
            })
         )
         .catch(mapPluginError);
      const response = json({ installation: serializeInstallation(installation), signingSecret }, 201);
      response.headers.set('Cache-Control', 'no-store');
      return response;
   });

   route.get('/:workspaceId/installations/:id', async (context) => {
      const workspaceId = context.get('scoped').ctx.workspaceId;
      const installationId = id(context.req.param('id'));
      const installation = await repo().get(workspaceId, installationId).catch(mapPluginError);
      const files = await repo().files(workspaceId, installationId);
      return json({ ...serializeInstallation(installation), files });
   });

   route.patch('/:workspaceId/installations/:id', async (context) => {
      const scoped = context.get('scoped');
      const installationId = id(context.req.param('id'));
      const body = await readJson(context, patchSchema);
      const updated = await scoped
         .mutate('settings.write', (tx, ctx) =>
            repo().update(tx, ctx.workspaceId, installationId, {
               ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
               ...(body.config !== undefined ? { config: body.config } : {}),
            })
         , { table: 'plugin_installations', id: installationId })
         .catch(mapPluginError);
      return json(serializeInstallation(updated));
   });

   route.delete('/:workspaceId/installations/:id', async (context) => {
      const installationId = id(context.req.param('id'));
      await context
         .get('scoped')
         .mutate('settings.write', (tx, ctx) => repo().uninstall(tx, ctx.workspaceId, installationId), { table: 'plugin_installations', id: installationId })
         .catch(mapPluginError);
      return new Response(null, { status: 204 });
   });

   route.put('/:workspaceId/installations/:id/secrets/:name', async (context) => {
      const installationId = id(context.req.param('id'));
      const name = context.req.param('name');
      const body = await readJson(context, secretSchema);
      await context
         .get('scoped')
         .mutate('settings.write', (tx, ctx) => repo().setSecret(tx, ctx.workspaceId, installationId, name, body.value), { table: 'plugin_installations', id: installationId })
         .catch(mapPluginError);
      const response = new Response(null, { status: 204 });
      response.headers.set('Cache-Control', 'no-store');
      return response;
   });

   route.delete('/:workspaceId/installations/:id/secrets/:name', async (context) => {
      const installationId = id(context.req.param('id'));
      const name = context.req.param('name');
      await context
         .get('scoped')
         .mutate('settings.write', (tx, ctx) => repo().deleteSecret(tx, ctx.workspaceId, installationId, name), { table: 'plugin_installations', id: installationId })
         .catch(mapPluginError);
      return new Response(null, { status: 204 });
   });

   route.put('/:workspaceId/installations/:id/tools/:tool', async (context) => {
      const scoped = context.get('scoped');
      const installationId = id(context.req.param('id'));
      const tool = context.req.param('tool');
      const body = await readJson(context, toolSchema);
      await scoped
         .mutate('settings.write', (tx, ctx) =>
            repo().setToolApproval(tx, ctx.workspaceId, installationId, tool, body.approved, ctx.userId)
         , { table: 'plugin_installations', id: installationId })
         .catch(mapPluginError);
      return json(serializeInstallation(await repo().get(scoped.ctx.workspaceId, installationId)));
   });

   route.get('/:workspaceId/installations/:id/storage', async (context) => {
      const scoped = context.get('scoped');
      requirePermission(scoped, 'settings.read');
      const installationId = id(context.req.param('id'));
      await repo().get(scoped.ctx.workspaceId, installationId).catch(mapPluginError);
      const { first, after } = parsePageQuery(new URL(context.req.url));
      const found = await options.runtime.listValues(installationId, {
         prefix: '',
         after: after === '' ? null : after,
         limit: first + 1,
      });
      const nodes = found.slice(0, first);
      return json({ nodes, pageInfo: { hasNextPage: found.length > first, endCursor: nodes.at(-1)?.key ?? null } });
   });

   route.get('/:workspaceId/installations/:id/invocations', async (context) => {
      const scoped = context.get('scoped');
      requirePermission(scoped, 'settings.read');
      const installationId = id(context.req.param('id'));
      await repo().get(scoped.ctx.workspaceId, installationId).catch(mapPluginError);
      const scope = `plugins.invocations.${installationId}`;
      const { first, after } = parsePageQuery(new URL(context.req.url));
      const cursor = after === '' ? null : decodeTimeCursor(after, scope);
      const found = await options.runtime.listInvocations(scoped.ctx.workspaceId, installationId, cursor, first + 1);
      const nodes = found.slice(0, first);
      const last = nodes.at(-1);
      return json({
         nodes,
         pageInfo: {
            hasNextPage: found.length > first,
            endCursor: last ? encodeCursor(scope, { createdAt: last.createdAt, id: last.id }) : null,
         },
      });
   });

   route.post('/:workspaceId/installations/:id/surfaces/:surface/launch', async (context) => {
      const workspaceId = context.get('scoped').ctx.workspaceId;
      const installationId = id(context.req.param('id'));
      const installation = await repo().get(workspaceId, installationId).catch(mapPluginError);
      const surface = installation.manifest.surfaces.find((s) => s.key === context.req.param('surface'));
      if (!surface) throw ApiError.notFound('Surface');
      if (!installation.enabled) throw new ApiError(409, 'PLUGIN_DISABLED', 'This plugin is disabled.');
      const started = clock().getTime();
      // The token acts as the installer, but the person opening the page may
      // hold less. Never hand a viewer a token that can write what they cannot.
      const role = context.get('scoped').ctx.role;
      const scopes = installation.grantedScopes.filter((scope) => {
         if (scope === 'issues:write' || scope === 'storage:write') return allows(role, 'product.write');
         if (scope === 'comments:write') return allows(role, 'comments.write');
         return true;
      });
      const { token, expiresAt } = await options.runtime.mintToken({
         workspaceId,
         installationId,
         scopes,
         ttlMs: SURFACE_TOKEN_TTL_MS,
      });
      await options.runtime.recordInvocation({
         workspaceId, installationId, kind: 'surface', trigger: surface.key,
         status: 'ok', httpStatus: null, durationMs: clock().getTime() - started, error: null,
      });
      // The fragment never reaches a server log: the browser keeps it.
      const fragment = new URLSearchParams({
         token,
         expiresAt,
         apiUrl: options.publicUrl ?? '',
         workspaceId,
         installationId,
      });
      const base = installation.manifest.baseUrl.replace(/\/+$/, '');
      return json({ url: `${base}${surface.path}#${fragment.toString()}`, expiresAt });
   });

   return route;
}

function toSource(body: { url?: string | undefined; package?: unknown }): PackageSource {
   return body.url !== undefined ? { url: body.url } : { package: body.package };
}

function requirePermission(scoped: ScopedDb, permission: Permission): void {
   if (!allows(scoped.ctx.role, permission)) {
      throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
   }
}

function mapPluginError(error: unknown): never {
   if (error instanceof InvalidPluginInput) {
      throw new ApiError(422, 'VALIDATION_FAILED', error.fields[0]?.message ?? 'The plugin input is invalid.', {
         fields: error.fields,
      });
   }
   if (error instanceof PluginUnreachable) throw new ApiError(502, 'PLUGIN_UNREACHABLE', error.message);
   if (error instanceof PluginAlreadyInstalled) {
      throw new ApiError(409, 'PLUGIN_ALREADY_INSTALLED', 'A plugin with this key is already installed here.');
   }
   if (error instanceof NotFound) throw ApiError.notFound('Plugin');
   if (error instanceof Forbidden) {
      throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
   }
   throw error;
}

export function serializeInstallation(installation: PluginInstallation): Record<string, unknown> {
   const { manifest } = installation;
   return {
      id: installation.id,
      workspaceId: installation.workspaceId,
      key: installation.key,
      name: installation.name,
      version: installation.version,
      description: installation.description,
      source: installation.source,
      sourceUrl: installation.sourceUrl,
      enabled: installation.enabled,
      config: installation.config,
      configFields: manifest.config,
      secrets: manifest.secrets.map((s) => ({
         name: s.name,
         description: s.description,
         set: installation.secretNames.includes(s.name),
      })),
      scopes: installation.grantedScopes,
      hooks: manifest.hooks.map((h) =>
         h.trigger === 'event'
            ? { key: h.key, trigger: 'event', events: h.events }
            : { key: h.key, trigger: 'schedule', everyMinutes: h.everyMinutes }
      ),
      surfaces: manifest.surfaces.map((s) => ({ key: s.key, title: s.title })),
      mcpTools: (manifest.mcp?.tools ?? []).map((t) => ({
         name: t.name,
         description: t.description,
         approved: installation.approvedTools.includes(t.name),
      })),
      installedBy: installation.installedBy,
      createdAt: installation.createdAt,
      updatedAt: installation.updatedAt,
   };
}
