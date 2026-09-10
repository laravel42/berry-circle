import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/pool.ts';

/**
 * Autopilot facts on the workspace stream.
 *
 * Same envelope as a goal's (core/goals.ts): no board, so it replays on the
 * workspace stream only, and the aggregate is the autopilot so a detail page
 * can tell whether a frame is about the one it shows.
 */

export const AUTOPILOT_TOPICS = [
   'autopilot.created',
   'autopilot.updated',
   'autopilot.archived',
   'autopilot.run.created',
   'autopilot.delivery.received',
] as const;

export type AutopilotTopic = (typeof AUTOPILOT_TOPICS)[number];

export async function writeAutopilotEvent(
   tx: Sql,
   input: {
      workspaceId: string;
      topic: AutopilotTopic;
      autopilotId: string;
      payload: Record<string, unknown>;
      occurredAt: string;
   }
): Promise<string> {
   const id = randomUUID();
   const envelope = {
      id,
      type: input.topic,
      occurredAt: input.occurredAt,
      workspaceId: input.workspaceId,
      boardId: null,
      aggregateType: 'autopilot',
      aggregateId: input.autopilotId,
      payload: { autopilotId: input.autopilotId, ...input.payload },
   };
   await tx`
      INSERT INTO outbox_events (
         id, topic, aggregate_type, aggregate_id, workspace_id, board_id,
         payload, occurred_at, available_at
      ) VALUES (
         ${id}, ${input.topic}, 'autopilot', ${input.autopilotId}, ${input.workspaceId}, NULL,
         ${tx.json(envelope as never)}, ${input.occurredAt}, ${input.occurredAt}
      )`;
   return id;
}
