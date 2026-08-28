import { randomUUID } from 'node:crypto';
import { BaseSessionService } from '@google/adk';
import type {
   AppendEventRequest,
   CreateSessionRequest,
   DeleteSessionRequest,
   Event,
   GetSessionRequest,
   ListSessionsRequest,
   ListSessionsResponse,
   Session,
} from '@google/adk';
import type { Sql } from '../db/pool.ts';

/**
 * ADK sessions kept in Berry's own database.
 *
 * ADK ships a `DatabaseSessionService`, but it brings MikroORM — which would
 * become a second owner of this schema alongside Berry's forward-only,
 * checksummed migrations. Storage is supplied here instead so there stays
 * exactly one migrator and one place the schema is described.
 *
 * This is what replaces the runtime's per-agent directory. A session is a row: it
 * cannot be marked crashed for being idle, it does not need reconciling
 * against an upstream list, and two agents can be given the same one on
 * purpose rather than by accident.
 */

const DEFAULT_LIST_LIMIT = 100;

export interface BerrySessionOptions {
   sql: Sql;
   /** Berry's scope for a new session, when it has one. */
   workspaceId?: string | undefined;
   runId?: string | undefined;
   clock?: () => Date;
   newId?: () => string;
}

export class BerrySessionService extends BaseSessionService {
   private readonly sql: Sql;
   private readonly workspaceId: string | undefined;
   private readonly runId: string | undefined;
   private readonly clock: () => Date;
   private readonly newId: () => string;

   constructor(options: BerrySessionOptions) {
      super();
      this.sql = options.sql;
      this.workspaceId = options.workspaceId;
      this.runId = options.runId;
      this.clock = options.clock ?? (() => new Date());
      this.newId = options.newId ?? randomUUID;
   }

   override async createSession({
      appName,
      userId,
      state,
      sessionId,
   }: CreateSessionRequest): Promise<Session> {
      const id = sessionId ?? this.newId();
      const now = this.clock().toISOString();
      const initialState = state ?? {};

      // ON CONFLICT rather than a plain insert: ADK may hand back an id the
      // caller chose, and re-creating an existing session should return it
      // rather than fail a run that is merely being resumed.
      const [row] = await this.sql`
         INSERT INTO adk_sessions (app_name, user_id, id, workspace_id, run_id, state, created_at, last_update_time)
         VALUES (${appName}, ${userId}, ${id}, ${this.workspaceId ?? null}, ${this.runId ?? null},
                 ${this.sql.json(initialState as Record<string, never>)}::jsonb, ${now}, ${now})
         ON CONFLICT (app_name, user_id, id) DO UPDATE SET last_update_time = EXCLUDED.last_update_time
         RETURNING app_name, user_id, id, state, last_update_time`;

      return toSession(row!, []);
   }

   /**
    * A session and its transcript.
    *
    * `numRecentEvents` reads the tail, which is what a long conversation needs
    * — replaying every turn to answer one more would grow the prompt until the
    * model refused it.
    */
   override async getSession({
      appName,
      userId,
      sessionId,
      config,
   }: GetSessionRequest): Promise<Session | undefined> {
      const [row] = await this.sql`
         SELECT app_name, user_id, id, state, last_update_time
           FROM adk_sessions
          WHERE app_name = ${appName} AND user_id = ${userId} AND id = ${sessionId}`;
      if (!row) return undefined;

      const afterTimestamp = config?.afterTimestamp;
      const limit = config?.numRecentEvents ?? null;

      // Selected newest-first so a limit takes the tail, then reversed: ADK
      // replays a conversation forwards.
      const rows = await this.sql`
         SELECT payload
           FROM adk_session_events
          WHERE app_name = ${appName} AND user_id = ${userId} AND session_id = ${sessionId}
            AND (${afterTimestamp ?? null}::double precision IS NULL
                 OR extract(epoch FROM occurred_at) > ${afterTimestamp ?? null})
          ORDER BY sequence DESC
          LIMIT ${limit}`;

      const events = rows.map((entry) => entry.payload as Event).reverse();
      return toSession(row, events);
   }

