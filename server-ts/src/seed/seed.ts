import type { Sql } from '../db/pool.ts';
import { withinTx } from '../db/pool.ts';
import {
   BoardID,
   BoardName,
   BoardSlug,
   UserEmail,
   UserID,
   UserName,
   WorkspaceID,
   WorkspaceName,
   WorkspaceSlug,
} from './ids.ts';

/**
 * The local development dataset.
 *
 * Every step is idempotent, so the command is safe to run after migrations on
 * every boot. The fixed ids are what make that true: a second run updates the
 * same rows rather than creating a second workspace nobody asked for.
 */
export async function apply(sql: Sql, now: string = new Date().toISOString()): Promise<void> {
   await withinTx(sql, async (tx) => {
      await upsertUser(tx, now);
      await upsertWorkspace(tx, now);
      await upsertMembership(tx, now);
      await setUserLastWorkspace(tx, now);
      await upsertBoard(tx, now);
      await upsertIssues(tx, now);
      await upsertProjects(tx, now);
   });
}

async function upsertUser(tx: Sql, now: string): Promise<void> {
   // A different user already holding this email would fail the unique index
   // below. Renaming theirs is deliberate: this is a development fixture, and
   // the seeded identity is the one the login flow expects to find.
   await tx`
      UPDATE users
         SET email = 'replaced-' || id::text || '@berry.test'
       WHERE lower(email) = lower(${UserEmail})
         AND id <> ${UserID}
   `;
   await tx`
      INSERT INTO users (
         id, email, name, role, settings, onboarding_state,
         onboarding_completed_at, last_workspace_id, created_at, updated_at
      ) VALUES (
         ${UserID}, ${UserEmail}, ${UserName}, 'admin',
         '{"theme":"system","timezone":"UTC","reducedMotion":false}'::jsonb,
         '{"version":1,"step":"complete","answers":{},"skipped":false,"completed":true}'::jsonb,
         ${now}, NULL, ${now}, ${now}
      )
      ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         role = EXCLUDED.role,
         updated_at = EXCLUDED.updated_at
   `;
}

async function setUserLastWorkspace(tx: Sql, now: string): Promise<void> {
   // Set after the workspace exists: the column is a foreign key, so the
   // insert above has to leave it NULL.
   await tx`
      UPDATE users
         SET last_workspace_id = ${WorkspaceID}, updated_at = ${now}
       WHERE id = ${UserID}
   `;
}

async function upsertWorkspace(tx: Sql, now: string): Promise<void> {
   await tx`
      UPDATE workspaces
         SET slug = 'replaced-' || id::text
       WHERE lower(slug) = lower(${WorkspaceSlug})
         AND id <> ${WorkspaceID}
         AND deleted_at IS NULL
   `;
   await tx`
      INSERT INTO workspaces (
         id, name, slug, description, settings, created_by, created_at, updated_at
      ) VALUES (
         ${WorkspaceID}, ${WorkspaceName}, ${WorkspaceSlug}, 'Local Berry workspace',
         '{"issuePrefix":"BER","defaultRole":"member","allowMemberInvites":false}'::jsonb,
         ${UserID}, ${now}, ${now}
      )
      ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         slug = EXCLUDED.slug,
         description = EXCLUDED.description,
         updated_at = EXCLUDED.updated_at
   `;
}

async function upsertMembership(tx: Sql, now: string): Promise<void> {
   await tx`
      INSERT INTO workspace_memberships (
         workspace_id, user_id, role, joined_at, updated_at
      ) VALUES (${WorkspaceID}, ${UserID}, 'owner', ${now}, ${now})
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET
         role = EXCLUDED.role,
         updated_at = EXCLUDED.updated_at
   `;
}

async function upsertBoard(tx: Sql, now: string): Promise<void> {
   await tx`
      UPDATE boards
         SET slug = 'replaced-' || id::text
       WHERE lower(slug) = lower(${BoardSlug})
         AND id <> ${BoardID}
   `;
   await tx`
      INSERT INTO boards (
         id, workspace_id, name, slug, description, columns, issue_counter,
         created_by, created_at, updated_at
      ) VALUES (
         ${BoardID}, ${WorkspaceID}, ${BoardName}, ${BoardSlug},
         'Default development crew board', '[]'::jsonb, 3,
         ${UserID}, ${now}, ${now}
      )
      ON CONFLICT (id) DO UPDATE SET
         workspace_id = EXCLUDED.workspace_id,
         name = EXCLUDED.name,
         slug = EXCLUDED.slug,
         description = EXCLUDED.description,
         updated_at = EXCLUDED.updated_at
   `;
}

const ISSUES = [
   {
      id: '11111111-1111-4111-8111-111111111201',
      number: 1,
      title: 'Wire agent runtime probes',
      status: 'todo',
      priority: 'high',
      sort: 1000,
   },
   {
      id: '11111111-1111-4111-8111-111111111202',
      number: 2,
      title: 'Match projects board to issues Kanban',
      status: 'in_progress',
      priority: 'medium',
      sort: 2000,
   },
   {
      id: '11111111-1111-4111-8111-111111111203',
      number: 3,
      title: 'Seed local development data',
      status: 'done',
      priority: 'low',
      sort: 3000,
   },
] as const;

async function upsertIssues(tx: Sql, now: string): Promise<void> {
   for (const issue of ISSUES) {
      await tx`
         INSERT INTO issues (
            id, board_id, number, title, description, status, priority, sort_order,
            created_by, created_at, updated_at
         ) VALUES (
            ${issue.id}, ${BoardID}, ${issue.number}, ${issue.title},
            'Seeded for local Berry development.',
            ${issue.status}::issue_status, ${issue.priority}::issue_priority, ${issue.sort},
            ${UserID}, ${now}, ${now}
         )
         ON CONFLICT (id) DO UPDATE SET
            title = EXCLUDED.title,
            status = EXCLUDED.status,
            priority = EXCLUDED.priority,
            sort_order = EXCLUDED.sort_order,
            updated_at = EXCLUDED.updated_at
      `;
   }
}

const PROJECTS = [
   {
      id: '11111111-1111-4111-8111-111111111301',
      name: 'Agent runtime',
      status: 'active',
      priority: 'high',
   },
   {
      id: '11111111-1111-4111-8111-111111111302',
      name: 'Projects parity',
      status: 'planned',
      priority: 'medium',
   },
   {
      id: '11111111-1111-4111-8111-111111111303',
      name: 'Workspace bootstrap',
      status: 'completed',
      priority: 'low',
   },
] as const;

async function upsertProjects(tx: Sql, now: string): Promise<void> {
   for (const project of PROJECTS) {
      await tx`
         INSERT INTO projects (
            id, workspace_id, name, description, status, priority,
            start_date, target_date, created_by, created_at, updated_at
         ) VALUES (
            ${project.id}, ${WorkspaceID}, ${project.name},
            'Seeded for local Berry development.',
            ${project.status}, ${project.priority},
            CURRENT_DATE - 7, CURRENT_DATE + 21, ${UserID}, ${now}, ${now}
         )
         ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            status = EXCLUDED.status,
            priority = EXCLUDED.priority,
            updated_at = EXCLUDED.updated_at
      `;
   }
}
