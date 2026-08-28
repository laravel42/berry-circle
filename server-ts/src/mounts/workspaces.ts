import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { ApiError, type FieldError } from '../http/errors.ts';
import { assertValid, decodeBody, fieldError } from '../http/body.ts';
import {
   encodeCursor,
   decodeNameCursor,
   decodeTimeCursor,
   parsePageQuery,
} from '../http/cursor.ts';
import { boundedLength, validIssuePrefix, validWorkspaceSlug } from '../http/validation.ts';
import { domain } from '../identity/errors.ts';
import { validRole, type Role } from '../identity/roles.ts';
import type { Membership, WorkspaceRepository } from '../identity/workspaces.ts';
import type { Workspace, WorkspaceSettings } from '../identity/repository.ts';
import { serializeWorkspace } from './me.ts';
import {
   fingerprintJSON,
   pathId,
   requireEmptyBody,
   requireIdempotencyKey,
   serializeMember,
} from './shared.ts';
import { workspaceInvitationRoutes } from './secrets.ts';
import type { SecretsRepository } from '../identity/secrets.ts';
import type { Mount } from '../http/registry.ts';

/**
 * `/api/v1/workspaces`.
 *
 * Authorization lives in the repository, next to the statements it guards, so
 * a route cannot reach the data without passing it. These handlers validate
 * shape and serialise; they do not decide who may do what.
 */

export interface WorkspaceOptions {
   sessions: SessionService;
   workspaces: WorkspaceRepository;
   /** Invitations live under this prefix, so their routes are added here. */
   secrets: SecretsRepository;
   clock?: () => Date;
}

