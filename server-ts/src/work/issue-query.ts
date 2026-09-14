import { z } from 'zod';
import type { Queryable } from '../db/pool.ts';
import { apiStatusToDb, dbStatusToApi } from '../core/issues.ts';

/**
 * The view query: filter the workspace's issues, group them, count every group
 * and three facets, and return the first `perGroup` ids of each group.
 *
 * One static statement with every filter behind a boolean guard (the house
 * style of `IssueRepository.list`), so the plan is one prepared shape
 * whatever the view asks for. Property filters travel as one jsonb array that
 * every element of must match.
 */
const API_STATUSES = ['backlog', 'todo', 'inProgress', 'inReview', 'done', 'blocked', 'cancelled'] as const;
const PRIORITIES = ['none', 'urgent', 'high', 'medium', 'low'] as const;

const personRef = z.object({ type: z.enum(['user', 'agent']), id: z.uuid() }).strict();

const propertyFilterSchema = z.discriminatedUnion('op', [
   z.object({ propertyId: z.uuid(), op: z.literal('isSet') }).strict(),
   z.object({ propertyId: z.uuid(), op: z.literal('notSet') }).strict(),
   z
      .object({
         propertyId: z.uuid(),
         op: z.literal('eq'),
         value: z.union([z.string().max(2000), z.number(), z.boolean()]),
      })
      .strict(),
   z
      .object({ propertyId: z.uuid(), op: z.literal('in'), values: z.array(z.string().max(200)).min(1).max(100) })
      .strict(),
   z
      .object({ propertyId: z.uuid(), op: z.literal('contains'), value: z.union([z.string().max(200), personRef]) })
      .strict(),
   z
      .object({ propertyId: z.uuid(), op: z.literal('gt'), value: z.union([z.number(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]) })
      .strict(),
   z
      .object({ propertyId: z.uuid(), op: z.literal('lt'), value: z.union([z.number(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]) })
      .strict(),
]);

export const issueQuerySchema = z
   .object({
      workspaceId: z.uuid(),
      filter: z
         .object({
            boardIds: z.array(z.uuid()).max(50).optional(),
            statuses: z.array(z.enum(API_STATUSES)).optional(),
            statusIds: z.array(z.uuid()).max(100).optional(),
            priorities: z.array(z.enum(PRIORITIES)).optional(),
            assignees: z.array(personRef).max(50).optional(),
            unassigned: z.boolean().optional(),
            labelIds: z.array(z.uuid()).max(50).optional(),
            parentId: z.uuid().nullable().optional(),
            query: z.string().trim().min(1).max(200).optional(),
            properties: z.array(propertyFilterSchema).max(20).optional(),
         })
         .strict()
         .default({}),
      groupBy: z
         .union([
            z.enum(['none', 'status', 'priority', 'assignee', 'parent']),
            z.object({ propertyId: z.uuid() }).strict(),
         ])
         .default('none'),
      perGroup: z.number().int().min(1).max(200).default(50),
   })
   .strict();
export type IssueQuery = z.infer<typeof issueQuerySchema>;

export interface IssueQueryResult {
   total: number;
   groups: Array<{ key: string; count: number; issueIds: string[] }>;
   facets: {
      status: Record<string, number>;
      priority: Record<string, number>;
      assignee: Record<string, number>;
   };
}

function nonEmpty<T>(values: T[] | undefined): T[] | null {
   return values && values.length > 0 ? values : null;
}

export async function runIssueQuery(
   q: Queryable,
   workspaceId: string,
   input: IssueQuery
): Promise<IssueQueryResult> {
   const filter = input.filter;
   const boardIds = nonEmpty(filter.boardIds);
   const statuses = nonEmpty(filter.statuses?.map(apiStatusToDb));
   const statusIds = nonEmpty(filter.statusIds);
   const priorities = nonEmpty(filter.priorities);
   const assigneeKeys = [
      ...(filter.assignees ?? []).map((person) => `${person.type}:${person.id}`),
      ...(filter.unassigned ? ['none'] : []),
   ];
   const labelIds = nonEmpty(filter.labelIds);
   const parentSet = filter.parentId !== undefined;
   const pattern =
      filter.query === undefined ? null : `%${filter.query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
   const groupKind = typeof input.groupBy === 'string' ? input.groupBy : 'property';
   const groupPropertyId = typeof input.groupBy === 'string' ? null : input.groupBy.propertyId;

   const rows = await q`
      WITH filtered AS (
         SELECT i.id, i.status::text AS status, i.priority::text AS priority,
                COALESCE(i.assignee_type::text || ':' || i.assignee_id::text, 'none') AS assignee,
                i.sort_order, i.updated_at,
                CASE ${groupKind}::text
                   WHEN 'status' THEN i.status::text
                   WHEN 'priority' THEN i.priority::text
                   WHEN 'assignee' THEN COALESCE(i.assignee_type::text || ':' || i.assignee_id::text, 'none')
                   WHEN 'parent' THEN COALESCE(i.parent_id::text, 'none')
                   WHEN 'property' THEN COALESCE((
                      SELECT grouped.value #>> '{}' FROM issue_property_values AS grouped
                       WHERE grouped.workspace_id = ${workspaceId} AND grouped.issue_id = i.id
                         AND grouped.property_id = ${groupPropertyId}::uuid), 'none')
                   ELSE 'all'
                END AS group_key
           FROM issues AS i
           JOIN boards AS b ON b.id = i.board_id
          WHERE b.workspace_id = ${workspaceId}
            AND i.deleted_at IS NULL
            AND (${boardIds === null}::boolean OR i.board_id = ANY(${boardIds}::uuid[]))
            AND (${statuses === null}::boolean OR i.status::text = ANY(${statuses}::text[]))
            AND (${statusIds === null}::boolean OR i.status_id = ANY(${statusIds}::uuid[]))
            AND (${priorities === null}::boolean OR i.priority::text = ANY(${priorities}::text[]))
            AND (${assigneeKeys.length === 0}::boolean OR
                 COALESCE(i.assignee_type::text || ':' || i.assignee_id::text, 'none')
                    = ANY(${assigneeKeys}::text[]))
            AND (${labelIds === null}::boolean OR EXISTS (
                 SELECT 1 FROM issue_label_memberships AS membership
                  WHERE membership.workspace_id = ${workspaceId} AND membership.issue_id = i.id
                    AND membership.label_id = ANY(${labelIds}::uuid[])))
            AND (NOT ${parentSet}::boolean OR i.parent_id IS NOT DISTINCT FROM ${filter.parentId ?? null}::uuid)
            AND (${pattern === null}::boolean OR i.title ILIKE ${pattern}::text)
            AND NOT EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(${q.json((filter.properties ?? []) as never)}::jsonb) AS f(spec)
                 LEFT JOIN issue_property_values AS pv
                   ON pv.workspace_id = ${workspaceId} AND pv.issue_id = i.id
                  AND pv.property_id = (f.spec ->> 'propertyId')::uuid
                WHERE NOT COALESCE(CASE f.spec ->> 'op'
                   WHEN 'isSet' THEN pv.value IS NOT NULL
                   WHEN 'notSet' THEN pv.value IS NULL
                   WHEN 'eq' THEN pv.value = f.spec -> 'value'
                   WHEN 'in' THEN (pv.value #>> '{}') IN (SELECT jsonb_array_elements_text(f.spec -> 'values'))
                   WHEN 'contains' THEN pv.value @> jsonb_build_array(f.spec -> 'value')
                   WHEN 'gt' THEN CASE
                      WHEN jsonb_typeof(f.spec -> 'value') = 'number' AND jsonb_typeof(pv.value) = 'number'
                         THEN (pv.value #>> '{}')::numeric > (f.spec ->> 'value')::numeric
                      WHEN jsonb_typeof(f.spec -> 'value') = 'string' AND jsonb_typeof(pv.value) = 'string'
                         THEN (pv.value #>> '{}') > (f.spec ->> 'value')
                      ELSE false END
                   WHEN 'lt' THEN CASE
                      WHEN jsonb_typeof(f.spec -> 'value') = 'number' AND jsonb_typeof(pv.value) = 'number'
                         THEN (pv.value #>> '{}')::numeric < (f.spec ->> 'value')::numeric
                      WHEN jsonb_typeof(f.spec -> 'value') = 'string' AND jsonb_typeof(pv.value) = 'string'
                         THEN (pv.value #>> '{}') < (f.spec ->> 'value')
                      ELSE false END
                END, false)
            )
      ),
      ranked AS (
         SELECT group_key, id,
                count(*) OVER (PARTITION BY group_key)::int AS group_count,
                row_number() OVER (PARTITION BY group_key
                                   ORDER BY sort_order ASC, updated_at DESC, id DESC) AS rank
           FROM filtered
      )
      SELECT 'group' AS kind, group_key AS key, id::text AS id, group_count AS count, rank
        FROM ranked WHERE rank <= ${input.perGroup}
      UNION ALL
      SELECT 'status', status, NULL, count(*)::int, NULL FROM filtered GROUP BY status
      UNION ALL
      SELECT 'priority', priority, NULL, count(*)::int, NULL FROM filtered GROUP BY priority
      UNION ALL
      SELECT 'assignee', assignee, NULL, count(*)::int, NULL FROM filtered GROUP BY assignee`;

   const groups = new Map<string, { key: string; count: number; issueIds: Array<[number, string]> }>();
   const facets: IssueQueryResult['facets'] = { status: {}, priority: {}, assignee: {} };
   let total = 0;
   for (const row of rows) {
      const kind = row.kind as string;
      const rawKey = row.key as string;
      const count = Number(row.count);
      if (kind === 'group') {
         const key = groupKind === 'status' ? dbStatusToApi(rawKey) : rawKey;
         const group = groups.get(key) ?? { key, count, issueIds: [] };
         group.issueIds.push([Number(row.rank), row.id as string]);
         groups.set(key, group);
      } else if (kind === 'status') {
         facets.status[dbStatusToApi(rawKey)] = count;
         total += count;
      } else if (kind === 'priority') {
         facets.priority[rawKey] = count;
      } else {
         facets.assignee[rawKey] = count;
      }
   }
   return {
      total,
      groups: [...groups.values()]
         .sort((left, right) => left.key.localeCompare(right.key))
         .map((group) => ({
            key: group.key,
            count: group.count,
            issueIds: group.issueIds.sort((left, right) => left[0] - right[0]).map(([, id]) => id),
         })),
      facets,
   };
}
