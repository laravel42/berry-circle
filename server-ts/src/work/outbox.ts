import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import type { Broadcaster } from '../realtime/hub.ts';

/**
 * Work-tracking facts as outbox rows. Same envelope as issue mutations
 * (`aggregateType: 'issue'`, top-level `issueId`), so the SSE stream replays
 * them and the timeline finds them through `outbox_events_issue_timeline_idx`.
 */
export interface EventActor {
   type: 'user' | 'agent';
   id: string;
}

export interface WorkEvent {
   id: string;
   type: string;
   workspaceId: string;
   boardId: string;
   issueId: string;
   payload: string;
   occurredAt: Date;
}

export async function recordIssueEvent(
   q: Queryable,
   input: { issueId: string; type: string; actor: EventActor; payload: Record<string, unknown> }
): Promise<WorkEvent> {
   const [scope] = await q`
      SELECT board.workspace_id, board.id AS board_id
        FROM issues AS issue
        JOIN boards AS board ON board.id = issue.board_id
       WHERE issue.id = ${input.issueId}`;
   if (!scope) throw new NotFound();
   const workspaceId = scope.workspace_id as string;
   const boardId = scope.board_id as string;
   const id = randomUUID();
   const occurredAt = new Date();
   const payload = { ...input.payload, actor: input.actor };
   const envelope = {
      id,
      type: input.type,
      occurredAt: occurredAt.toISOString(),
      workspaceId,
      boardId,
      issueId: input.issueId,
      runId: null,
      sequence: null,
      aggregateType: 'issue',
      aggregateId: input.issueId,
      payload,
   };
   await q`
      INSERT INTO outbox_events (
         id, topic, aggregate_type, aggregate_id, workspace_id, board_id,
         payload, occurred_at, available_at
      ) VALUES (
         ${id}, ${input.type}, 'issue', ${input.issueId}, ${workspaceId}, ${boardId},
         ${q.json(envelope as never)}, ${occurredAt.toISOString()}, ${occurredAt.toISOString()}
      )`;
   return {
      id,
      type: input.type,
      workspaceId,
      boardId,
      issueId: input.issueId,
      payload: JSON.stringify(payload),
      occurredAt,
   };
}

/** Best effort: the row is already committed, so a relay outage costs latency only. */
export async function publishEvents(
   broadcaster: Broadcaster | undefined,
   events: WorkEvent[]
): Promise<void> {
   if (!broadcaster) return;
   for (const event of events) {
      await broadcaster
         .publish({
            id: event.id,
            workspaceId: event.workspaceId,
            boardId: event.boardId,
            type: event.type,
            payload: event.payload,
            occurredAt: event.occurredAt,
         })
         .catch(() => undefined);
   }
}
