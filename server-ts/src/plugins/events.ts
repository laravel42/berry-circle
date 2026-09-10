import { randomUUID } from 'node:crypto';
import { toRFC3339, type Queryable } from '../db/pool.ts';

export type PluginEventType = 'plugin.installed' | 'plugin.updated' | 'plugin.uninstalled';

/**
 * A workspace fact about a plugin, written in the caller's transaction so it
 * is published exactly when the change commits. No board: plugins belong to
 * the workspace, so these ride the workspace stream only.
 */
export async function appendPluginEvent(
   tx: Queryable,
   type: PluginEventType,
   workspaceId: string,
   installationId: string,
   pluginKey: string,
   occurredAt: string
): Promise<void> {
   const id = randomUUID();
   const envelope = {
      id,
      type,
      occurredAt: toRFC3339(occurredAt),
      workspaceId,
      aggregateType: 'plugin',
      aggregateId: installationId,
      payload: { plugin: { id: installationId, key: pluginKey } },
   };
   await tx`
      INSERT INTO outbox_events (
         id, topic, aggregate_type, aggregate_id, workspace_id, payload, occurred_at, available_at
      ) VALUES (
         ${id}, ${type}, 'plugin', ${installationId}, ${workspaceId},
         ${tx.json(envelope as never)}, ${occurredAt}, ${occurredAt}
      )`;
}
