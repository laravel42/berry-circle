import { randomUUID } from 'node:crypto';
import { toRFC3339, type Queryable, type Sql } from '../db/pool.ts';

/**
 * A workspace's GitHub switches and the repositories it works in.
 *
 * Every read and write names the workspace, and every write that changes what
 * a page shows leaves an `outbox_events` row, so an open settings page learns
 * about another admin's change without polling.
 */

export interface GitHubSettings {
   /** The master switch. Off means no GitHub feature acts here. */
   enabled: boolean;
   showLinkedPullRequests: boolean;
   coAuthorTrailer: boolean;
   autoLinkPullRequests: boolean;
   /** Null until the workspace first saves its settings. */
   updatedAt: string | null;
}

export type GitHubSettingsPatch = Partial<Omit<GitHubSettings, 'updatedAt'>>;

export interface WorkspaceRepository {
   id: string;
   url: string;
   description: string;
   githubRepoId: number | null;
   position: number;
   createdAt: string;
   updatedAt: string;
}

/** What a workspace that has never opened the page gets: everything on. */
export const DEFAULT_GITHUB_SETTINGS: GitHubSettings = {
   enabled: true,
   showLinkedPullRequests: true,
   coAuthorTrailer: true,
   autoLinkPullRequests: true,
   updatedAt: null,
};

export const MAX_REPOSITORY_URL = 500;
export const MAX_REPOSITORY_DESCRIPTION = 500;

/**
 * A repository address a person can clone from, or null.
 *
 * https, `ssh://` and scp-style `git@host:path` only. Plain http is refused:
 * it would put a credential on the wire in the clear the first time anyone
 * cloned with one.
 */
export function normaliseRepositoryUrl(raw: string): string | null {
   const value = raw.trim().replace(/\/+$/, '');
   if (value === '' || value.length > MAX_REPOSITORY_URL || /\s/.test(value)) return null;
   if (/^https:\/\/[^/]+\/.+/.test(value)) return value;
   if (/^ssh:\/\/[^/]+\/.+/.test(value)) return value;
   if (/^git@[^:/]+:.+/.test(value)) return value;
   return null;
}

/** A URL another row in the same workspace already has. */
export class RepositoryConflict extends Error {
   override readonly name = 'RepositoryConflict';
}

export class GitHubSettingsRepository {
   readonly #sql: Sql;

   constructor(sql: Sql) {
      this.#sql = sql;
   }

