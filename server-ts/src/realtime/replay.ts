import { toRFC3339, type Sql } from '../db/pool.ts';

/**
 * Durable event replay
 * and repository/runs/replay.go.
 *
 * A stream never reads Valkey. Valkey is a wakeup — it says something happened
 * — and `outbox_events` is what happened. That split is why a client that was
 * disconnected for ten minutes gets the same answer as one that never left,
 * and why losing the relay costs latency rather than facts.
 */

/** What `?boardId=` replays: run lifecycle, issue mutations, new comments. */
export const BOARD_TOPICS = [
   'run.created', 'run.started', 'run.output.delta',
   'run.tool.started', 'run.tool.completed',
   // The command and delivery facts, which the ledger wrote all along and this
   // list did not name — so a run that was mostly shell commands looked idle
   // in the browser until the page refetched.
   'run.command.started', 'run.command.output', 'run.command.completed',
   'run.repository.ready', 'run.verified', 'run.delivered',
   'run.usage.updated', 'run.completed', 'run.failed', 'run.cancelled',
   'issue.created', 'issue.updated', 'issue.assigned',
   'issue.started', 'issue.completed', 'issue.deleted',
   'comment.created',
   // A linked pull request or its checks changed; the issue page refetches.
   'github.pull_request.updated',
] as const;

/**
 * What `?workspaceId=` replays: the facts belonging to no board, plus the
 * issue and agent moments a workspace-wide consumer needs to notice.
 *
 * Spelled out rather than derived, because the replay matches topics exactly:
 * a topic missing from this list is a fact that silently never arrives.
 */
export const WORKSPACE_TOPICS = [
   'goal.created', 'goal.updated', 'goal.started', 'goal.completed', 'goal.cancelled', 'goal.archived',
   'approval.requested', 'approval.approved', 'approval.rejected', 'approval.expired',
   'plan.generated', 'plan.updated', 'plan.blocked', 'plan.patched',
   'plan.approved', 'plan.compiled', 'plan.compile_failed',
   'issue.created', 'issue.completed', 'issue.deleted',
   'agent.started', 'agent.completed', 'agent.failed',
   'artifact.created',
   'plugin.installed', 'plugin.updated', 'plugin.uninstalled',
   'github.settings.updated', 'github.repositories.updated',
   'github.connection.updated', 'github.pull_request.updated',
   // Workspace-level like goals (boardId null): the Usage page, the Dashboard
   // and the usage panels refresh on it.
   'usage.recorded',
   'autopilot.created', 'autopilot.updated', 'autopilot.archived',
   'autopilot.run.created', 'autopilot.delivery.received',
] as const;

/** `(occurred_at, id)` — the pair that orders both replays. */
export interface OutboxCursor {
   occurredAt: string;
   id: string;
}

export interface ReplayEvent {
   id: string;
   type: string;
   occurredAt: string;
   workspaceId: string | null;
   boardId: string | null;
   issueId: string | null;
   runId: string | null;
   sequence: number | null;
   payload: unknown;
}

/** The cursor names an event outside this stream, or older than retention. */
export class CursorExpired extends Error {
   constructor() {
      super('event cursor expired');
      this.name = 'CursorExpired';
   }
}

export type OutboxScope = 'board_id' | 'workspace_id';

export class ReplayRepository {
   private readonly sql: Sql;

   constructor(sql: Sql) {
      this.sql = sql;
   }

   /**
    * Turns an opaque event id into the ordering key that follows it.
    *
    * Scoped and topic-filtered on purpose: a cursor from a different stream
    * over the same workspace names a real event, and resuming from it would
    * silently skip everything this stream carries in between.
    */
   async resolveCursor(
      scope: OutboxScope,
      scopeId: string,
      topics: readonly string[],
      eventId: string,
      cutoff: string
   ): Promise<OutboxCursor> {
      const [row] = await this.sql`
         SELECT occurred_at, id
           FROM outbox_events
          WHERE id = ${eventId}
            AND ${this.sql.unsafe(scope)} = ${scopeId}
            AND occurred_at >= ${cutoff}
            AND topic = ANY(${topics as unknown as string[]}::text[])`;
      if (!row) throw new CursorExpired();
      return { occurredAt: row.occurred_at as string, id: row.id as string };
   }

   /** One batch, oldest first, after an optional cursor and inside retention. */
   async replay(
      scope: OutboxScope,
      scopeId: string,
      topics: readonly string[],
      after: OutboxCursor | null,
      cutoff: string,
      limit: number
   ): Promise<ReplayEvent[]> {
      const rows = await this.sql`
         SELECT occurred_at, id, workspace_id, board_id, payload
           FROM outbox_events
          WHERE ${this.sql.unsafe(scope)} = ${scopeId}
            AND occurred_at >= ${cutoff}
            AND topic = ANY(${topics as unknown as string[]}::text[])
            AND (${after === null} OR (occurred_at, id) > (${after?.occurredAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
          ORDER BY occurred_at ASC, id ASC
          LIMIT ${limit}`;

      return rows.map((row) => {
         const event = decodeEnvelope(row.payload, row.id as string);
         // The columns are the scope of record. Rows written before migration
         // 019 carry no boardId in their envelope, and comment envelopes never
         // carried one, but the backfill filled the column for both.
         if (row.workspace_id !== null) event.workspaceId = row.workspace_id as string;
         if (row.board_id !== null) event.boardId = row.board_id as string;
         event.occurredAt = toRFC3339(row.occurred_at as string) ?? event.occurredAt;
         return event;
      });
   }
}

/**
 * One stored envelope, whichever lane wrote it.
 *
 * Three shapes share this column — the run lane (boardId/issueId/runId/
 * sequence), the collaboration lane (workspaceId/aggregateType/aggregateId)
 * and the issue lane, which writes both — so every field is optional and the
 * absent ones simply stay null.
 */
export function decodeEnvelope(payload: unknown, expectedId: string): ReplayEvent {
   if (payload === null || typeof payload !== 'object') {
      throw new Error('outbox event envelope is not an object');
   }
   const envelope = payload as Record<string, unknown>;
   if (envelope.id !== expectedId) {
      // The row and its envelope disagreeing means one of them was written by
      // something that did not know the shape, and replaying it would hand a
      // client an id that resumes from somewhere else.
      throw new Error('outbox event envelope ID mismatch');
   }
   return {
      id: envelope.id as string,
      type: (envelope.type as string) ?? '',
      occurredAt: (envelope.occurredAt as string) ?? '',
      workspaceId: (envelope.workspaceId as string | null) ?? null,
      boardId: (envelope.boardId as string | null) ?? null,
      issueId: (envelope.issueId as string | null) ?? issueIdFromPayload(envelope.payload),
      runId: (envelope.runId as string | null) ?? null,
      sequence: envelope.sequence === null || envelope.sequence === undefined
         ? null
         : Number(envelope.sequence),
      payload: envelope.payload ?? null,
   };
}

/**
 * Recovers the issue for collaboration-lane envelopes.
 *
 * They name it inside the payload rather than beside it: comments under
 * `comment.issueId`, attachments and approvals under `issueId`. Without this a
 * board stream would deliver a comment with no issue attached to it, and the
 * client could not place it.
 */
function issueIdFromPayload(payload: unknown): string | null {
   if (payload === null || typeof payload !== 'object') return null;
   const body = payload as { issueId?: unknown; comment?: { issueId?: unknown } };
   if (typeof body.issueId === 'string') return body.issueId;
   if (typeof body.comment?.issueId === 'string') return body.comment.issueId;
   return null;
}
