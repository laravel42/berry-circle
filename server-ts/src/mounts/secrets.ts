import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { ApiError, DecoratedApiError, type FieldError } from '../http/errors.ts';
import { assertValid, decodeBody, fieldError } from '../http/body.ts';
import { decodeTimeCursor, encodeCursor, parsePageQuery } from '../http/cursor.ts';
import { boundedLength, validEmail } from '../http/validation.ts';
import { domain } from '../identity/errors.ts';
import { validRole } from '../identity/roles.ts';
import type { Invitation, PersonalToken, SecretsRepository } from '../identity/secrets.ts';
import type { Membership } from '../identity/workspaces.ts';
import {
   fingerprintJSON,
   pathId,
   requireEmptyBody,
   requireIdempotencyKey,
   serializeMember,
} from './shared.ts';
import type { Mount } from '../http/registry.ts';

/**
 * `/api/v1/tokens` and `/api/v1/invitations`, plus the invitation routes that
 * hang off a workspace.
 *
 * Every response that carries a secret is sent `Cache-Control: no-store`,
 * because the secret exists exactly once and a cached copy is one more place
 * it can be read from.
 */

export interface SecretsOptions {
   sessions: SessionService;
   secrets: SecretsRepository;
   clock?: () => Date;
}

const DAY = 24 * 60 * 60 * 1000;

export function secretsMounts(options: SecretsOptions): Mount[] {
   return [
      { prefix: '/api/v1/tokens', handler: tokenRoutes(options) },
      { prefix: '/api/v1/invitations', handler: invitationRoutes(options) },
   ];
}

function tokenRoutes(options: SecretsOptions): Hono<{ Variables: AuthVariables }> {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));
   const { secrets } = options;
   const clock = options.clock ?? (() => new Date());

   route.get('/', async (context) => {
      const userId = context.get('user').id;
      const scope = `identity.tokens.${userId}`;
      const { first, after } = parsePageQuery(new URL(context.req.url));
      const cursor = after === '' ? null : decodeTimeCursor(after, scope);

      const found = await domain('Personal token', () =>
         secrets.listPersonalTokens(userId, cursor, first + 1)
      );
      const hasNextPage = found.length > first;
      const nodes = hasNextPage ? found.slice(0, first) : found;
      const last = nodes.at(-1);
      return json({
         nodes: nodes.map(serializePersonalToken),
         pageInfo: {
            hasNextPage,
            endCursor: last ? encodeCursor(scope, { createdAt: last.createdAt, id: last.id }) : null,
         },
      });
   });

   route.post('/', async (context) => {
      const userId = context.get('user').id;
      const { value, raw } = await decodeBody<{ name?: string; expiresAt?: string }>(context, {
         name: 'string',
         expiresAt: 'string',
      });
      const idempotencyKey = requireIdempotencyKey(context.req.raw.headers);

      const fields: FieldError[] = [];
      let name = '';
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
      const expiresAt = boundedExpiry(value.expiresAt, clock(), 365, fields, [
         '/expiresAt',
         'out_of_range',
         'Expiry must be an RFC 3339 time within the next 365 days.',
      ]);
      assertValid(fields);

      // Set before the call, as Go does: a 409 from the store is still a
      // response to a request for a secret, and must not be cached either.
      const noStore = () => ({ 'Cache-Control': 'no-store' });
      const issued = await withHeaders(noStore(), () =>
         domain('Personal token', () =>
         secrets.createPersonalToken({
            userId,
            name,
            expiresAt,
            idempotencyKey,
            fingerprint: fingerprintJSON(raw),
         })
      ));

      // `token` is omitted rather than null on a replay: Go tags it omitempty,
      // and an explicit null would suggest the secret exists and is empty.
      const body: Record<string, unknown> = {
         personalToken: serializePersonalToken(issued.token),
      };
      if (issued.secret !== '') body.token = issued.secret;

      const response = json(body, 201);
      response.headers.set('Cache-Control', 'no-store');
      response.headers.set('Location', `/api/v1/tokens/${issued.token.id}`);
      if (issued.replayed) response.headers.set('Idempotency-Replayed', 'true');
      return response;
   });

   route.delete('/:tokenId', async (context) => {
      const tokenId = pathId(context.req.param('tokenId'), 'Personal token');
      await requireEmptyBody(context.req.raw);
      await domain('Personal token', () =>
         secrets.revokePersonalToken(context.get('user').id, tokenId)
      );
      return new Response(null, { status: 204 });
   });

   return route;
}

