import { createHash, randomUUID } from 'node:crypto';

/**
 * The artifact vocabulary, Berry's own.
 *
 * These mirrored an agent framework's interface while ADK ran the agents, and
 * were the last thing in the server that made Berry's storage answerable to
 * someone else's type names. Strands has no artifact service, so the shapes
 * are declared here — where the store they describe actually lives.
 */

/** A file's payload: bytes with a type, or text. */
export interface Part {
   inlineData?: { data: string; mimeType?: string | undefined } | undefined;
   text?: string | undefined;
}

export interface ArtifactVersion {
   version: number;
   mimeType?: string | undefined;
   /**
    * Berry's own address for the object, not a signed URL: this is metadata an
    * agent reads, and a URL that expires would be worse than no URL.
    */
   canonicalUri?: string | undefined;
   customMetadata?: Record<string, unknown> | undefined;
}

export interface SaveArtifactRequest {
   filename: string;
   artifact: Part;
}
export interface LoadArtifactRequest {
   filename: string;
   version?: number | undefined;
}
export interface DeleteArtifactRequest {
   filename: string;
}
export interface ListVersionsRequest {
   filename: string;
   version?: number | undefined;
}
import type { Sql } from '../db/pool.ts';
import { ObjectNotFound, sniffContentType, type Storage } from '../storage/storage.ts';

/**
 * ADK artifacts backed by `run_artifacts` and object storage.
 *
 * This is what replaces the previous runtime's per-agent volume, and it is the
 * reason agents can hand each other work. There every file tool was scoped
 * to the agent's own directory, so a task depending on finished work received
 * it as text pasted into a prompt. A shared artifact store means the second
 * agent reads what the first actually wrote.
 *
 * Bytes live in the bucket; identity lives in PostgreSQL. Neither half is
 * authoritative alone: a row without an object is a promise nothing kept, and
 * an object without a row belongs to nobody.
 */

const APP_SCOPE = 'berry';

export interface BerryArtifactOptions {
   sql: Sql;
   storage: Storage;
   /** The run these artifacts belong to, and the workspace that owns it. */
   workspaceId: string;
   runId: string;
   issueId: string;
   agentId?: string | undefined;
   agentName: string;
   clock?: () => Date;
   newId?: () => string;
}

export class BerryArtifactService {
   private readonly sql: Sql;
   private readonly storage: Storage;
   private readonly workspaceId: string;
   private readonly runId: string;
   private readonly issueId: string;
   private readonly agentId: string | undefined;
   private readonly agentName: string;
   private readonly clock: () => Date;
   private readonly newId: () => string;

   constructor(options: BerryArtifactOptions) {
      this.sql = options.sql;
      this.storage = options.storage;
      this.workspaceId = options.workspaceId;
      this.runId = options.runId;
      this.issueId = options.issueId;
      this.agentId = options.agentId;
      this.agentName = options.agentName;
      this.clock = options.clock ?? (() => new Date());
      this.newId = options.newId ?? randomUUID;
   }

   /**
    * Saves one artifact and returns its version.
    *
    * The row is reserved `pending` before the bytes are uploaded and marked
    * `ready` only once they are there. A reader that sees `ready` is promised
    * the object exists; the reverse order would offer a file that had not
    * finished arriving, and a crash between the two leaves a pending row that
    * is visible to nobody rather than a broken link that is visible to
    * everyone.
    */
   async saveArtifact(request: SaveArtifactRequest): Promise<number> {
      const path = artifactPath(request.filename);
      const body = partToBytes(request.artifact);
      // Sniffed rather than defaulted when the part names no type. An agent
      // writing prose produces a text Part with no mimeType, and recording
      // that as application/octet-stream makes the browser download a
      // markdown file instead of showing it.
      const contentType = request.artifact.inlineData?.mimeType ?? sniffContentType(body);
      const checksum = createHash('sha256').update(body).digest();

      const id = this.newId();
      const storageKey = `artifacts/${this.workspaceId}/${this.runId}/${id}`;
      const now = this.clock().toISOString();

      // The run row is locked before the version is counted. Two agents saving
      // the same path in the same run would otherwise both read the same
      // maximum and both claim it, and the second would fail on the unique
      // key. The lock cannot go on the artifact rows themselves — PostgreSQL
      // refuses FOR UPDATE alongside an aggregate, and on a path's first save
      // there is no row to lock anyway.
      const version = await this.sql.begin(async (tx) => {
         const [run] = await tx`SELECT id FROM runs WHERE id = ${this.runId} FOR UPDATE`;
         if (!run) throw new Error(`run ${this.runId} does not exist`);

         const [next] = await tx`
            SELECT COALESCE(MAX(version) + 1, 0) AS version
              FROM run_artifacts
             WHERE run_id = ${this.runId} AND path = ${path}`;
         const allocated = Number(next!.version);

         await tx`
            INSERT INTO run_artifacts (
               id, workspace_id, run_id, issue_id, agent_id, agent_name, path,
               content_type, size_bytes, checksum_sha256, storage_key, state, version, created_at
            ) VALUES (
               ${id}, ${this.workspaceId}, ${this.runId}, ${this.issueId},
               ${this.agentId ?? null}, ${this.agentName}, ${path}, ${contentType},
               ${body.byteLength}, ${checksum}, ${storageKey}, 'pending', ${allocated}, ${now}
            )`;
         return allocated;
      });

      await this.storage.put(storageKey, body, {
         contentType,
         checksumSha256: checksum.toString('hex'),
      });

      await this.sql`
         UPDATE run_artifacts
            SET state = 'ready', ready_at = ${this.clock().toISOString()}
          WHERE id = ${id}`;

      return version;
   }

