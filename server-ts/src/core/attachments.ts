import { toRFC3339, type Sql } from '../db/pool.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import { allows, type Permission } from '../identity/roles.ts';
import type { ActorRef } from './comments.ts';

/**
 * Attachments, ported from server/internal/repository/collaboration.
 *
 * Only the read half moved. Uploading is a multipart body staged to disk with
 * an idempotency fingerprint taken over the file's own bytes, and nothing in
 * the product uses it — see server-ts/SCOPE.md.
 *
 * Bytes live in object storage and identity lives here, the same split the run
 * artifacts use. A row is only visible once its object is `ready`: the row is
 * written before the upload so a crash leaves a pending row nobody sees rather
 * than a link to a file that never arrived.
 */

export interface Attachment {
   id: string;
   workspaceId: string;
   issueId: string;
   commentId: string | null;
   fileName: string;
   contentType: string;
   sizeBytes: number;
   uploader: ActorRef | null;
   storageKey: string;
   createdAt: string;
}

const ATTACHMENT_COLUMNS = `
   attachment.id, board.workspace_id, attachment.issue_id, attachment.comment_id,
   COALESCE(attachment.uploader_type::text, 'user') AS uploader_type,
   COALESCE(attachment.uploader_id, attachment.uploader_agent_id) AS uploader_id,
   attachment.uploader_name,
   COALESCE(uploader.avatar_url, uploader_agent.avatar_url) AS uploader_avatar,
   attachment.file_name, attachment.content_type, attachment.size_bytes,
   attachment.storage_key, attachment.created_at`;

/**
 * Both kinds of uploader are joined, always.
 *
 * An agent uploads too — a run's artifacts arrive this way — and joining only
 * users would render every agent's upload with no avatar and, before the
 * denormalised name column, no name either.
 */
const UPLOADER_JOINS = `
   LEFT JOIN users AS uploader
     ON attachment.uploader_type = 'user' AND uploader.id = attachment.uploader_id
   LEFT JOIN agents AS uploader_agent
     ON attachment.uploader_type = 'agent' AND uploader_agent.id = attachment.uploader_agent_id`;

export class AttachmentRepository {
   private readonly sql: Sql;

   constructor(sql: Sql) {
      this.sql = sql;
   }

   /**
    * One ready attachment the caller may reach.
    *
    * Authorization is part of the same query rather than a check before it:
    * the row is only returned when the caller's membership joins to it, so an
    * attachment in another workspace is not found rather than forbidden.
    */
   async get(actorId: string, attachmentId: string, permission: Permission): Promise<Attachment> {
      const [row] = await this.sql`
         SELECT ${this.sql.unsafe(ATTACHMENT_COLUMNS)}, membership.role::text AS role
           FROM attachments AS attachment
           JOIN issues AS issue ON issue.id = attachment.issue_id
           JOIN boards AS board ON board.id = issue.board_id
           JOIN workspaces AS workspace
             ON workspace.id = board.workspace_id AND workspace.deleted_at IS NULL
           JOIN workspace_memberships AS membership
             ON membership.workspace_id = workspace.id AND membership.user_id = ${actorId}
           ${this.sql.unsafe(UPLOADER_JOINS)}
          WHERE attachment.id = ${attachmentId} AND attachment.state = 'ready'`;
      if (!row) throw new NotFound();
      if (!allows(row.role as string, permission)) throw new Forbidden();
      return toAttachment(row);
   }

   /**
    * Removes the row and reports the object to delete.
    *
    * The row goes first and the object after, deliberately: an object left
    * behind is unreferenced storage, which costs money, while a row left
    * behind points at something that is not there, which costs correctness.
    */
   async delete(actorId: string, attachmentId: string): Promise<Attachment> {
      const attachment = await this.get(actorId, attachmentId, 'product.write');
      await this.sql`DELETE FROM attachments WHERE id = ${attachmentId}`;
      return attachment;
   }
}

function toAttachment(row: Record<string, unknown>): Attachment {
   const uploaderId = row.uploader_id as string | null;
   return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      issueId: row.issue_id as string,
      commentId: (row.comment_id as string | null) ?? null,
      fileName: row.file_name as string,
      contentType: row.content_type as string,
      sizeBytes: Number(row.size_bytes),
      uploader: uploaderId
         ? {
              type: row.uploader_type as string,
              id: uploaderId,
              // The name is denormalised onto the row so an upload keeps its
              // author after the account is gone.
              name: (row.uploader_name as string | null) ?? 'Unknown user',
              avatarUrl: (row.uploader_avatar as string | null) ?? null,
           }
         : null,
      storageKey: row.storage_key as string,
      createdAt: toRFC3339(row.created_at as string) ?? '',
   };
}