function invitationRoutes(options: SecretsOptions): Hono<{ Variables: AuthVariables }> {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));
   const { secrets } = options;

   route.get('/', async (context) => {
      const userId = context.get('user').id;
      const scope = `identity.personal-invitations.${userId}`;
      const { first, after } = parsePageQuery(new URL(context.req.url));
      const cursor = after === '' ? null : decodeTimeCursor(after, scope);

      const found = await domain('Invitation', () =>
         secrets.listPersonalInvitations(userId, cursor, first + 1)
      );
      return json(invitationConnection(found, first, scope));
   });

   route.post('/:invitationId/accept', async (context) => {
      const invitationId = pathId(context.req.param('invitationId'), 'Invitation');
      const { value, raw } = await decodeBody<{ token?: string }>(context, { token: 'string' });
      requireIdempotencyKey(context.req.raw.headers);
      void raw;

      // 53 = the ten-character prefix plus a 43-character secret. Checked here
      // so a token of the wrong shape never reaches the lookup.
      if (value.token === undefined || !boundedLength(value.token, 53, 53)) {
         assertValid([fieldError('/token', 'invalid', 'Invitation token is invalid.')]);
      }

      const member = await withHeaders({ 'Cache-Control': 'no-store' }, () =>
         domain('Invitation', () =>
            secrets.acceptInvitation(context.get('user').id, invitationId, value.token as string)
         )
      );
      const response = json(serializeMember(member));
      response.headers.set('Cache-Control', 'no-store');
      return response;
   });

   return route;
}

/** The invitation routes that live under a workspace, mounted by that mount. */
export function workspaceInvitationRoutes(
   route: Hono<{ Variables: AuthVariables }>,
   secrets: SecretsRepository,
   clock: () => Date
): void {
   route.get('/:workspaceId/invitations', async (context) => {
      const workspaceId = pathId(context.req.param('workspaceId'), 'Workspace');
      const scope = `identity.workspace-invitations.${workspaceId}`;
      const { first, after } = parsePageQuery(new URL(context.req.url));
      const cursor = after === '' ? null : decodeTimeCursor(after, scope);

      const found = await domain('Workspace', () =>
         secrets.listWorkspaceInvitations(context.get('user').id, workspaceId, cursor, first + 1)
      );
      return json(invitationConnection(found, first, scope));
   });

   route.post('/:workspaceId/invitations', async (context) => {
      const workspaceId = pathId(context.req.param('workspaceId'), 'Workspace');
      const { value, raw } = await decodeBody<{ email?: string; role?: string; expiresAt?: string }>(
         context,
         { email: 'string', role: 'string', expiresAt: 'string' }
      );
      const idempotencyKey = requireIdempotencyKey(context.req.raw.headers);

      const fields: FieldError[] = [];
      let email = '';
      if (value.email === undefined) {
         fields.push(fieldError('/email', 'required', 'Email is required.'));
      } else {
         email = value.email.trim().toLowerCase();
         if (!validEmail(email)) {
            fields.push(fieldError('/email', 'invalid_string', 'Email must be a valid address.'));
         }
      }
      let role = 'member';
      if (value.role === undefined) {
         fields.push(fieldError('/role', 'required', 'Role is required.'));
      } else {
         role = value.role;
         if (!validRole(role) || role === 'owner') {
            fields.push(
               fieldError(
                  '/role',
                  'invalid_enum_value',
                  'Invitation role must be admin, member, or viewer.'
               )
            );
         }
      }
      const now = clock();
      const expiresAt =
         boundedExpiry(value.expiresAt, now, 30, fields, [
            '/expiresAt',
            'out_of_range',
            'Expiry must be an RFC 3339 time within the next 30 days.',
         ]) ?? new Date(now.getTime() + 7 * DAY).toISOString();
      assertValid(fields);

      const issued = await withHeaders({ 'Cache-Control': 'no-store' }, () =>
         domain('Invitation', () =>
         secrets.createInvitation({
            actorId: context.get('user').id,
            workspaceId,
            email,
            role,
            expiresAt,
            idempotencyKey,
            fingerprint: fingerprintJSON(raw),
         })
      ));

      const body: Record<string, unknown> = {
         invitation: serializeInvitation(issued.invitation),
      };
      if (issued.token !== '') body.token = issued.token;

      const response = json(body, 201);
      response.headers.set('Cache-Control', 'no-store');
      response.headers.set(
         'Location',
         `/api/v1/workspaces/${workspaceId}/invitations/${issued.invitation.id}`
      );
      if (issued.replayed) response.headers.set('Idempotency-Replayed', 'true');
      return response;
   });

   route.delete('/:workspaceId/invitations/:invitationId', async (context) => {
      await domain('Invitation', () =>
         secrets.revokeInvitation(
            context.get('user').id,
            pathId(context.req.param('workspaceId'), 'Workspace'),
            pathId(context.req.param('invitationId'), 'Invitation')
         )
      );
      return new Response(null, { status: 204 });
   });
}

