import { randomUUID } from 'node:crypto';
import { toRFC3339, type Sql } from '../db/pool.ts';
import { Conflict, Forbidden, NotFound } from '../identity/errors.ts';
import { allows, type Permission } from '../identity/roles.ts';
import type { Scope } from './boards.ts';

/**
 * Comments.
 *
 * A comment is one level deep: a reply hangs off a root comment and nothing
 * hangs off a reply. That is enforced when the parent is locked rather than by
 * a constraint, because the rule is about the shape of a conversation and not
 * about the row.
 *
 * Every mutation writes an outbox event in the same transaction. Comments are
 * the surface people watch most closely — someone is waiting for the reply —
 * so an announced comment that then rolled back would be one they saw and
 * cannot open.
 */

export interface ActorRef {
   type: string;
   id: string;
   name: string;
   avatarUrl: string | null;
}

export interface Comment {
   id: string;
   issueId: string;
   body: string;
   author: ActorRef;
   parentId: string | null;
   revision: number;
   resolvedAt: string | null;
   resolvedBy: ActorRef | null;
   createdAt: string;
   updatedAt: string;
}

/** `{createdAt, id}` — comments page forward, oldest first. */
export interface CommentCursor {
   createdAt: string;
   id: string;
}

export interface CommentEvent {
   id: string;
   type: string;
   workspaceId: string;
   boardId: string;
   issueId: string;
   payload: string;
   occurredAt: Date;
}

/** A reply may not hang off another reply. */
export class InvalidParent extends Error {
   constructor() {
      super('a reply cannot be nested under another reply');
      this.name = 'InvalidParent';
   }
}

/** The comment changed since the caller last read it. */
export class RevisionConflict extends Error {
   readonly currentRevision: number;

   constructor(currentRevision: number) {
      super('comment revision conflict');
      this.name = 'RevisionConflict';
      this.currentRevision = currentRevision;
   }
}

const COMMENT_COLUMNS = `
   c.id, c.issue_id, c.body, c.author_type::text AS author_type, c.author_id,
   COALESCE(author.name, author_agent.name) AS author_name,
   COALESCE(author.avatar_url, author_agent.avatar_url) AS author_avatar,
   c.parent_id, c.revision,
   c.resolved_at, c.resolved_by, resolver.name AS resolver_name,
   resolver.avatar_url AS resolver_avatar,
   c.created_at, c.updated_at`;

/**
 * Both kinds of author are joined, always.
 *
 * Agents author comments too — a run posts its result as one — and a users
 * join alone renders those with a null name, as the literal word "Agent" and
 * no avatar. One shared clause keeps the agent join from being forgotten at
 * either read site.
 */
const COMMENT_SOURCE = `
   FROM comments AS c
   LEFT JOIN users AS author
     ON c.author_type = 'user' AND author.id = c.author_id
   LEFT JOIN agents AS author_agent
     ON c.author_type = 'agent' AND author_agent.id = c.author_id
   LEFT JOIN users AS resolver ON resolver.id = c.resolved_by`;

export interface CreateCommentParams {
   issueId: string;
   authorType?: string;
   authorId: string;
   body: string;
   parentId?: string | null;
   createdAt: string;
}

export class CommentRepository {
   private readonly sql: Sql;
   private readonly newId: () => string;

   constructor(sql: Sql, newId: () => string = randomUUID) {
      this.sql = sql;
      this.newId = newId;
   }

   /**
    * Membership reached through the comment's issue and board.
    *
    * A comment outside the caller's workspaces is "not found" rather than
    * "forbidden", so the error cannot be used to discover which ids exist.
    */
   async authorize(userId: string, commentId: string, permission: Permission): Promise<Scope> {
      const [row] = await this.sql`
         SELECT board.workspace_id, membership.role::text AS role
           FROM comments AS comment
           JOIN issues AS issue ON issue.id = comment.issue_id
           JOIN boards AS board ON board.id = issue.board_id
           JOIN workspaces AS workspace
             ON workspace.id = board.workspace_id AND workspace.deleted_at IS NULL
           JOIN workspace_memberships AS membership
             ON membership.workspace_id = workspace.id AND membership.user_id = ${userId}
          WHERE comment.id = ${commentId}`;
      if (!row) throw new NotFound();
      const scope = { workspaceId: row.workspace_id as string, role: row.role as string };
      if (!allows(scope.role, permission)) throw new Forbidden();
      return scope;
   }

   /** One page, oldest first — the order a conversation is read in. */
   async list(issueId: string, after: CommentCursor | null, limit: number): Promise<Comment[]> {
      const rows = await this.sql`
         SELECT ${this.sql.unsafe(COMMENT_COLUMNS)} ${this.sql.unsafe(COMMENT_SOURCE)}
          WHERE c.issue_id = ${issueId}
            AND (${after === null} OR (c.created_at, c.id) > (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
          ORDER BY c.created_at ASC, c.id ASC
          LIMIT ${limit}`;
      return rows.map(toComment);
   }