export function workspaceMounts(options: WorkspaceOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));

   const { workspaces } = options;
   workspaceInvitationRoutes(route, options.secrets, options.clock ?? (() => new Date()));

   route.get('/', async (context) => {
      const userId = context.get('user').id;
      const scope = `identity.workspaces.${userId}`;
      const { first, after } = parsePageQuery(new URL(context.req.url));
      const cursor = after === '' ? null : decodeTimeCursor(after, scope);

      // One more than asked for, so the extra row answers hasNextPage without
      // a second count query.
      const found = await domain('Workspace', () => workspaces.list(userId, cursor, first + 1));
      const { nodes, hasNextPage } = page(found, first);
      return json({
         nodes: nodes.map(serializeWorkspace),
         pageInfo: {
            hasNextPage,
            endCursor: timeCursorOf(scope, nodes),
         },
      });
   });

   route.post('/', async (context) => {
      const userId = context.get('user').id;
      const { value, raw } = await decodeBody<CreateBody>(context, {
         name: 'string',
         slug: 'string',
         description: 'raw',
      });
      const idempotencyKey = requireIdempotencyKey(context.req.raw.headers);

      const fields: FieldError[] = [];
      let name = '';
      let slug = '';
      if (value.name === undefined) {
         fields.push(fieldError('/name', 'required', 'Name is required.'));
      } else {
         name = value.name.trim();
         if (!boundedLength(name, 1, 100)) {
            fields.push(
               fieldError('/name', 'invalid_length', 'Name must contain 1 to 100 characters.')
            );
         }
      }
      if (value.slug === undefined) {
         fields.push(fieldError('/slug', 'required', 'Slug is required.'));
      } else {
         slug = value.slug.trim().toLowerCase();
         if (!validWorkspaceSlug(slug)) {
            fields.push(
               fieldError(
                  '/slug',
                  'invalid_format',
                  'Slug must contain 2 to 50 lowercase letters, digits, or hyphens.'
               )
            );
         }
      }
      const description = nullableString(value.description, 5000, '/description', fields);
      assertValid(fields);

      const { workspace, replayed } = await domain('Workspace', () =>
         workspaces.create({
            actorId: userId,
            name,
            slug,
            description: description.set ? description.value : null,
            idempotencyKey,
            fingerprint: fingerprintJSON(raw),
         })
      );

      const headers: Record<string, string> = {
         Location: `/api/v1/workspaces/${workspace.id}`,
      };
      if (replayed) headers['Idempotency-Replayed'] = 'true';
      const response = json(serializeWorkspace(workspace), 201);
      for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
      return response;
   });

   route.get('/:workspaceId', async (context) =>
      json(
         serializeWorkspace(
            await domain('Workspace', () =>
               workspaces.get(pathId(context.req.param('workspaceId'), 'Workspace'), context.get('user').id)
            )
         )
      )
   );

   route.patch('/:workspaceId', async (context) => {
      const workspaceId = pathId(context.req.param('workspaceId'), 'Workspace');
      const { value } = await decodeBody<UpdateBody>(context, {
         name: 'string',
         slug: 'string',
         description: 'raw',
      });

      const fields: FieldError[] = [];
      const patch: { name?: string; slug?: string; descriptionSet: boolean; description?: string | null } =
         { descriptionSet: false };
      if (value.name !== undefined) {
         const trimmed = value.name.trim();
         if (!boundedLength(trimmed, 1, 100)) {
            fields.push(
               fieldError('/name', 'invalid_length', 'Name must contain 1 to 100 characters.')
            );
         } else {
            patch.name = trimmed;
         }
      }
      if (value.slug !== undefined) {
         const trimmed = value.slug.trim().toLowerCase();
         if (!validWorkspaceSlug(trimmed)) {
            fields.push(
               fieldError(
                  '/slug',
                  'invalid_format',
                  'Slug must contain 2 to 50 lowercase letters, digits, or hyphens.'
               )
            );
         } else {
            patch.slug = trimmed;
         }
      }
      const description = nullableString(value.description, 5000, '/description', fields);
      if (description.ok && description.set) {
         patch.descriptionSet = true;
         patch.description = description.value;
      }
      // Unlike the profile patch, Go only marks a field present here once it
      // has validated, so an invalid name alone also reads as an empty patch.
      if (patch.name === undefined && patch.slug === undefined && !patch.descriptionSet) {
         fields.push(fieldError('/', 'empty_patch', 'At least one workspace field is required.'));
      }
      assertValid(fields);

      return json(
         serializeWorkspace(
            await domain('Workspace', () =>
               workspaces.update(context.get('user').id, workspaceId, patch)
            )
         )
      );
   });

   route.delete('/:workspaceId', async (context) => {
      await domain('Workspace', () =>
         workspaces.remove(context.get('user').id, pathId(context.req.param('workspaceId'), 'Workspace'))
      );
      return new Response(null, { status: 204 });
   });

   route.post('/:workspaceId/select', async (context) => {
      const workspaceId = pathId(context.req.param('workspaceId'), 'Workspace');
      await requireEmptyBody(context.req.raw);
      const userId = context.get('user').id;
      await domain('Workspace', () => workspaces.select(userId, workspaceId));
      return json(serializeWorkspace(await domain('Workspace', () => workspaces.get(workspaceId, userId))));
   });

   route.get('/:workspaceId/settings', async (context) => {
      const workspace = await domain('Workspace', () =>
         workspaces.get(pathId(context.req.param('workspaceId'), 'Workspace'), context.get('user').id)
      );
      return json(serializeSettings(workspace.settings));
   });

   route.patch('/:workspaceId/settings', async (context) => {
      const workspaceId = pathId(context.req.param('workspaceId'), 'Workspace');
      const { value } = await decodeBody<SettingsBody>(context, {
         issuePrefix: 'string',
         defaultRole: 'string',
         allowMemberInvites: 'boolean',
      });

      const fields: FieldError[] = [];
      const patch: { issuePrefix?: string; defaultRole?: string; allowMemberInvites?: boolean } = {};
      if (value.issuePrefix !== undefined) {
         const normalised = value.issuePrefix.trim().toUpperCase();
         patch.issuePrefix = normalised;
         if (!validIssuePrefix(normalised)) {
            fields.push(
               fieldError(
                  '/issuePrefix',
                  'invalid_format',
                  'Issue prefix must contain 2 to 12 uppercase letters or digits.'
               )
            );
         }
      }
      if (value.defaultRole !== undefined) {
         patch.defaultRole = value.defaultRole;
         // Only member and viewer: a workspace that admitted everyone as an
         // admin by default would have no boundary left to enforce.
         if (value.defaultRole !== 'member' && value.defaultRole !== 'viewer') {
            fields.push(
               fieldError('/defaultRole', 'invalid_enum_value', 'Default role must be member or viewer.')
            );
         }
      }
      if (value.allowMemberInvites !== undefined) patch.allowMemberInvites = value.allowMemberInvites;
      if (
         value.issuePrefix === undefined &&
         value.defaultRole === undefined &&
         value.allowMemberInvites === undefined
      ) {
         fields.push(fieldError('/', 'empty_patch', 'At least one workspace setting is required.'));
      }
      assertValid(fields);

      return json(
         serializeSettings(
            await domain('Workspace', () =>
               workspaces.updateSettings(context.get('user').id, workspaceId, patch)
            )
         )
      );
   });

   route.get('/:workspaceId/members', async (context) => {
      const workspaceId = pathId(context.req.param('workspaceId'), 'Workspace');
      const scope = `identity.members.${workspaceId}`;
      const { first, after } = parsePageQuery(new URL(context.req.url));
      const cursor = after === '' ? null : decodeNameCursor(after, scope);

      const found = await domain('Workspace', () =>
         workspaces.listMembers(context.get('user').id, workspaceId, cursor, first + 1)
      );
      const { nodes, hasNextPage } = page(found, first);
      const last = nodes.at(-1);
      return json({
         nodes: nodes.map(serializeMember),
         pageInfo: {
            hasNextPage,
            endCursor: last ? encodeCursor(scope, { name: last.name, id: last.userId }) : null,
         },
      });
   });

   route.patch('/:workspaceId/members/:userId', async (context) => {
      const workspaceId = pathId(context.req.param('workspaceId'), 'Workspace');
      const targetId = pathId(context.req.param('userId'), 'Member');
      const { value } = await decodeBody<{ role?: string }>(context, { role: 'string' });
      if (value.role === undefined || !validRole(value.role)) {
         assertValid([
            fieldError('/role', 'invalid_enum_value', 'Role must be owner, admin, member, or viewer.'),
         ]);
      }

      return json(
         serializeMember(
            await domain('Member', () =>
               workspaces.updateMemberRole(
                  workspaceId,
                  context.get('user').id,
                  targetId,
                  value.role as Role
               )
            )
         )
      );
   });

   route.delete('/:workspaceId/members/:userId', async (context) => {
      await domain('Member', () =>
         workspaces.removeMember(
            pathId(context.req.param('workspaceId'), 'Workspace'),
            context.get('user').id,
            pathId(context.req.param('userId'), 'Member')
         )
      );
      return new Response(null, { status: 204 });
   });

   return [{ prefix: '/api/v1/workspaces', handler: route }];
}

