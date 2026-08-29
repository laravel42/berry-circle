import { toRFC3339, type Sql } from '../db/pool.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import { allows, type Permission } from '../identity/roles.ts';
import type { ActorRef } from './comments.ts';

/**
 * Attachments.
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
    * An issue's ready attachments, newest first.
    *
    * Same shape of authorization as `get`: the membership is a join, so an
    * issue in another workspace lists nothing rather than being refused.
    */
   async listByIssue(
      actorId: string,
      issueId: string,
      after: { createdAt: string; id: string } | null,
      limit: number
   ): Promise<Attachment[]> {
      const rows = await this.sql`
         SELECT ${this.sql.unsafe(ATTACHMENT_COLUMNS)}
           FROM attachments AS attachment
           JOIN issues AS issue ON issue.id = attachment.issue_id
           JOIN boards AS board ON board.id = issue.board_id
           JOIN workspaces AS workspace
             ON workspace.id = board.workspace_id AND workspace.deleted_at IS NULL
           JOIN workspace_memberships AS membership
             ON membership.workspace_id = workspace.id AND membership.user_id = ${actorId}
           ${this.sql.unsafe(UPLOADER_JOINS)}
          WHERE attachment.issue_id = ${issueId} AND attachment.state = 'ready'
            AND (${after === null} OR (attachment.created_at, attachment.id) <
                 (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
          ORDER BY attachment.created_at DESC, attachment.id DESC
          LIMIT ${limit}`;
      return rows.map(toAttachment);
   }

   /**
    * Records an upload that is already in the object store.
    *
    * `ready` from the start, not `pending`: the row is written after the
    * object exists, so there is no window in which a listing shows a file the
    * store does not have. The reverse — an object with no row — is
    * unreferenced storage, which is a cost rather than a lie.
    */
   async record(input: {
      id: string;
      issueId: string;
      commentId: string | null;
      uploaderId: string;
      uploaderName: string;
      fileName: string;
      contentType: string;
      sizeBytes: number;
      checksumSha256: string;
      storageKey: string;
   }): Promise<void> {
      await this.sql`
         INSERT INTO attachments (id, issue_id, comment_id, uploader_id, uploader_type,
                                  uploader_name, file_name, content_type, size_bytes,
                                  checksum_sha256, storage_key, state, ready_at)
         VALUES (${input.id}, ${input.issueId}, ${input.commentId}, ${input.uploaderId}, 'user',
                 ${input.uploaderName}, ${input.fileName}, ${input.contentType},
                 ${input.sizeBytes}, decode(${input.checksumSha256}, 'hex'),
                 ${input.storageKey}, 'ready', now())`;
   }

   /**
    * An upload this issue already has, by content.
    *
    * The fingerprint is the file's own bytes and its name, not a header the
    * client chose: someone who drops the same screenshot twice means it once,
    * and a retried request after a dropped connection is the same upload
    * rather than a second one.
    */
   async findByChecksum(
      issueId: string,
      checksumSha256: string,
      fileName: string
   ): Promise<string | null> {
      const [row] = await this.sql`
         SELECT id FROM attachments
          WHERE issue_id = ${issueId} AND state = 'ready'
            AND checksum_sha256 = decode(${checksumSha256}, 'hex')
            AND file_name = ${fileName}
          LIMIT 1`;
      return row ? (row.id as string) : null;
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