   /** The named version, or the newest when none is asked for. */
   async loadArtifact(request: LoadArtifactRequest): Promise<Part | undefined> {
      const row = await this.findVersion(request.filename, request.version);
      if (!row) return undefined;

      try {
         const bytes = await this.storage.open(row.storage_key as string);
         return {
            inlineData: {
               mimeType: row.content_type as string,
               data: Buffer.from(bytes).toString('base64'),
            },
         };
      } catch (error) {
         // A ready row whose object is gone is a broken promise, not an empty
         // file. Reporting it as absent is the honest answer to "load this".
         if (error instanceof ObjectNotFound) return undefined;
         throw error;
      }
   }

   /**
    * Every filename saved on this task, once each.
    *
    * The task, not the run: a run sent back and worked again is a new run on
    * the same task, and the prompt promises it that what the earlier attempt
    * saved is still there. Scoped to the run, a rerun asked to add narration
    * to a clip listed nothing and reported the clip missing.
    *
    * A path with three versions is one artifact, so it is listed once — an
    * agent choosing what to read should see the files, not the history.
    */
   async listArtifactKeys(): Promise<string[]> {
      const rows = await this.sql`
         SELECT DISTINCT path
           FROM run_artifacts
          WHERE issue_id = ${this.issueId} AND state = 'ready'
          ORDER BY path ASC`;
      return rows.map((row) => row.path as string);
   }

   /**
    * Removes every version of one artifact.
    *
    * The rows go first. An object left behind is unreferenced storage, which
    * costs money; a row left behind points at something that is not there,
    * which costs correctness.
    */
   async deleteArtifact(request: DeleteArtifactRequest): Promise<void> {
      const path = artifactPath(request.filename);
      const rows = await this.sql`
         DELETE FROM run_artifacts
          WHERE run_id = ${this.runId} AND path = ${path}
          RETURNING storage_key`;

      for (const row of rows) {
         await this.storage.delete(row.storage_key as string).catch(() => undefined);
      }
   }

   async listVersions(request: ListVersionsRequest): Promise<number[]> {
      const rows = await this.sql`
         SELECT version FROM run_artifacts
          WHERE run_id = ${this.runId} AND path = ${artifactPath(request.filename)}
            AND state = 'ready'
          ORDER BY version ASC`;
      return rows.map((row) => Number(row.version));
   }

   async listArtifactVersions(request: ListVersionsRequest): Promise<ArtifactVersion[]> {
      const rows = await this.sql`
         SELECT version, content_type, size_bytes, storage_key, created_at
           FROM run_artifacts
          WHERE run_id = ${this.runId} AND path = ${artifactPath(request.filename)}
            AND state = 'ready'
          ORDER BY version ASC`;
      return rows.map((row) => toArtifactVersion(row));
   }

   async getArtifactVersion(request: LoadArtifactRequest): Promise<ArtifactVersion | undefined> {
      const row = await this.findVersion(request.filename, request.version);
      return row ? toArtifactVersion(row) : undefined;
   }

   /**
    * The newest file at a path on this task, or one version of this run's.
    *
    * Version numbers count within a run — every run's first save of a path
    * is version 0 — so a number only means something against the run that
    * allocated it, and a numbered read stays there. An unnumbered read is
    * "the current file", which is whichever run wrote it last: an earlier
    * attempt's clip when this run has not replaced it, this run's when it
    * has.
    */
   private async findVersion(
      filename: string,
      version: number | undefined
   ): Promise<Record<string, unknown> | undefined> {
      const path = artifactPath(filename);
      const [row] =
         version === undefined
            ? await this.sql`
                 SELECT version, content_type, size_bytes, storage_key, created_at
                   FROM run_artifacts
                  WHERE issue_id = ${this.issueId} AND path = ${path} AND state = 'ready'
                  ORDER BY created_at DESC
                  LIMIT 1`
            : await this.sql`
                 SELECT version, content_type, size_bytes, storage_key, created_at
                   FROM run_artifacts
                  WHERE run_id = ${this.runId} AND path = ${path} AND state = 'ready'
                    AND version = ${version}
                  LIMIT 1`;
      return row;
   }
}

function toArtifactVersion(row: Record<string, unknown>): ArtifactVersion {
   return {
      version: Number(row.version),
      mimeType: row.content_type as string,
      // Berry's own address for the object, not a signed URL: this is metadata
      // for an agent, and a URL that expires would be worse than no URL.
      canonicalUri: `berry://artifacts/${row.storage_key as string}`,
      customMetadata: { sizeBytes: Number(row.size_bytes) },
   };
}

/**
 * ADK's filename as a Berry artifact path.
 *
 * ADK reserves a `user:` prefix for artifacts that outlive one session. Berry
 * scopes artifacts to a run, so the prefix is folded into the path rather than
 * dropped — keeping it distinct from a file of the same name saved normally,
 * which is what the prefix means.
 *
 * The rest is passed through: `run_artifacts.path` permits separators, and a
 * `path_safe` constraint refuses anything that escapes.
 */
export function artifactPath(filename: string): string {
   if (filename.startsWith('user:')) {
      return `${APP_SCOPE}-user/${filename.slice('user:'.length)}`;
   }
   return filename;
}

/**
 * The bytes an ADK Part carries.
 *
 * A Part may hold inline data or text. Text is stored as UTF-8 rather than
 * refused, because an agent writing a note is the ordinary case and forcing it
 * to base64-encode prose would be a worse interface.
 */
export function partToBytes(part: Part): Buffer {
   if (part.inlineData?.data) return Buffer.from(part.inlineData.data, 'base64');
   if (typeof part.text === 'string') return Buffer.from(part.text, 'utf8');
   throw new Error('artifact part carries neither inline data nor text');
}
