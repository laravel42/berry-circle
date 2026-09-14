import { Hono } from 'hono';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import { allows } from '../identity/roles.ts';
import { Forbidden } from '../identity/errors.ts';
import { parseJsonBody } from '../work/http.ts';
import {
   archiveProperty,
   createProperty,
   listProperties,
   propertyCreateSchema,
   propertyPatchSchema,
   serializeProperty,
   updateProperty,
} from '../work/properties.ts';
import {
   archiveStatus,
   createStatus,
   reorderStatuses,
   serializeStatus,
   statusCreateSchema,
   statusOrderSchema,
} from '../work/statuses.ts';
import {
   archiveQuickAction,
   createQuickAction,
   deleteQuickAction,
   listQuickActions,
   quickActionCreateSchema,
   quickActionPatchSchema,
   updateQuickAction,
} from '../work/quick-actions.ts';
import { createJoinLink, joinLinkCreateSchema, listJoinLinks, revokeJoinLink } from '../work/join-links.ts';
import { pathId, type ScopedVariables } from './shared.ts';
import { rethrowWork } from './work-errors.ts';

/**
 * Workspace vocabularies owned by work tracking, mounted inside the
 * `/api/v1/catalogs` route after `mountWorkspaceScope`, so every handler
 * already holds a membership-confirmed `scoped`.
 */
const MODERATOR_ROLES = new Set(['owner', 'admin']);

