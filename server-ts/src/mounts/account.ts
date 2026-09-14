import { Hono } from 'hono';
import type { AuthVariables } from '../auth/middleware.ts';
import { json } from '../http/app.ts';
import { assertValid, decodeBody, fieldError } from '../http/body.ts';
import { ApiError } from '../http/errors.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import type { BoardRepository } from '../core/boards.ts';
import { toRFC3339, type Sql } from '../db/pool.ts';
import { pathId } from './shared.ts';

/**
 * `/api/v1/me/*` — the settings that belong to a person rather than to a
 * workspace.
 *
 * Sessions, notification preferences, and the addresses Berry can reach
 * someone at. Every route is the caller's own by construction: the user id
 * comes from the session, never from the path or the body, so there is no
 * shape of request here that could read or change somebody else's account.
 *
 * The profile and its display settings are next door in `me.ts`, which already
 * served them.
 */

/**
 * The channels the column allows, upper-case because that is how it stores
 * them. Sent and received in the same spelling rather than translated: the
 * vocabulary is small, it is what the constraint enforces, and a second
 * spelling would be one more thing that can disagree.
 */
const CHANNELS = new Set(['EMAIL', 'SMS', 'WHATSAPP', 'TELEGRAM', 'VIBER', 'LIVE_CHAT']);
const MAX_ADDRESS = 320;

/**
 * The notification switches, and their defaults.
 *
 * Named here rather than read from the column's default, because the server
 * has to answer for a person who has never opened the page — and "no row" has
 * to mean the same thing as "the defaults", not "everything off".
 */
const NOTIFICATION_KEYS = [
   'assignments',
   'mentions',
   'comments',
   'statusChanges',
   'approvals',
   'goals',
   'updates',
   'agentActivity',
] as const;

export interface AccountOptions {
   boards: BoardRepository;
   sql: Sql;
}

/**
 * Returned as a router rather than a mount: `/api/v1/me` already belongs to
 * the profile mount, and the registry refuses two mounts on one prefix —
 * which is the ambiguity it exists to refuse.
 */
