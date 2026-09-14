import { toRFC3339, type Sql } from '../db/pool.ts';

/**
 * What the agents on a task produced, read back for the people looking at it.
 *
 * `run_artifacts` is written by the artifact service as an agent calls
 * `write_file`; this is the other half, which the port left out: nothing
 * served the rows, so the task page's "Produced" tree was always empty. One
 * artifact is one path at its newest version — the history is the service's
 * concern, and a person opening a task wants the files.
 */

export interface RunArtifact {
   id: string;
   issueId: string;
   runId: string;
   workspaceId: string;
   path: string;
   name: string;
   directory: string;
   contentType: string;
   sizeBytes: number;
   storageKey: string;
   agentName: string;
   createdAt: string;
}

export class RunArtifactRepository {
   readonly #sql: Sql;

   constructor(sql: Sql) {
      this.#sql = sql;
   }

   /** The newest ready version of every path any run on the issue produced. */
   async listForIssue(issueId: string): Promise<RunArtifact[]> {
      const rows = await this.#sql`
         SELECT DISTINCT ON (artifact.path)
                artifact.id, artifact.issue_id, artifact.run_id, artifact.workspace_id, artifact.path,
                artifact.content_type, artifact.size_bytes, artifact.storage_key, artifact.agent_name,
                artifact.created_at
           FROM run_artifacts AS artifact
          WHERE artifact.issue_id = ${issueId} AND artifact.state = 'ready'
          -- Newest write wins. Versions count within a run, so a rerun's
          -- version 0 is newer than the earlier attempt's version 1.
          ORDER BY artifact.path ASC, artifact.created_at DESC`;
      return rows.map(toArtifact);
   }

   async get(id: string): Promise<RunArtifact | null> {
      const [row] = await this.#sql`
         SELECT id, issue_id, run_id, workspace_id, path, content_type, size_bytes, storage_key,
                agent_name, created_at
           FROM run_artifacts WHERE id = ${id} AND state = 'ready'`;
      return row ? toArtifact(row) : null;
   }
}

function toArtifact(row: Record<string, unknown>): RunArtifact {
   const path = row.path as string;
   const slash = path.lastIndexOf('/');
   return {
      id: row.id as string,
      issueId: row.issue_id as string,
      runId: row.run_id as string,
      workspaceId: row.workspace_id as string,
      path,
      name: slash === -1 ? path : path.slice(slash + 1),
      directory: slash === -1 ? '' : path.slice(0, slash),
      contentType: (row.content_type as string | null) ?? 'application/octet-stream',
      sizeBytes: Number(row.size_bytes ?? 0),
      storageKey: row.storage_key as string,
      agentName: (row.agent_name as string | null) ?? 'an agent',
      createdAt: toRFC3339(row.created_at as string) ?? '',
   };
}