export function workCatalogRoutes(): Hono<{ Variables: ScopedVariables }> {
   const route = new Hono<{ Variables: ScopedVariables }>();

   // ------------------------------------------------------------- properties
   route.get('/:workspaceId/issue-properties', async (context) => {
      const db = context.get('scoped');
      const includeArchived = new URL(context.req.url).searchParams.get('includeArchived') === 'true';
      const nodes = await db.list((q) => listProperties(q.sql, q.workspaceId, includeArchived));
      return json({ nodes: nodes.map(serializeProperty) });
   });

   route.post('/:workspaceId/issue-properties', async (context) => {
      const db = context.get('scoped');
      const input = await parseJsonBody(context.req.raw, propertyCreateSchema);
      const created = await db
         .mutate('settings.write', (tx, ctx) => createProperty(tx, ctx.workspaceId, ctx.userId, input))
         .catch(rethrowWork('Property'));
      return json(serializeProperty(created), 201);
   });

   route.patch('/:workspaceId/issue-properties/:propertyId', async (context) => {
      const db = context.get('scoped');
      const propertyId = pathId(context.req.param('propertyId'), 'Property');
      const patch = await parseJsonBody(context.req.raw, propertyPatchSchema);
      const updated = await db
         .mutate('settings.write', (tx, ctx) => updateProperty(tx, ctx.workspaceId, propertyId, patch), {
            table: 'issue_property_definitions',
            id: propertyId,
         })
         .catch(rethrowWork('Property'));
      return json(serializeProperty(updated));
   });

   route.delete('/:workspaceId/issue-properties/:propertyId', async (context) => {
      const db = context.get('scoped');
      const propertyId = pathId(context.req.param('propertyId'), 'Property');
      const archived = await db
         .mutate('settings.write', (tx, ctx) => archiveProperty(tx, ctx.workspaceId, propertyId), {
            table: 'issue_property_definitions',
            id: propertyId,
         })
         .catch(rethrowWork('Property'));
      if (!archived) throw ApiError.notFound('Property');
      return new Response(null, { status: 204 });
   });

   // --------------------------------------------------------------- statuses
   route.post('/:workspaceId/issue-statuses', async (context) => {
      const db = context.get('scoped');
      const input = await parseJsonBody(context.req.raw, statusCreateSchema);
      const created = await db
         .mutate('settings.write', (tx, ctx) => createStatus(tx, ctx.workspaceId, ctx.userId, input))
         .catch(rethrowWork('Status'));
      return json(serializeStatus(created), 201);
   });

   route.put('/:workspaceId/issue-statuses/order', async (context) => {
      const db = context.get('scoped');
      const { ids } = await parseJsonBody(context.req.raw, statusOrderSchema);
      const nodes = await db
         .mutate('settings.write', (tx, ctx) => reorderStatuses(tx, ctx.workspaceId, ids))
         .catch(rethrowWork('Status'));
      return json({ nodes: nodes.map(serializeStatus) });
   });

   route.delete('/:workspaceId/issue-statuses/:statusId', async (context) => {
      const db = context.get('scoped');
      const statusId = pathId(context.req.param('statusId'), 'Status');
      await db
         .mutate('settings.write', (tx, ctx) => archiveStatus(tx, ctx.workspaceId, statusId), {
            table: 'issue_status_definitions',
            id: statusId,
         })
         .catch(rethrowWork('Status'));
      return new Response(null, { status: 204 });
   });

   // ---------------------------------------------------------- quick actions
   route.get('/:workspaceId/quick-actions', async (context) => {
      const db = context.get('scoped');
      const includeArchived = new URL(context.req.url).searchParams.get('includeArchived') === 'true';
      const nodes = await db.list((q) => listQuickActions(q.sql, q.workspaceId, db.ctx.userId, includeArchived));
      return json({ nodes });
   });

   route.post('/:workspaceId/quick-actions', async (context) => {
      const db = context.get('scoped');
      const input = await parseJsonBody(context.req.raw, quickActionCreateSchema);
      const created = await db
         .mutate('product.write', (tx, ctx) => createQuickAction(tx, ctx.workspaceId, ctx.userId, input))
         .catch(rethrowWork('Agent'));
      return json(created, 201);
   });

   route.patch('/:workspaceId/quick-actions/:actionId', async (context) => {
      const db = context.get('scoped');
      const actionId = pathId(context.req.param('actionId'), 'Quick action');
      const patch = await parseJsonBody(context.req.raw, quickActionPatchSchema);
      const updated = await db
         .mutate(
            'product.write',
            (tx, ctx) =>
               updateQuickAction(tx, { workspaceId: ctx.workspaceId, actionId, actorId: ctx.userId, moderator: MODERATOR_ROLES.has(ctx.role), patch }),
            { table: 'quick_action_definitions', id: actionId }
         )
         .catch(rethrowWork('Quick action'));
      return json(updated);
   });

   route.delete('/:workspaceId/quick-actions/:actionId', async (context) => {
      const db = context.get('scoped');
      const actionId = pathId(context.req.param('actionId'), 'Quick action');
      await db
         .mutate(
            'product.write',
            (tx, ctx) =>
               archiveQuickAction(tx, { workspaceId: ctx.workspaceId, actionId, actorId: ctx.userId, moderator: MODERATOR_ROLES.has(ctx.role) }),
            { table: 'quick_action_definitions', id: actionId }
         )
         .catch(rethrowWork('Quick action'));
      return new Response(null, { status: 204 });
   });

   /**
    * Remove an archived action for good. Its own verb rather than a second
    * DELETE, so the reversible and the irreversible are never the same click.
    */
   route.post('/:workspaceId/quick-actions/:actionId/delete', async (context) => {
      const db = context.get('scoped');
      const actionId = pathId(context.req.param('actionId'), 'Quick action');
      await db
         .mutate(
            'product.write',
            (tx, ctx) =>
               deleteQuickAction(tx, { workspaceId: ctx.workspaceId, actionId, actorId: ctx.userId, moderator: MODERATOR_ROLES.has(ctx.role) }),
            { table: 'quick_action_definitions', id: actionId }
         )
         .catch(rethrowWork('Quick action'));
      return new Response(null, { status: 204 });
   });

   // ------------------------------------------------------------- join links
   route.get('/:workspaceId/join-links', async (context) => {
      const db = context.get('scoped');
      if (!allows(db.ctx.role, 'invitations.read')) throw rethrowWork('Join link')(new Forbidden());
      const nodes = await db.list((q) => listJoinLinks(q.sql, q.workspaceId));
      return json({ nodes });
   });

   route.post('/:workspaceId/join-links', async (context) => {
      const db = context.get('scoped');
      const input = await parseJsonBody(context.req.raw, joinLinkCreateSchema);
      const created = await db.mutate('invitations.write', (tx, ctx) => createJoinLink(tx, ctx.workspaceId, ctx.userId, input));
      const response = json({ ...created.link, token: created.token }, 201);
      response.headers.set('Cache-Control', 'no-store');
      return response;
   });

   route.delete('/:workspaceId/join-links/:linkId', async (context) => {
      const db = context.get('scoped');
      const linkId = pathId(context.req.param('linkId'), 'Join link');
      const revoked = await db
         .mutate('invitations.write', (tx, ctx) => revokeJoinLink(tx, ctx.workspaceId, linkId), {
            table: 'workspace_join_links',
            id: linkId,
         })
         .catch(rethrowWork('Join link'));
      if (!revoked) throw ApiError.notFound('Join link');
      return new Response(null, { status: 204 });
   });

   return route;
}