export function accountRoutes(options: AccountOptions): Hono<{ Variables: AuthVariables }> {
   const route = new Hono<{ Variables: AuthVariables }>();
   const { sql } = options;

   /**
    * Where this account is signed in: live Better Auth sessions.
    *
    * `lastUsedAt` is when Better Auth last refreshed the session (it does so
    * at most once a day of use), which is coarser than the old per-request
    * stamp and is what the column can honestly say.
    */
   route.get('/sessions', async (context) => {
      const rows = await sql`
         SELECT id, user_agent, ip_address, created_at, updated_at, expires_at
           FROM auth_sessions
          WHERE user_id = ${context.get('user').id}
            AND expires_at > now()
          ORDER BY updated_at DESC, id DESC
          LIMIT 100`;
      return json({
         nodes: rows.map((row) => ({
            id: row.id as string,
            userAgent: (row.user_agent as string | null) ?? null,
            ip: (row.ip_address as string | null) ?? null,
            createdAt: toRFC3339(row.created_at as string)!,
            lastUsedAt: toRFC3339(row.updated_at as string | null),
            expiresAt: toRFC3339(row.expires_at as string)!,
         })),
      });
   });

   /**
    * Signs a device out. Deleted, because a Better Auth session has no revoked
    * state: a row that exists is a live session. Scoped to the caller in the
    * statement, so an id belonging to someone else deletes nothing.
    */
   route.delete('/sessions/:sessionId', async (context) => {
      const sessionId = pathId(context.req.param('sessionId'), 'Session');
      const rows = await sql`
         DELETE FROM auth_sessions
          WHERE id = ${sessionId} AND user_id = ${context.get('user').id}
          RETURNING id`;
      if (rows.length === 0) throw ApiError.notFound('Session');
      return new Response(null, { status: 204 });
   });

   /**
    * What Berry may tell this person about, in one workspace.
    *
    * Per workspace because the answer usually differs: someone may want every
    * mention in the workspace they work in and nothing from the one they were
    * invited to.
    */
   route.get('/notifications', async (context) => {
      const workspaceId = await requireWorkspace(context, options);
      const [row] = await sql`
         SELECT preferences FROM notification_preferences
          WHERE workspace_id = ${workspaceId} AND user_id = ${context.get('user').id}`;
      return json({ workspaceId, inApp: readSwitches(row?.preferences) });
   });

   route.patch('/notifications', async (context) => {
      const { value } = await decodeBody<{ workspaceId?: string; inApp?: unknown }>(context, {
         workspaceId: 'string',
         inApp: 'raw',
      });
      if (!value.workspaceId) {
         assertValid([fieldError('/workspaceId', 'required', 'workspaceId is required.')]);
      }
      await authorizeWorkspace(context, options, value.workspaceId!);

      const patch = value.inApp;
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
         assertValid([fieldError('/inApp', 'invalid_type', 'inApp is an object of switches.')]);
      }
      const given = patch as Record<string, unknown>;
      const unknown = Object.keys(given).filter(
         (key) => !(NOTIFICATION_KEYS as readonly string[]).includes(key)
      );
      if (unknown.length > 0) {
         // A typo silently doing nothing is how someone ends up believing they
         // turned something off.
         assertValid([
            fieldError(`/inApp/${unknown[0]}`, 'unknown', 'That is not a notification setting.'),
         ]);
      }
      if (Object.values(given).some((entry) => typeof entry !== 'boolean')) {
         assertValid([fieldError('/inApp', 'invalid_type', 'Every switch is true or false.')]);
      }

      // Read, merge, write: an absent switch keeps what is already there, so a
      // page that sends one toggle does not reset the rest.
      const [current] = await sql`
         SELECT preferences FROM notification_preferences
          WHERE workspace_id = ${value.workspaceId!} AND user_id = ${context.get('user').id}`;
      const next = { ...readSwitches(current?.preferences), ...(given as Record<string, boolean>) };

      await sql`
         INSERT INTO notification_preferences (workspace_id, user_id, preferences)
         VALUES (${value.workspaceId!}, ${context.get('user').id},
                 ${sql.json({ inApp: next } as never)})
         ON CONFLICT (workspace_id, user_id)
         DO UPDATE SET preferences = EXCLUDED.preferences, updated_at = now()`;
      return json({ workspaceId: value.workspaceId, inApp: next });
   });

   /** The addresses Berry can reach this person at, outside the product. */
   route.get('/channels', async (context) => {
      const rows = await sql`
         SELECT id, channel, address, display_name, verified_at, preferred, created_at
           FROM user_channel_identities
          WHERE user_id = ${context.get('user').id}
          ORDER BY preferred DESC, channel ASC, created_at ASC`;
      return json({
         nodes: rows.map((row) => ({
            id: row.id as string,
            channel: row.channel as string,
            address: row.address as string,
            displayName: (row.display_name as string | null) ?? null,
            // A boolean, because when it was verified is nobody's question.
            verified: row.verified_at !== null,
            preferred: Boolean(row.preferred),
            createdAt: toRFC3339(row.created_at as string)!,
         })),
      });
   });

   /**
    * Adds an address, unverified.
    *
    * Never verified on creation, whatever the caller says: an address someone
    * typed is a claim, and Berry has no way to check it from here. The column
    * exists for a verification flow that will set it.
    */
   route.post('/channels', async (context) => {
      const { value } = await decodeBody<{
         channel?: string;
         address?: string;
         displayName?: string;
         preferred?: boolean;
      }>(context, {
         channel: 'string',
         address: 'string',
         displayName: 'string',
         preferred: 'boolean',
      });

      const problems = [];
      if (!value.channel || !CHANNELS.has(value.channel)) {
         problems.push(
            fieldError('/channel', 'invalid_value', `channel is one of ${[...CHANNELS].join(', ')}.`)
         );
      }
      const address = (value.address ?? '').trim();
      if (address === '') problems.push(fieldError('/address', 'required', 'address is required.'));
      if (address.length > MAX_ADDRESS) {
         problems.push(fieldError('/address', 'too_long', `address is at most ${MAX_ADDRESS} characters.`));
      }
      if (value.channel === 'EMAIL' && address !== '' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
         problems.push(fieldError('/address', 'invalid_value', 'That is not an email address.'));
      }
      if (problems.length > 0) assertValid(problems);

      const userId = context.get('user').id;
      const row = await sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;

         // One preferred address per channel is a partial unique index, so the
         // old one is cleared *before* the insert rather than after — the
         // constraint fires on the write, not at commit.
         if (value.preferred === true) {
            await tx`
               UPDATE user_channel_identities SET preferred = false, updated_at = now()
                WHERE user_id = ${userId} AND channel = ${value.channel!} AND preferred`;
         }

         // The address is unique across accounts, not within one: the same
         // inbox cannot belong to two people. `DO UPDATE` is guarded on the
         // owner so a conflict with somebody else's row updates nothing and
         // falls through to the refusal below rather than reassigning it.
         const [written] = await tx`
            INSERT INTO user_channel_identities (user_id, channel, address, display_name, preferred)
            VALUES (${userId}, ${value.channel!}, ${address},
                    ${(value.displayName ?? '').trim() || null}, ${value.preferred === true})
            ON CONFLICT (channel, lower(address))
            DO UPDATE SET display_name = EXCLUDED.display_name,
                          preferred = EXCLUDED.preferred,
                          updated_at = now()
             WHERE user_channel_identities.user_id = ${userId}
            RETURNING id, channel, address, display_name, verified_at, preferred, created_at`;
         return written ?? null;
      });

      if (!row) {
         // Said without confirming whose it is: "already in use" is all
         // anyone needs, and naming the owner would make this a lookup.
         throw new ApiError(409, 'CONFLICT', 'That address is already in use.');
      }

      return json(
         {
            id: row.id as string,
            channel: row.channel as string,
            address: row.address as string,
            displayName: (row.display_name as string | null) ?? null,
            verified: row.verified_at !== null,
            preferred: Boolean(row.preferred),
            createdAt: toRFC3339(row.created_at as string)!,
         },
         201
      );
   });

   route.delete('/channels/:channelId', async (context) => {
      const channelId = pathId(context.req.param('channelId'), 'Channel');
      const rows = await sql`
         DELETE FROM user_channel_identities
          WHERE id = ${channelId} AND user_id = ${context.get('user').id}
          RETURNING id`;
      if (rows.length === 0) throw ApiError.notFound('Channel');
      return new Response(null, { status: 204 });
   });

   return route;
}

