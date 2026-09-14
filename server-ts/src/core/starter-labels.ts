import type { Queryable } from '../db/pool.ts';

/**
 * The labels every workspace starts with.
 *
 * Installed when a workspace is created and backfilled by the seed, because a
 * task with no label to pick is a task nobody can file properly. Names are the
 * identity: a label a person already made under one of these names is theirs
 * and is left as it is — the partial unique index on lower(name) makes the
 * insert a no-op rather than a duplicate or a failure.
 */
export const STARTER_LABELS: ReadonlyArray<{ name: string; color: string; description: string }> = [
   { name: 'bug', color: '#dc2626', description: 'Something is broken and has to be fixed.' },
   { name: 'feature', color: '#2563eb', description: 'New capability the product does not have yet.' },
   { name: 'improvement', color: '#0891b2', description: 'Makes something that exists better.' },
   { name: 'documentation', color: '#7c3aed', description: 'Docs, guides, comments and examples.' },
   { name: 'research', color: '#d97706', description: 'Find out before deciding; the result is an answer, not code.' },
   { name: 'design', color: '#db2777', description: 'Interface, flow and visual work.' },
   { name: 'chore', color: '#6b7280', description: 'Upkeep: dependencies, tooling, housekeeping.' },
   { name: 'security', color: '#b91c1c', description: 'Affects who can do or see what.' },
   { name: 'performance', color: '#059669', description: 'Faster, smaller or cheaper.' },
   { name: 'media', color: '#9333ea', description: 'Video, audio and other generated content.' },
   { name: 'blocked', color: '#f97316', description: 'Cannot move until something outside it does.' },
   { name: 'good first task', color: '#16a34a', description: 'Small, self-contained, a good place to start.' },
];

/**
 * Puts the starter set into one workspace. Idempotent: a name that is already
 * there, whether from an earlier install or a person, is skipped.
 *
 * Returns how many were added, so a caller can tell a fresh workspace from a
 * backfill that found everything in place.
 */
export async function installStarterLabels(
   sql: Queryable,
   workspaceId: string,
   createdBy: string | null,
   now: string
): Promise<number> {
   let added = 0;
   for (const label of STARTER_LABELS) {
      const rows = await sql`
         INSERT INTO issue_labels (workspace_id, name, description, color, created_by, created_at, updated_at)
         VALUES (${workspaceId}, ${label.name}, ${label.description}, ${label.color}, ${createdBy}, ${now}, ${now})
         ON CONFLICT (workspace_id, lower(name)) WHERE archived_at IS NULL
         DO NOTHING
         RETURNING id`;
      added += rows.length;
   }
   return added;
}