   async get(commentId: string): Promise<Comment> {
      const [row] = await this.sql`
         SELECT ${this.sql.unsafe(COMMENT_COLUMNS)} ${this.sql.unsafe(COMMENT_SOURCE)}
          WHERE c.id = ${commentId}`;
      if (!row) throw new NotFound();
      return toComment(row);
   }

   /**
    * Creates a comment, locking its issue and any parent first.
    *
    * KEY SHARE on the issue: it blocks the issue being deleted underneath the
    * insert without blocking ordinary edits to it. The parent is locked for
    * the same reason and checked for two things — that it belongs to this
    * issue, and that it is not itself a reply.
    */
   async create(params: CreateCommentParams): Promise<{ comment: Comment; event: CommentEvent }> {
      const authorType = params.authorType ?? 'user';
      if (authorType !== 'user' && authorType !== 'agent') {
         throw new Error(`create comment: unsupported author type ${authorType}`);
      }
      const id = this.newId();
      const eventId = this.newId();

      return this.sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const [issue] = await tx`
            SELECT id FROM issues WHERE id = ${params.issueId} AND deleted_at IS NULL
             FOR KEY SHARE`;
         if (!issue) throw new NotFound();

         if (params.parentId) {
            const [parent] = await tx`
               SELECT issue_id, parent_id FROM comments WHERE id = ${params.parentId}
                FOR KEY SHARE`;
            if (!parent) throw new NotFound();
            if (parent.issue_id !== params.issueId) throw new NotFound();
            if (parent.parent_id !== null) throw new InvalidParent();
         }

         await tx`
            INSERT INTO comments (
               id, issue_id, author_type, author_id, body, parent_id, created_at, updated_at
            ) VALUES (
               ${id}, ${params.issueId}, ${authorType}::assignee_type, ${params.authorId},
               ${params.body}, ${params.parentId ?? null}, ${params.createdAt}, ${params.createdAt}
            )`.catch(classifyWrite);

         const comment = await readComment(tx, id);
         const event = await this.persistOutbox(tx, eventId, 'comment.created', comment, params.createdAt);
         return { comment, event };
      }) as Promise<{ comment: Comment; event: CommentEvent }>;
   }

   /**
    * Edits a comment's body.
    *
    * `expectedRevision` is optional and, when given, is the whole point: two
    * people editing the same comment would otherwise silently overwrite each
    * other, and the second would never learn the first had written anything.
    */
   async update(params: {
      commentId: string;
      actorId: string;
      moderator: boolean;
      body: string;
      expectedRevision?: number | undefined;
      updatedAt: string;
   }): Promise<{ comment: Comment; event: CommentEvent }> {
      const eventId = this.newId();
      return this.sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const current = await lockForModeration(tx, params.commentId, params.actorId, params.moderator);
         if (params.expectedRevision !== undefined && params.expectedRevision !== current) {
            throw new RevisionConflict(current);
         }

         const updated = await tx`
            UPDATE comments SET body = ${params.body}, revision = revision + 1,
                   updated_at = ${params.updatedAt}
             WHERE id = ${params.commentId}`.catch(classifyWrite);
         if (updated.count !== 1) throw new NotFound();

         const comment = await readComment(tx, params.commentId);
         const event = await this.persistOutbox(
            tx, eventId, 'comment.updated', comment, params.updatedAt);
         return { comment, event };
      }) as Promise<{ comment: Comment; event: CommentEvent }>;
   }

   /**
    * Removes a comment and, by cascade, its replies.
    *
    * The event carries the comment as it was: a consumer told only an id has
    * to have kept the comment to know what disappeared.
    */
   async delete(params: {
      commentId: string;
      actorId: string;
      moderator: boolean;
      deletedAt: string;
   }): Promise<CommentEvent> {
      const eventId = this.newId();
      return this.sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         await lockForModeration(tx, params.commentId, params.actorId, params.moderator);
         const existing = await readComment(tx, params.commentId);

         const removed = await tx`DELETE FROM comments WHERE id = ${params.commentId}`;
         if (removed.count !== 1) throw new NotFound();

         return this.persistOutbox(tx, eventId, 'comment.deleted', existing, params.deletedAt);
      }) as Promise<CommentEvent>;
   }

   /**
    * The relay copy, written in the same transaction as the change.
    *
    * The envelope is an object rather than text cast with `::jsonb`: casting
    * text stores the whole thing quoted and escaped, which reads as valid
    * jsonb to anything checking only the column type and fails to decode
    * everywhere else.
    */
   private async persistOutbox(
      tx: Sql,
      eventId: string,
      type: string,
      comment: Comment,
      occurredAt: string
   ): Promise<CommentEvent> {
      // Deliberately not filtered on issue.deleted_at, matching what the run
      // ledger does for the same reason: this describes a change that has
      // already happened, and a comment on a soft-deleted issue is still
      // readable, so refusing to describe the change makes the comment
      // frozen rather than gone.
      //
      // Go filters here, and the effect is a bug: editing or deleting such a
      // comment authorizes, updates the row, then fails resolving the
      // workspace and rolls back as a 500. See ROUTING.md.
      const [scope] = await tx`
         SELECT board.workspace_id, board.id AS board_id
           FROM issues AS issue
           JOIN boards AS board ON board.id = issue.board_id
          WHERE issue.id = ${comment.issueId}`;
      if (!scope) throw new NotFound();

      const payload = { comment: serializeComment(comment) };
      const envelope = {
         id: eventId,
         type,
         occurredAt: toRFC3339(occurredAt),
         workspaceId: scope.workspace_id,
         // boardId and issueId sit beside the collaboration fields so a board
         // stream can replay a comment without reaching into its payload.
         boardId: scope.board_id,
         issueId: comment.issueId,
         aggregateType: 'comment',
         aggregateId: comment.id,
         payload,
      };

      await tx`
         INSERT INTO outbox_events (
            id, topic, aggregate_type, aggregate_id, workspace_id, board_id,
            payload, occurred_at, available_at
         ) VALUES (
            ${eventId}, ${type}, 'comment', ${comment.id},
            ${scope.workspace_id as string}, ${scope.board_id as string},
            ${tx.json(envelope as never)}, ${occurredAt}, ${occurredAt}
         )`;

      return {
         id: eventId,
         type,
         workspaceId: scope.workspace_id as string,
         boardId: scope.board_id as string,
         issueId: comment.issueId,
         payload: JSON.stringify(payload),
         occurredAt: new Date(occurredAt),
      };
   }
}

