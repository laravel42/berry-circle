import { toRFC3339, type Queryable } from '../db/pool.ts';

/**
 * An issue's timeline, read from `outbox_events` by the envelope's issueId.
 * No projection table: every issue, comment and work-tracking change already
 * writes one outbox row in the transaction that made it.
 */
export interface ActivityActor {
   type: string;
   id: string;
   name: string | null;
   avatarUrl: string | null;
}

export interface ActivityEntry {
   id: string;
   type: string;
   occurredAt: string;
   actor: ActivityActor | null;
   changedFields: string[];
   previousStatus: string | null;
   status: string | null;
   commentId: string | null;
   details: Record<string, unknown>;
}

interface RawActor {
   type: string;
   id: string;
}

function readActor(inner: Record<string, unknown>): RawActor | null {
   const direct = inner.actor as RawActor | undefined;
   if (direct && typeof direct.id === 'string') return { type: direct.type, id: direct.id };
   const comment = inner.comment as { author?: RawActor } | undefined;
   if (comment?.author && typeof comment.author.id === 'string') {
      return { type: comment.author.type, id: comment.author.id };
   }
   return null;
}

export async function listIssueActivity(
   q: Queryable,
   input: {
      workspaceId: string;
      issueId: string;
      after: { createdAt: string; id: string } | null;
      limit: number;
   }
): Promise<ActivityEntry[]> {
   const rows = await q`
      SELECT id, topic, occurred_at, payload FROM outbox_events
       WHERE workspace_id = ${input.workspaceId}
         AND payload ? 'issueId' AND payload ->> 'issueId' = ${input.issueId}
         AND (${input.after === null} OR (occurred_at, id) >
              (${input.after?.createdAt ?? null}::timestamptz, ${input.after?.id ?? null}::uuid))
       ORDER BY occurred_at ASC, id ASC
       LIMIT ${input.limit}`;

   const raw = rows.map((row) => {
      const envelope = row.payload as Record<string, unknown>;
      const inner = (envelope.payload ?? {}) as Record<string, unknown>;
      return { row, inner, actor: readActor(inner) };
   });

   const userIds = [...new Set(raw.flatMap((entry) => (entry.actor?.type === 'user' ? [entry.actor.id] : [])))];
   const agentIds = [...new Set(raw.flatMap((entry) => (entry.actor?.type === 'agent' ? [entry.actor.id] : [])))];
   const names = new Map<string, { name: string | null; avatarUrl: string | null }>();
   if (userIds.length > 0 || agentIds.length > 0) {
      const people = await q`
         SELECT 'user' AS type, id::text AS id, name, avatar_url FROM users
          WHERE id = ANY(${userIds}::uuid[])
         UNION ALL
         SELECT 'agent', id::text, name, avatar_url FROM agents
          WHERE id = ANY(${agentIds}::uuid[]) AND workspace_id = ${input.workspaceId}`;
      for (const person of people) {
         names.set(`${person.type as string}:${person.id as string}`, {
            name: (person.name as string | null) ?? null,
            avatarUrl: (person.avatar_url as string | null) ?? null,
         });
      }
   }

   return raw.map(({ row, inner, actor }) => {
      const issue = inner.issue as { status?: string } | undefined;
      const comment = inner.comment as { id?: string } | undefined;
      const known = actor ? names.get(`${actor.type}:${actor.id}`) : undefined;
      const details = { ...inner };
      delete details.issue;
      delete details.comment;
      delete details.actor;
      return {
         id: row.id as string,
         type: row.topic as string,
         occurredAt: toRFC3339(row.occurred_at as string) ?? '',
         actor: actor
            ? { type: actor.type, id: actor.id, name: known?.name ?? null, avatarUrl: known?.avatarUrl ?? null }
            : null,
         changedFields: Array.isArray(inner.changedFields) ? (inner.changedFields as string[]) : [],
         previousStatus: typeof inner.previousStatus === 'string' ? inner.previousStatus : null,
         status: issue?.status ?? null,
         commentId: comment?.id ?? null,
         details,
      };
   });
}