/**
 * Runs `work`, attaching `headers` to whatever it throws.
 *
 * Go sets Cache-Control before calling the service, so a failure carries it as
 * surely as a success does — and a failed request for a secret is still a
 * response that must not be cached. Here the header can only be attached to a
 * Response, so an ApiError on the way out is decorated instead.
 */
async function withHeaders<T>(
   headers: Record<string, string>,
   work: () => Promise<T>
): Promise<T> {
   try {
      return await work();
   } catch (error) {
      if (error instanceof ApiError) throw new DecoratedApiError(error, headers);
      throw error;
   }
}

/**
 * An RFC 3339 expiry that is in the future and within `days`.
 *
 * Returns null when absent, so the caller supplies its own default; a value
 * that fails any of the three checks records one field error and returns null.
 */
function boundedExpiry(
   raw: string | undefined,
   now: Date,
   days: number,
   fields: FieldError[],
   error: [string, string, string]
): string | null {
   if (raw === undefined) return null;
   const parsed = new Date(raw);
   const valid =
      !Number.isNaN(parsed.getTime()) &&
      // Date accepts "2026-08-27"; RFC 3339 requires the time and a zone.
      /^\d{4}-\d{2}-\d{2}[Tt].+([Zz]|[+-]\d{2}:\d{2})$/.test(raw) &&
      parsed > now &&
      parsed <= new Date(now.getTime() + days * DAY);
   if (!valid) {
      fields.push(fieldError(error[0], error[1], error[2]));
      return null;
   }
   return parsed.toISOString();
}

function invitationConnection(
   found: Invitation[],
   first: number,
   scope: string
): Record<string, unknown> {
   const hasNextPage = found.length > first;
   const nodes = hasNextPage ? found.slice(0, first) : found;
   const last = nodes.at(-1);
   return {
      nodes: nodes.map(serializeInvitation),
      pageInfo: {
         hasNextPage,
         endCursor: last ? encodeCursor(scope, { createdAt: last.createdAt, id: last.id }) : null,
      },
   };
}

function serializePersonalToken(token: PersonalToken): Record<string, unknown> {
   return {
      id: token.id,
      name: token.name,
      prefix: token.prefix,
      expiresAt: token.expiresAt,
      lastUsedAt: token.lastUsedAt,
      revokedAt: token.revokedAt,
      createdAt: token.createdAt,
   };
}

function serializeInvitation(invitation: Invitation): Record<string, unknown> {
   return {
      id: invitation.id,
      workspaceId: invitation.workspaceId,
      email: invitation.email,
      role: invitation.role,
      invitedBy: invitation.invitedBy,
      expiresAt: invitation.expiresAt,
      acceptedAt: invitation.acceptedAt,
      revokedAt: invitation.revokedAt,
      createdAt: invitation.createdAt,
   };
}

export type { Membership };