/**
 * Locks a comment and decides whether this actor may change it.
 *
 * Returns the current revision, which the caller compares against what it was
 * shown. Locked first so the check and the write cannot straddle somebody
 * else's edit.
 */
async function lockForModeration(
   tx: Sql,
   commentId: string,
   actorId: string,
   moderator: boolean
): Promise<number> {
   const [row] = await tx`
      SELECT author_type::text AS author_type, author_id, revision
        FROM comments WHERE id = ${commentId} FOR UPDATE`;
   if (!row) throw new NotFound();
   // A moderator may act on anyone's comment; everybody else only on their
   // own, and only when they are a user — an agent's comment is the record of
   // what a run reported and is not somebody's to edit.
   if (!moderator && (row.author_type !== 'user' || row.author_id !== actorId)) {
      throw new Forbidden();
   }
   return Number(row.revision);
}

async function readComment(tx: Sql, commentId: string): Promise<Comment> {
   const [row] = await tx`
      SELECT ${tx.unsafe(COMMENT_COLUMNS)} ${tx.unsafe(COMMENT_SOURCE)}
       WHERE c.id = ${commentId}`;
   if (!row) throw new NotFound();
   return toComment(row);
}

function toComment(row: Record<string, unknown>): Comment {
   return {
      id: row.id as string,
      issueId: row.issue_id as string,
      body: row.body as string,
      author: actorRef(
         row.author_type as string,
         row.author_id as string,
         row.author_name as string | null,
         row.author_avatar as string | null
      ),
      parentId: (row.parent_id as string | null) ?? null,
      revision: Number(row.revision),
      resolvedAt: toRFC3339(row.resolved_at as string | null),
      resolvedBy: row.resolved_by
         ? actorRef(
              'user',
              row.resolved_by as string,
              row.resolver_name as string | null,
              row.resolver_avatar as string | null
           )
         : null,
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}

/**
 * The fallback names Go uses when the row behind an id is gone.
 *
 * An author that renders as nothing is worse than one that admits it does not
 * know who this was.
 */
export function actorRef(
   type: string,
   id: string,
   name: string | null,
   avatarUrl: string | null
): ActorRef {
   return {
      type,
      id,
      name: name ?? (type === 'user' ? 'Unknown user' : 'Agent'),
      avatarUrl: avatarUrl ?? null,
   };
}

/** The wire shape, shared by the routes and the event payload. */
export function serializeComment(comment: Comment): Record<string, unknown> {
   return {
      id: comment.id,
      issueId: comment.issueId,
      body: comment.body,
      author: comment.author,
      parentId: comment.parentId,
      revision: comment.revision,
      resolvedAt: comment.resolvedAt,
      resolvedBy: comment.resolvedBy,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
   };
}

function classifyWrite(error: unknown): never {
   const code = (error as { code?: string })?.code;
   if (code === '23503') throw new NotFound();
   if (code === '23505' || code === '23P01') throw new Conflict();
   throw error;
}