// ------------------------------------------------------------------ helpers

/**
 * The stored switches, with the defaults filled in behind them.
 *
 * A person who has never opened the page has no row, and reading that as
 * "everything off" would silently stop telling them things.
 */
function readSwitches(stored: unknown): Record<string, boolean> {
   const inApp =
      typeof stored === 'object' && stored !== null && !Array.isArray(stored)
         ? (stored as Record<string, unknown>).inApp
         : null;
   const given =
      typeof inApp === 'object' && inApp !== null && !Array.isArray(inApp)
         ? (inApp as Record<string, unknown>)
         : {};
   return Object.fromEntries(
      NOTIFICATION_KEYS.map((key) => [key, given[key] === undefined ? true : given[key] === true])
   );
}

async function requireWorkspace(
   context: { get: (key: 'user') => { id: string }; req: { url: string } },
   options: AccountOptions
): Promise<string> {
   const workspaceId = new URL(context.req.url).searchParams.get('workspaceId');
   if (!workspaceId) {
      assertValid([fieldError('/workspaceId', 'required', 'workspaceId is required.')]);
   }
   await authorizeWorkspace(context, options, workspaceId!);
   return workspaceId!;
}

async function authorizeWorkspace(
   context: { get: (key: 'user') => { id: string } },
   options: AccountOptions,
   workspaceId: string
): Promise<void> {
   // Membership, not a permission: these are the caller's own settings, and
   // the only question is whether they belong to the workspace at all.
   await options.boards
      .authorizeWorkspace(context.get('user').id, workspaceId, 'product.read')
      .catch((error: unknown) => {
         if (error instanceof NotFound || error instanceof Forbidden) {
            throw ApiError.notFound('Workspace');
         }
         throw error;
      });
}
