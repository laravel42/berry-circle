import { toRFC3339, type Queryable } from '../db/pool.ts';

/**
 * Who follows an issue, and the inbox rows a change produces for them.
 *
 * Inbox rows are written directly, keyed by the outbox event that caused them,
 * so `inbox_items_recipient_source_key` makes a retried write a no-op.
 */
export const SUBSCRIPTION_REASONS = ['creator', 'assignee', 'commenter', 'mentioned', 'manual'] as const;
export type SubscriptionReason = (typeof SUBSCRIPTION_REASONS)[number];

export type InboxCategory =
   | 'assignments'
   | 'statusChanges'
   | 'comments'
   | 'mentions'
   | 'updates'
   | 'agentActivity';

export interface Subscriber {
   userId: string;
   name: string | null;
   avatarUrl: string | null;
   reason: SubscriptionReason;
   subscribedAt: string;
}

export async function listSubscribers(q: Queryable, issueId: string): Promise<Subscriber[]> {
   const rows = await q`
      SELECT subscriber.user_id, person.name, person.avatar_url, subscriber.reason, subscriber.created_at
        FROM issue_subscribers AS subscriber
        JOIN users AS person ON person.id = subscriber.user_id
       WHERE subscriber.issue_id = ${issueId}
       ORDER BY subscriber.created_at, subscriber.user_id`;
   return rows.map((row) => ({
      userId: row.user_id as string,
      name: (row.name as string | null) ?? null,
      avatarUrl: (row.avatar_url as string | null) ?? null,
      reason: row.reason as SubscriptionReason,
      subscribedAt: toRFC3339(row.created_at as string) ?? '',
   }));
}

export async function isSubscribed(q: Queryable, issueId: string, userId: string): Promise<boolean> {
   const rows = await q`
      SELECT 1 FROM issue_subscribers WHERE issue_id = ${issueId} AND user_id = ${userId}`;
   return rows.length === 1;
}

/**
 * Non-members are skipped rather than refused: an automatic source (a mention
 * of someone who left) must not fail the write that triggered it.
 */
export async function subscribe(
   q: Queryable,
   input: { workspaceId: string; issueIds: string[]; userIds: string[]; reason: SubscriptionReason }
): Promise<number> {
   if (input.issueIds.length === 0 || input.userIds.length === 0) return 0;
   const result = await q`
      INSERT INTO issue_subscribers (workspace_id, issue_id, user_id, reason)
      SELECT ${input.workspaceId}, target_issue.id, member.user_id, ${input.reason}
        FROM unnest(${input.issueIds}::uuid[]) AS target_issue(id)
        CROSS JOIN unnest(${input.userIds}::uuid[]) AS target_user(id)
        JOIN workspace_memberships AS member
          ON member.workspace_id = ${input.workspaceId} AND member.user_id = target_user.id
      ON CONFLICT (issue_id, user_id) DO NOTHING`;
   return result.count;
}

export async function unsubscribe(
   q: Queryable,
   input: { issueIds: string[]; userId: string }
): Promise<number> {
   if (input.issueIds.length === 0) return 0;
   const result = await q`
      DELETE FROM issue_subscribers
       WHERE issue_id = ANY(${input.issueIds}::uuid[]) AND user_id = ${input.userId}`;
   return result.count;
}

export async function subtreeIssueIds(q: Queryable, rootId: string): Promise<string[]> {
   const rows = await q`
      WITH RECURSIVE tree AS (
         SELECT id, 0 AS depth FROM issues WHERE id = ${rootId} AND deleted_at IS NULL
         UNION ALL
         SELECT child.id, tree.depth + 1
           FROM issues AS child
           JOIN tree ON child.parent_id = tree.id
          WHERE child.deleted_at IS NULL AND tree.depth < 100
      )
      SELECT id FROM tree LIMIT 1000`;
   return rows.map((row) => row.id as string);
}

export async function notifySubscribers(
   q: Queryable,
   input: {
      workspaceId: string;
      issueId: string;
      sourceEventId: string;
      eventType: string;
      category: InboxCategory;
      actor: { type: 'user' | 'agent'; id: string };
      title: string;
      body: string | null;
      mentionedUserIds: string[];
   }
): Promise<number> {
   const title = [...input.title].slice(0, 500).join('') || 'Task updated';
   const body = input.body === null ? null : [...input.body].slice(0, 5000).join('');
   const result = await q`
      INSERT INTO inbox_items (
         workspace_id, recipient_id, source_event_id, event_type, category, issue_id,
         actor_type, actor_id, title, body
      )
      SELECT ${input.workspaceId}, recipient.user_id, ${input.sourceEventId}, ${input.eventType},
             recipient.category, ${input.issueId}, ${input.actor.type}, ${input.actor.id},
             ${title}, ${body}
        FROM (
           SELECT candidate.user_id,
                  CASE WHEN candidate.user_id = ANY(${input.mentionedUserIds}::uuid[])
                       THEN 'mentions' ELSE ${input.category} END AS category
             FROM (
                SELECT user_id FROM issue_subscribers WHERE issue_id = ${input.issueId}
                UNION
                SELECT member.user_id FROM workspace_memberships AS member
                 WHERE member.workspace_id = ${input.workspaceId}
                   AND member.user_id = ANY(${input.mentionedUserIds}::uuid[])
             ) AS candidate
        ) AS recipient
       WHERE NOT (${input.actor.type} = 'user' AND recipient.user_id = ${input.actor.id}::uuid)
         AND COALESCE((
            SELECT (preference.preferences -> 'inApp' ->> recipient.category)::boolean
              FROM notification_preferences AS preference
             WHERE preference.workspace_id = ${input.workspaceId}
               AND preference.user_id = recipient.user_id
         ), true)
      ON CONFLICT (recipient_id, source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING`;
   return result.count;
}