   override async listSessions({
      appName,
      userId,
      limit,
      offset,
      page,
      order,
   }: ListSessionsRequest): Promise<ListSessionsResponse> {
      const size = limit ?? DEFAULT_LIST_LIMIT;
      // `page` is 1-based and takes precedence over `offset`, as ADK documents.
      const skip = page !== undefined ? (page - 1) * size : (offset ?? 0);
      const descending = order !== 'asc';

      // Counted as well as read: ADK's response carries the totals, and
      // deriving them from the page would report the page as the whole.
      const [totals] = await this.sql`
         SELECT count(*)::int AS total
           FROM adk_sessions
          WHERE app_name = ${appName}
            AND (${userId ?? null}::text IS NULL OR user_id = ${userId ?? null})`;
      const totalItems = (totals?.total as number) ?? 0;

      const rows = await this.sql`
         SELECT app_name, user_id, id, state, last_update_time
           FROM adk_sessions
          WHERE app_name = ${appName}
            AND (${userId ?? null}::text IS NULL OR user_id = ${userId ?? null})
          ORDER BY
             CASE WHEN ${descending} THEN last_update_time END DESC,
             CASE WHEN ${!descending} THEN last_update_time END ASC,
             id
          LIMIT ${size} OFFSET ${skip}`;

      // Listings carry no events: they are for choosing a session, and loading
      // every transcript to render a list is how a list becomes slow.
      return {
         sessions: rows.map((row) => toSession(row, [])),
         page: page ?? Math.floor(skip / size) + 1,
         limit: size,
         totalItems,
         totalPages: size > 0 ? Math.ceil(totalItems / size) : 0,
      };
   }

   override async deleteSession({
      appName,
      userId,
      sessionId,
   }: DeleteSessionRequest): Promise<void> {
      await this.sql`
         DELETE FROM adk_sessions
          WHERE app_name = ${appName} AND user_id = ${userId} AND id = ${sessionId}`;
   }

   /**
    * Appends one event and advances the session.
    *
    * The session row is locked first, and that lock is what allocates the
    * sequence safely. Reading `MAX(sequence)` inside a transaction is not
    * enough: at READ COMMITTED two concurrent appends both see the same
    * maximum, both claim the next number, and the second fails on the primary
    * key. Locking the session serialises writers to one conversation without
    * blocking any other.
    *
    * The insert and the session's timestamp move together, because a session
    * whose events are ahead of its own last-update time sorts wrongly in every
    * listing.
    */
   override async appendEvent({ session, event }: AppendEventRequest): Promise<Event> {
      const now = this.clock().toISOString();

      await this.sql.begin(async (tx) => {
         const [locked] = await tx`
            SELECT id FROM adk_sessions
             WHERE app_name = ${session.appName} AND user_id = ${session.userId}
               AND id = ${session.id}
             FOR UPDATE`;
         if (!locked) throw new Error(`session ${session.id} does not exist`);

         // Comes back as a string: the driver renders bigint as text rather
         // than risk a double losing precision. It goes straight back to
         // PostgreSQL, so it never needs to be a JavaScript number.
         const [next] = await tx`
            SELECT COALESCE(MAX(sequence) + 1, 0) AS sequence
              FROM adk_session_events
             WHERE app_name = ${session.appName} AND user_id = ${session.userId}
               AND session_id = ${session.id}`;

         await tx`
            INSERT INTO adk_session_events (id, app_name, user_id, session_id, sequence, payload, occurred_at)
            VALUES (${event.id ?? randomUUID()}, ${session.appName}, ${session.userId}, ${session.id},
                    ${next!.sequence as string}, ${tx.json(event as unknown as Record<string, never>)}::jsonb, ${now})`;

         await tx`
            UPDATE adk_sessions
               SET last_update_time = ${now},
                   state = ${tx.json((session.state ?? {}) as Record<string, never>)}::jsonb
             WHERE app_name = ${session.appName} AND user_id = ${session.userId} AND id = ${session.id}`;
      });

      // ADK's base class applies the event's state delta to the in-memory
      // session; deferring to it keeps that behaviour in one place.
      return super.appendEvent({ session, event });
   }
}

function toSession(row: Record<string, unknown>, events: Event[]): Session {
   return {
      appName: row.app_name as string,
      userId: row.user_id as string,
      id: row.id as string,
      state: (row.state ?? {}) as Record<string, unknown>,
      events,
      // ADK measures this in seconds since the epoch, not as a Date.
      lastUpdateTime: new Date(row.last_update_time as string).getTime() / 1000,
   } as Session;
}
