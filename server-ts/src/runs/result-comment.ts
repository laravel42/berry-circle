import { randomUUID } from 'node:crypto';
import { toRFC3339, type Sql } from '../db/pool.ts';
import { truncateUtf8 } from '../agents/runtime/utf8.ts';

export { truncateUtf8 };

/**
 * The agent's final message, posted on the task as its comment.
 *
 * The one write a run makes outside its own ledger. It matters more than it
 * looks: the run ledger is where an operator looks, and the comment is where
 * the person who
 * asked for the work looks. A run that finishes without one has done its work
 * somewhere nobody reads.
 */

const MAX_BODY_BYTES = 100_000;
const TRUNCATION_NOTE =
   "\n\n[Truncated by Berry: the full text is in the run's output events.]";

export interface ResultComment {
   id: string;
   issueId: string;
   body: string;
   createdAt: string;
}

/**
 * Writes the comment and the event that tells open boards about it.
 *
 * Both in one transaction, for the same reason the ledger is: an announced
 * comment that then rolls back is a comment people saw and cannot open.
 */
export async function postRunResult(
   sql: Sql,
   params: {
      issueId: string;
      agentId: string;
      text: string;
      /** True when the text was already cut, so the note is added regardless. */
      cut: boolean;
      occurredAt: string;
      newId?: () => string;
   }
): Promise<ResultComment | null> {
   const newId = params.newId ?? randomUUID;
   const body = commentBody(params.text, params.cut);
   if (body === '') return null;

   const id = newId();
   const eventId = newId();

   return sql.begin(async (transaction) => {
      const tx = transaction as unknown as Sql;
      // KEY SHARE rather than UPDATE: this blocks the issue being deleted
      // while the comment is written without blocking ordinary edits to it.
      const [issue] = await tx`
         SELECT issue.id, board.id AS board_id, board.workspace_id
           FROM issues AS issue
           JOIN boards AS board ON board.id = issue.board_id
          WHERE issue.id = ${params.issueId} AND issue.deleted_at IS NULL
          FOR KEY SHARE OF issue`;
      if (!issue) return null;

      await tx`
         INSERT INTO comments (
            id, issue_id, author_type, author_id, body, parent_id, created_at, updated_at
         ) VALUES (
            ${id}, ${params.issueId}, 'agent'::assignee_type, ${params.agentId},
            ${body}, NULL, ${params.occurredAt}, ${params.occurredAt}
         )`;

      const [row] = await tx`
         SELECT c.id, c.issue_id, c.body, c.author_type::text AS author_type, c.author_id,
                COALESCE(author.name, author_agent.name) AS author_name,
                COALESCE(author.avatar_url, author_agent.avatar_url) AS author_avatar,
                c.parent_id, c.revision, c.resolved_at, c.resolved_by,
                c.created_at, c.updated_at
           FROM comments AS c
           LEFT JOIN users AS author
             ON c.author_type = 'user' AND author.id = c.author_id
           -- Agents author comments too, and a users join alone renders those
           -- with no name at all.
           LEFT JOIN agents AS author_agent
             ON c.author_type = 'agent' AND author_agent.id = c.author_id
          WHERE c.id = ${id}`;
      if (!row) return null;

      const payload = {
         comment: {
            id: row.id,
            issueId: row.issue_id,
            body: row.body,
            author: {
               type: row.author_type,
               id: row.author_id,
               name: (row.author_name as string | null) ?? 'Agent',
               avatarUrl: (row.author_avatar as string | null) ?? null,
            },
            parentId: (row.parent_id as string | null) ?? null,
            revision: Number(row.revision),
            resolvedAt: toRFC3339(row.resolved_at as string | null),
            resolvedBy: null,
            createdAt: toRFC3339(row.created_at as string),
            updatedAt: toRFC3339(row.updated_at as string),
         },
      };

      await tx`
         INSERT INTO outbox_events (
            id, topic, aggregate_type, aggregate_id, workspace_id, board_id,
            payload, occurred_at, available_at
         ) VALUES (
            ${eventId}, 'comment.created', 'comment', ${id},
            ${issue.workspace_id as string}, ${issue.board_id as string},
            ${tx.json({
               id: eventId,
               type: 'comment.created',
               occurredAt: toRFC3339(params.occurredAt),
               workspaceId: issue.workspace_id,
               // boardId and issueId sit beside the collaboration fields so a
               // board stream can replay a comment without reaching into its
               // payload.
               boardId: issue.board_id,
               issueId: params.issueId,
               aggregateType: 'comment',
               aggregateId: id,
               payload,
            } as never)},
            ${params.occurredAt}, ${params.occurredAt}
         )`;

      return {
         id,
         issueId: params.issueId,
         body,
         createdAt: toRFC3339(params.occurredAt) ?? params.occurredAt,
      };
   }) as Promise<ResultComment | null>;
}

/** Bounded by bytes, with the note counted against the limit rather than added to it. */
export function commentBody(text: string, cut: boolean): string {
   if (!cut && Buffer.byteLength(text, 'utf8') <= MAX_BODY_BYTES) return text;
   if (text === '') return '';
   return (
      truncateUtf8(text, MAX_BODY_BYTES - Buffer.byteLength(TRUNCATION_NOTE, 'utf8')) +
      TRUNCATION_NOTE
   );
}

