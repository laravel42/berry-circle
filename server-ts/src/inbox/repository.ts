import { toRFC3339, type Sql } from '../db/pool.ts';

/**
 * One person's notifications in one workspace.
 *
 * Every row belongs to a recipient, and every query here is scoped to the
 * caller's own id — not because the API asks for it, but because there is no
 * such thing as reading someone else's inbox. The scoping is in the SQL rather
 * than in a check above it, so a route that forgot to filter cannot exist.
 *
 * Nothing writes rows here yet; they are projected from workspace facts by a
 * path that has not been ported. Reading, marking read and archiving are what
 * the shell needs, and they work against whatever produced the rows.
 */

export interface InboxItem {
   id: string;
   workspaceId: string;
   recipientId: string;
   eventType: string;
   category: string;
   severity: string;
   issueId: string | null;
   issueStatus: string | null;
   issueIdentifier: string | null;
   actorType: string | null;
   actorId: string | null;
   title: string;
   body: string | null;
   /**
    * What the projection recorded about the event: the field that changed,
    * the comment it was about, the prompt an agent was given. The shape
    * varies by event, so a reader takes what it recognizes and ignores the
    * rest rather than being typed into a shape no writer agreed to.
    */
   details: Record<string, unknown>;
   read: boolean;
   archived: boolean;
   createdAt: string;
   approvalId: string | null;
   goalId: string | null;
   planId: string | null;
}

export interface InboxCursor {
   createdAt: string;
   id: string;
}

/** `active` hides what was archived; `archived` shows only it. */
export type InboxState = 'active' | 'archived' | 'all';

export type InboxAction = 'read' | 'unread' | 'archive' | 'unarchive';

const COLUMNS = `item.id, item.workspace_id, item.recipient_id, item.event_type, item.category,
   item.severity, item.issue_id, item.actor_type, item.actor_id, item.title, item.body,
   item.details, item.read_at, item.archived_at, item.created_at,
   item.approval_id, item.goal_id, item.plan_id,
   issue.status::text AS issue_status,
   berry_issue_identifier(board.workspace_id, issue.number) AS issue_identifier`;

const SOURCE = `FROM inbox_items AS item
   LEFT JOIN issues AS issue ON issue.id = item.issue_id AND issue.deleted_at IS NULL
   LEFT JOIN boards AS board ON board.id = issue.board_id`;

export class InboxRepository {
   readonly #sql: Sql;
   readonly #clock: () => Date;

   constructor(sql: Sql, options: { clock?: () => Date } = {}) {
      this.#sql = sql;
      this.#clock = options.clock ?? (() => new Date());
   }

   async list(input: {
      workspaceId: string;
      recipientId: string;
      state: InboxState;
      unreadOnly?: boolean;
      after: InboxCursor | null;
      limit: number;
   }): Promise<InboxItem[]> {
      const rows = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)} ${this.#sql.unsafe(SOURCE)}
          WHERE item.workspace_id = ${input.workspaceId}
            AND item.recipient_id = ${input.recipientId}
            AND (${input.state === 'all'}
                 OR (${input.state === 'active'} AND item.archived_at IS NULL)
                 OR (${input.state === 'archived'} AND item.archived_at IS NOT NULL))
            AND (${input.unreadOnly !== true} OR item.read_at IS NULL)
            AND (${input.after === null} OR (item.created_at, item.id) <
                 (${input.after?.createdAt ?? null}::timestamptz, ${input.after?.id ?? null}::uuid))
          ORDER BY item.created_at DESC, item.id DESC
          LIMIT ${input.limit}`;
      return rows.map(toItem);
   }

   /**
    * What the badge shows.
    *
    * Unread *and* not archived: archiving something without reading it is a
    * way of saying you are done with it, and a badge that kept counting it
    * would be asking for a second decision.
    */
   async unreadCount(workspaceId: string, recipientId: string): Promise<number> {
      const [row] = await this.#sql`
         SELECT count(*)::int AS n FROM inbox_items
          WHERE workspace_id = ${workspaceId} AND recipient_id = ${recipientId}
            AND read_at IS NULL AND archived_at IS NULL`;
      return Number(row!.n);
   }

   /**
    * Applies an action to items the caller owns.
    *
    * Returns how many rows it actually touched. Ids belonging to someone else
    * are not an error and not a refusal — they simply match nothing, which is
    * both the safe answer and the one that does not reveal whether a given id
    * exists.
    */
   async apply(input: {
      workspaceId: string;
      recipientId: string;
      itemIds: string[];
      action: InboxAction;
   }): Promise<number> {
      if (input.itemIds.length === 0) return 0;
      const now = this.#clock().toISOString();
      const rows = await this.#sql`
         UPDATE inbox_items
            SET read_at = CASE
                   WHEN ${input.action === 'read'} THEN COALESCE(read_at, ${now}::timestamptz)
                   WHEN ${input.action === 'unread'} THEN NULL
                   ELSE read_at
                END,
                archived_at = CASE
                   WHEN ${input.action === 'archive'} THEN COALESCE(archived_at, ${now}::timestamptz)
                   WHEN ${input.action === 'unarchive'} THEN NULL
                   ELSE archived_at
                END
          WHERE workspace_id = ${input.workspaceId}
            AND recipient_id = ${input.recipientId}
            AND id = ANY(${input.itemIds}::uuid[])
          RETURNING id`;
      return rows.length;
   }
}

function isObject(value: unknown): value is Record<string, unknown> {
   return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toItem(row: Record<string, unknown>): InboxItem {
   return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      recipientId: row.recipient_id as string,
      eventType: row.event_type as string,
      category: row.category as string,
      severity: row.severity as string,
      issueId: (row.issue_id as string | null) ?? null,
      issueStatus: (row.issue_status as string | null) ?? null,
      issueIdentifier: (row.issue_identifier as string | null) ?? null,
      actorType: (row.actor_type as string | null) ?? null,
      actorId: (row.actor_id as string | null) ?? null,
      title: row.title as string,
      body: (row.body as string | null) ?? null,
      details: isObject(row.details) ? row.details : {},
      // Booleans on the wire, timestamps in the column: the page asks whether
      // it was read, and when is nobody's question.
      read: row.read_at !== null && row.read_at !== undefined,
      archived: row.archived_at !== null && row.archived_at !== undefined,
      createdAt: toRFC3339(row.created_at as string)!,
      approvalId: (row.approval_id as string | null) ?? null,
      goalId: (row.goal_id as string | null) ?? null,
      planId: (row.plan_id as string | null) ?? null,
   };
}
