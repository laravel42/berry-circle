import { z } from 'zod';
import { toRFC3339, type Queryable } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';

/**
 * The labels on one task.
 *
 * `issue_label_memberships` has existed since the catalogue migration and is
 * read by the issue query builder, so a saved view can already filter by a
 * label — but nothing could ever put one on a task, because no route exposed
 * the table. This is that route's data layer.
 *
 * The write is a replace rather than an add/remove pair: the sidebar edits a
 * set, and two concurrent edits of a set converge on the last one written
 * instead of interleaving into a third set nobody chose.
 */

export const issueLabelsSchema = z
   .object({ labelIds: z.array(z.uuid()).max(50) })
   .strict();
export type IssueLabelsInput = z.infer<typeof issueLabelsSchema>;

export interface IssueLabel {
   id: string;
   name: string;
   color: string;
   description: string | null;
   archivedAt: string | null;
}

function toLabel(row: Record<string, unknown>): IssueLabel {
   return {
      id: row.id as string,
      name: row.name as string,
      color: row.color as string,
      description: (row.description as string | null) ?? null,
      archivedAt: toRFC3339(row.archived_at as string | null),
   };
}

export async function listIssueLabels(
   q: Queryable,
   workspaceId: string,
   issueId: string
): Promise<IssueLabel[]> {
   const rows = await q`
      SELECT label.id, label.name, label.color, label.description, label.archived_at
        FROM issue_label_memberships AS membership
        JOIN issue_labels AS label
          ON label.workspace_id = membership.workspace_id AND label.id = membership.label_id
       WHERE membership.workspace_id = ${workspaceId} AND membership.issue_id = ${issueId}
       ORDER BY lower(label.name), label.id`;
   return rows.map(toLabel);
}

/**
 * Replace the task's labels.
 *
 * A label id that is not this workspace's — or that has been archived — is a
 * `NotFound`, which the mount turns into a 404 naming the label. Archived is
 * refused rather than accepted quietly: a label nobody can pick from the
 * catalogue must not arrive on a task through a hand-written request, and a
 * label already on the task keeps its place because only the difference is
 * written.
 */
export async function setIssueLabels(
   q: Queryable,
   input: { workspaceId: string; issueId: string; labelIds: string[]; actorId: string }
): Promise<IssueLabel[]> {
   const wanted = [...new Set(input.labelIds.map((id) => id.toLowerCase()))];

   if (wanted.length > 0) {
      const known = await q`
         SELECT id FROM issue_labels
          WHERE workspace_id = ${input.workspaceId}
            AND id = ANY(${wanted}::uuid[])
            AND archived_at IS NULL`;
      if (known.length !== wanted.length) throw new NotFound();
   }

   await q`
      DELETE FROM issue_label_memberships
       WHERE workspace_id = ${input.workspaceId}
         AND issue_id = ${input.issueId}
         AND NOT (label_id = ANY(${wanted}::uuid[]))`;

   if (wanted.length > 0) {
      await q`
         INSERT INTO issue_label_memberships (workspace_id, issue_id, label_id, assigned_by)
         SELECT ${input.workspaceId}, ${input.issueId}, id, ${input.actorId}
           FROM unnest(${wanted}::uuid[]) AS id
         ON CONFLICT (workspace_id, issue_id, label_id) DO NOTHING`;
   }

   return listIssueLabels(q, input.workspaceId, input.issueId);
}