interface CreateBody {
   name?: string;
   slug?: string;
   description?: unknown;
}
type UpdateBody = CreateBody;

interface SettingsBody {
   issuePrefix?: string;
   defaultRole?: string;
   allowMemberInvites?: boolean;
}

/** Trims the over-fetched row and reports whether it existed. */
function page<T>(found: T[], first: number): { nodes: T[]; hasNextPage: boolean } {
   const hasNextPage = found.length > first;
   return { nodes: hasNextPage ? found.slice(0, first) : found, hasNextPage };
}

function timeCursorOf(scope: string, nodes: Workspace[]): string | null {
   const last = nodes.at(-1);
   return last ? encodeCursor(scope, { createdAt: last.createdAt, id: last.id }) : null;
}


/**
 * `null` clears, an absent field leaves it, and anything else must be a
 * bounded string. Ported from parseNullableString.
 */
function nullableString(
   raw: unknown,
   maximum: number,
   path: string,
   fields: FieldError[]
): { ok: boolean; set: boolean; value: string | null } {
   if (raw === undefined) return { ok: true, set: false, value: null };
   if (raw === null) return { ok: true, set: true, value: null };
   if (typeof raw !== 'string' || !boundedLength(raw.trim(), 0, maximum)) {
      fields.push(
         fieldError(path, 'invalid_length', `Description must be null or at most 5,000 characters.`)
      );
      return { ok: false, set: true, value: null };
   }
   return { ok: true, set: true, value: raw.trim() };
}

function serializeSettings(settings: WorkspaceSettings): Record<string, unknown> {
   return {
      issuePrefix: settings.issuePrefix,
      defaultRole: settings.defaultRole,
      allowMemberInvites: settings.allowMemberInvites,
   };
}

