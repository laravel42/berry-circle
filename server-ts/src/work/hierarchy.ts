import type { Queryable } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import type { StageGate } from '../runs/auto-dispatch.ts';

/**
 * Parent/child links and stage barriers. A stage is an ordinal among siblings:
 * every sibling in stage <= N must be done or cancelled before stage N+1 is
 * released. Unstaged siblings never block and are never blocked.
 */
export class HierarchyCycle extends Error {
   constructor() {
      super('an issue cannot be nested under its own descendant');
      this.name = 'HierarchyCycle';
   }
}

export class ParentNotFound extends Error {
   constructor() {
      super('parent issue not found');
      this.name = 'ParentNotFound';
   }
}

export async function setParent(
   q: Queryable,
   input: { workspaceId: string; issueId: string; parentId: string | null; stage: number | null }
): Promise<void> {
   if (input.parentId !== null) {
      const [parent] = await q`
         SELECT issue.id FROM issues AS issue
           JOIN boards AS board ON board.id = issue.board_id
          WHERE issue.id = ${input.parentId} AND board.workspace_id = ${input.workspaceId}
            AND issue.deleted_at IS NULL`;
      if (!parent) throw new ParentNotFound();
      const [cycle] = await q`
         WITH RECURSIVE ancestors AS (
            SELECT id, parent_id, 1 AS depth FROM issues WHERE id = ${input.parentId}
            UNION ALL
            SELECT issue.id, issue.parent_id, ancestors.depth + 1
              FROM issues AS issue JOIN ancestors ON issue.id = ancestors.parent_id
             WHERE ancestors.depth < 100
         )
         SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = ${input.issueId}) AS cyclic`;
      if (cycle?.cyclic === true) throw new HierarchyCycle();
   }
   const result = await q`
      UPDATE issues
         SET parent_id = ${input.parentId},
             stage = ${input.parentId === null ? null : input.stage},
             updated_at = now()
       WHERE id = ${input.issueId} AND deleted_at IS NULL`;
   if (result.count !== 1) throw new NotFound();
}

export async function childIssueIds(q: Queryable, parentId: string): Promise<string[]> {
   const rows = await q`
      SELECT id FROM issues
       WHERE parent_id = ${parentId} AND deleted_at IS NULL
       ORDER BY stage ASC NULLS LAST, sort_order ASC, created_at ASC, id ASC
       LIMIT 200`;
   return rows.map((row) => row.id as string);
}

export async function blockedByEarlierStage(q: Queryable, issueId: string): Promise<boolean> {
   const [row] = await q`
      SELECT EXISTS (
         SELECT 1
           FROM issues AS me
           JOIN issues AS sibling
             ON sibling.parent_id = me.parent_id AND sibling.id <> me.id AND sibling.deleted_at IS NULL
          WHERE me.id = ${issueId} AND me.parent_id IS NOT NULL AND me.stage IS NOT NULL
            AND sibling.stage IS NOT NULL AND sibling.stage < me.stage
            AND sibling.status NOT IN ('done', 'cancelled')
      ) AS blocked`;
   return row?.blocked === true;
}

/**
 * The siblings released by `issueId` finishing: the whole next stage, when
 * every sibling at or below this issue's stage is done or cancelled.
 */
export async function nextStageReady(q: Queryable, issueId: string): Promise<string[]> {
   const rows = await q`
      WITH me AS (
         SELECT parent_id, stage FROM issues
          WHERE id = ${issueId} AND parent_id IS NOT NULL AND stage IS NOT NULL
      ),
      still_open AS (
         SELECT 1 FROM issues AS sibling, me
          WHERE sibling.parent_id = me.parent_id AND sibling.stage <= me.stage
            AND sibling.deleted_at IS NULL AND sibling.status NOT IN ('done', 'cancelled')
      ),
      next_stage AS (
         SELECT min(sibling.stage) AS stage FROM issues AS sibling, me
          WHERE sibling.parent_id = me.parent_id AND sibling.stage > me.stage
            AND sibling.deleted_at IS NULL
      )
      SELECT sibling.id
        FROM issues AS sibling, me, next_stage
       WHERE NOT EXISTS (SELECT 1 FROM still_open)
         AND sibling.parent_id = me.parent_id AND sibling.stage = next_stage.stage
         AND sibling.deleted_at IS NULL
       ORDER BY sibling.sort_order, sibling.id`;
   return rows.map((row) => row.id as string);
}

export function stageGate(q: Queryable): StageGate {
   return { blockedByEarlierStage: (issueId: string) => blockedByEarlierStage(q, issueId) };
}