   async get(workspaceId: string, tx?: Queryable): Promise<GitHubSettings> {
      const sql = (tx ?? this.#sql) as Sql;
      const [row] = await sql`
         SELECT enabled, show_linked_prs, co_author_trailer, auto_link_prs, updated_at
           FROM github_workspace_settings WHERE workspace_id = ${workspaceId}`;
      return row ? toSettings(row) : { ...DEFAULT_GITHUB_SETTINGS };
   }

   async update(
      workspaceId: string,
      patch: GitHubSettingsPatch,
      userId: string,
      tx: Queryable
   ): Promise<GitHubSettings> {
      const sql = tx as Sql;
      const [row] = await sql`
         INSERT INTO github_workspace_settings
                (workspace_id, enabled, show_linked_prs, co_author_trailer, auto_link_prs,
                 updated_by, updated_at)
         VALUES (${workspaceId}, ${patch.enabled ?? true}, ${patch.showLinkedPullRequests ?? true},
                 ${patch.coAuthorTrailer ?? true}, ${patch.autoLinkPullRequests ?? true},
                 ${userId}, now())
         ON CONFLICT (workspace_id) DO UPDATE SET
            enabled = COALESCE(${patch.enabled ?? null}::boolean, github_workspace_settings.enabled),
            show_linked_prs = COALESCE(${patch.showLinkedPullRequests ?? null}::boolean,
                                       github_workspace_settings.show_linked_prs),
            co_author_trailer = COALESCE(${patch.coAuthorTrailer ?? null}::boolean,
                                         github_workspace_settings.co_author_trailer),
            auto_link_prs = COALESCE(${patch.autoLinkPullRequests ?? null}::boolean,
                                     github_workspace_settings.auto_link_prs),
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
         RETURNING enabled, show_linked_prs, co_author_trailer, auto_link_prs, updated_at`;
      const settings = toSettings(row!);
      await writeWorkspaceEvent(sql, {
         workspaceId,
         type: 'github.settings.updated',
         aggregateType: 'github_settings',
         aggregateId: workspaceId,
         payload: { settings },
      });
      return settings;
   }

   async listRepositories(workspaceId: string, tx?: Queryable): Promise<WorkspaceRepository[]> {
      const sql = (tx ?? this.#sql) as Sql;
      const rows = await sql`
         SELECT ${sql.unsafe(REPOSITORY_COLUMNS)} FROM workspace_repositories
          WHERE workspace_id = ${workspaceId}
          ORDER BY position ASC, created_at ASC, id ASC`;
      return rows.map(toRepository);
   }

   /**
    * Adds what is not already there, and answers with what was added.
    *
    * A URL the workspace already lists is skipped rather than refused, so an
    * import that overlaps the list is not an error.
    */
   async addRepositories(
      workspaceId: string,
      items: ReadonlyArray<{ url: string; description?: string; githubRepoId?: number | null }>,
      userId: string,
      tx: Queryable
   ): Promise<WorkspaceRepository[]> {
      const sql = tx as Sql;
      const [top] = await sql`
         SELECT COALESCE(MAX(position), -1)::int AS position
           FROM workspace_repositories WHERE workspace_id = ${workspaceId}`;
      let position = Number(top?.position ?? -1);
      const added: WorkspaceRepository[] = [];
      for (const item of items) {
         position += 1;
         const [row] = await sql`
            INSERT INTO workspace_repositories
                   (workspace_id, url, description, github_repo_id, position, created_by)
            VALUES (${workspaceId}, ${item.url}, ${item.description ?? ''},
                    ${item.githubRepoId ?? null}, ${position}, ${userId})
            ON CONFLICT (workspace_id, url) DO NOTHING
            RETURNING ${sql.unsafe(REPOSITORY_COLUMNS)}`;
         if (row) added.push(toRepository(row));
      }
      if (added.length > 0) await this.#changed(sql, workspaceId);
      return added;
   }

   /** Null when there is no such repository in this workspace. */
   async updateRepository(
      workspaceId: string,
      id: string,
      patch: { url?: string; description?: string },
      tx: Queryable
   ): Promise<WorkspaceRepository | null> {
      const sql = tx as Sql;
      let row: Record<string, unknown> | undefined;
      try {
         [row] = await sql`
            UPDATE workspace_repositories
               SET url = COALESCE(${patch.url ?? null}::text, url),
                   description = COALESCE(${patch.description ?? null}::text, description),
                   updated_at = now()
             WHERE id = ${id} AND workspace_id = ${workspaceId}
            RETURNING ${sql.unsafe(REPOSITORY_COLUMNS)}`;
      } catch (error) {
         if ((error as { code?: unknown }).code === '23505') {
            throw new RepositoryConflict('this workspace already lists that URL');
         }
         throw error;
      }
      if (!row) return null;
      await this.#changed(sql, workspaceId);
      return toRepository(row);
   }

   async removeRepository(workspaceId: string, id: string, tx: Queryable): Promise<boolean> {
      const sql = tx as Sql;
      const rows = await sql`
         DELETE FROM workspace_repositories
          WHERE id = ${id} AND workspace_id = ${workspaceId} RETURNING id`;
      if (rows.length === 0) return false;
      await this.#changed(sql, workspaceId);
      return true;
   }

   async #changed(sql: Sql, workspaceId: string): Promise<void> {
      await writeWorkspaceEvent(sql, {
         workspaceId,
         type: 'github.repositories.updated',
         aggregateType: 'workspace_repositories',
         aggregateId: workspaceId,
         payload: {},
      });
   }
}

/**
 * One realtime fact, written in the caller's transaction.
 *
 * Same envelope shape the issue and comment writers use, so the replay
 * decodes it without knowing GitHub exists. Committed with the change it
 * describes: an event for a write that rolled back would describe nothing.
 */
export async function writeWorkspaceEvent(
   tx: Queryable,
   input: {
      workspaceId: string;
      boardId?: string | null;
      issueId?: string | null;
      type: string;
      aggregateType: string;
      aggregateId: string;
      payload: unknown;
   }
): Promise<void> {
   const sql = tx as Sql;
   const id = randomUUID();
   const occurredAt = new Date().toISOString();
   const envelope = {
      id,
      type: input.type,
      occurredAt,
      workspaceId: input.workspaceId,
      boardId: input.boardId ?? null,
      issueId: input.issueId ?? null,
      runId: null,
      sequence: null,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: input.payload,
   };
   await sql`
      INSERT INTO outbox_events (
         id, topic, aggregate_type, aggregate_id, workspace_id, board_id,
         payload, occurred_at, available_at
      ) VALUES (
         ${id}, ${input.type}, ${input.aggregateType}, ${input.aggregateId},
         ${input.workspaceId}, ${input.boardId ?? null},
         ${sql.json(envelope as never)}, ${occurredAt}, ${occurredAt}
      )`;
}

const REPOSITORY_COLUMNS = `id, url, description, github_repo_id, position, created_at, updated_at`;

function toSettings(row: Record<string, unknown>): GitHubSettings {
   return {
      enabled: row.enabled === true,
      showLinkedPullRequests: row.show_linked_prs === true,
      coAuthorTrailer: row.co_author_trailer === true,
      autoLinkPullRequests: row.auto_link_prs === true,
      updatedAt: toRFC3339(row.updated_at as string | null),
   };
}

function toRepository(row: Record<string, unknown>): WorkspaceRepository {
   return {
      id: row.id as string,
      url: row.url as string,
      description: (row.description as string | null) ?? '',
      githubRepoId: row.github_repo_id === null ? null : Number(row.github_repo_id),
      position: Number(row.position),
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}
