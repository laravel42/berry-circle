import { toRFC3339, type Queryable, type Sql } from '../db/pool.ts';
import type { ScmProviderId } from './provider.ts';

/**
 * What each Berry object is on the git host.
 *
 * Every mapping goes through here, which is what makes "never match by name"
 * enforceable rather than a convention: there is no other way to learn a
 * host id, so there is no other way to guess one.
 *
 * The status is as important as the id. A row with `status = 'failed'` says
 * Berry tried and could not, which is a different thing from never having
 * tried, and both are different from believing an object exists that does not.
 */

export type BerryType = 'workspace' | 'project' | 'milestone' | 'issue' | 'review' | 'run';
export type LinkStatus = 'pending' | 'synced' | 'failed' | 'detached';

export interface ScmLink {
   id: string;
   workspaceId: string;
   provider: ScmProviderId;
   berryType: BerryType;
   berryId: string;
   externalId: number | null;
   externalNumber: number | null;
   externalUrl: string | null;
   externalUpdatedAt: string | null;
   status: LinkStatus;
   error: string | null;
   lastSyncedAt: string | null;
}

export class ScmLinkRepository {
   readonly #sql: Sql;

   constructor(sql: Sql) {
      this.#sql = sql;
   }

   /** The link for one Berry object, or null when it has never been provisioned. */
   async find(
      provider: ScmProviderId,
      berryType: BerryType,
      berryId: string,
      tx?: Queryable
   ): Promise<ScmLink | null> {
      const sql = (tx ?? this.#sql) as Sql;
      const [row] = await sql`
         SELECT ${sql.unsafe(COLUMNS)} FROM scm_links
          WHERE provider = ${provider} AND berry_type = ${berryType} AND berry_id = ${berryId}`;
      return row ? toLink(row) : null;
   }

   /** The links for many Berry objects at once, keyed by Berry id. */
   async findMany(
      provider: ScmProviderId,
      berryType: BerryType,
      berryIds: string[]
   ): Promise<Map<string, ScmLink>> {
      if (berryIds.length === 0) return new Map();
      const rows = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)} FROM scm_links
          WHERE provider = ${provider} AND berry_type = ${berryType}
            AND berry_id = ANY(${berryIds}::uuid[])`;
      return new Map(rows.map((row) => [row.berry_id as string, toLink(row)]));
   }

   /**
    * Which Berry object a host id belongs to.
    *
    * The inbound webhook read, and the reason names are never involved: a
    * webhook carries the host's id, and this answers with Berry's.
    */
   async resolve(
      provider: ScmProviderId,
      berryType: BerryType,
      externalId: number
   ): Promise<ScmLink | null> {
      const [row] = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)} FROM scm_links
          WHERE provider = ${provider} AND berry_type = ${berryType}
            AND external_id = ${externalId}`;
      return row ? toLink(row) : null;
   }

   /**
    * Claims the intent to provision, before the call that does it.
    *
    * Written first and deliberately: a `pending` row that never becomes
    * `synced` is a visible, queryable failure, whereas writing only on success
    * makes a crashed provisioning indistinguishable from one never attempted.
    */
   async claim(input: {
      workspaceId: string;
      provider: ScmProviderId;
      berryType: BerryType;
      berryId: string;
   }): Promise<void> {
      await this.#sql`
         INSERT INTO scm_links (workspace_id, provider, berry_type, berry_id, status)
         VALUES (${input.workspaceId}, ${input.provider}, ${input.berryType}, ${input.berryId},
                 'pending')
         ON CONFLICT (provider, berry_type, berry_id) DO UPDATE
            SET status = CASE
                            -- A retry after a failure is pending again; a link
                            -- already synced is left exactly as it is, so a
                            -- second create cannot unlink a live object.
                            WHEN scm_links.status = 'synced' THEN 'synced'
                            ELSE 'pending'
                         END,
                updated_at = now()`;
   }

   /** Records a successful provisioning, and what it produced. */
   async succeed(input: {
      workspaceId: string;
      provider: ScmProviderId;
      berryType: BerryType;
      berryId: string;
      externalId: number;
      externalNumber?: number | null;
      externalUrl?: string | null;
      externalUpdatedAt?: string | null;
   }): Promise<void> {
      await this.#sql`
         INSERT INTO scm_links (workspace_id, provider, berry_type, berry_id, external_id,
                                external_number, external_url, external_updated_at,
                                status, error, last_synced_at)
         VALUES (${input.workspaceId}, ${input.provider}, ${input.berryType}, ${input.berryId},
                 ${input.externalId}, ${input.externalNumber ?? null}, ${input.externalUrl ?? null},
                 ${input.externalUpdatedAt ?? null}, 'synced', NULL, now())
         ON CONFLICT (provider, berry_type, berry_id) DO UPDATE
            SET external_id = EXCLUDED.external_id,
                external_number = COALESCE(EXCLUDED.external_number, scm_links.external_number),
                external_url = COALESCE(EXCLUDED.external_url, scm_links.external_url),
                external_updated_at = COALESCE(EXCLUDED.external_updated_at,
                                               scm_links.external_updated_at),
                status = 'synced', error = NULL, last_synced_at = now(), updated_at = now()`;
   }

   /**
    * Records that provisioning failed, and why.
    *
    * The Berry object keeps existing. A project whose repository could not be
    * created is still a project — it simply has no repository, and says so.
    */
   async fail(input: {
      workspaceId: string;
      provider: ScmProviderId;
      berryType: BerryType;
      berryId: string;
      error: string;
   }): Promise<void> {
      await this.#sql`
         INSERT INTO scm_links (workspace_id, provider, berry_type, berry_id, status, error)
         VALUES (${input.workspaceId}, ${input.provider}, ${input.berryType}, ${input.berryId},
                 'failed', ${input.error.slice(0, 4000)})
         ON CONFLICT (provider, berry_type, berry_id) DO UPDATE
            -- A link that is already synced is not failed by a later error on
            -- some other operation; the object still exists on the host.
            SET status = CASE WHEN scm_links.status = 'synced' THEN 'synced' ELSE 'failed' END,
                error = ${input.error.slice(0, 4000)},
                updated_at = now()`;
   }

   /**
    * Notes that Berry has just written to the host.
    *
    * The stamp is what breaks the echo loop: an inbound webhook whose payload
    * is not newer than this is the change Berry itself just made, coming back.
    */
   async touch(input: {
      provider: ScmProviderId;
      berryType: BerryType;
      berryId: string;
      externalUpdatedAt: string | null;
   }): Promise<void> {
      await this.#sql`
         UPDATE scm_links
            SET external_updated_at = COALESCE(${input.externalUpdatedAt}, external_updated_at),
                last_synced_at = now(), updated_at = now()
          WHERE provider = ${input.provider} AND berry_type = ${input.berryType}
            AND berry_id = ${input.berryId}`;
   }

   /**
    * Whether an inbound event is news.
    *
    * True when the host's stamp is strictly newer than what Berry recorded on
    * its own last write. Equal is not newer: that is precisely the echo.
    */
   async isNews(
      provider: ScmProviderId,
      berryType: BerryType,
      berryId: string,
      externalUpdatedAt: string | null
   ): Promise<boolean> {
      if (!externalUpdatedAt) return true;
      const link = await this.find(provider, berryType, berryId);
      if (!link?.externalUpdatedAt) return true;
      return Date.parse(externalUpdatedAt) > Date.parse(link.externalUpdatedAt);
   }

   /** Marks a link whose host object has been deleted out from under Berry. */
   async detach(provider: ScmProviderId, berryType: BerryType, berryId: string): Promise<void> {
      await this.#sql`
         UPDATE scm_links
            SET status = 'detached', updated_at = now()
          WHERE provider = ${provider} AND berry_type = ${berryType} AND berry_id = ${berryId}`;
   }

   /** Everything in a workspace that is not healthy, for an operator to see. */
   async unhealthy(workspaceId: string, limit = 100): Promise<ScmLink[]> {
      const rows = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)} FROM scm_links
          WHERE workspace_id = ${workspaceId} AND status <> 'synced'
          ORDER BY updated_at DESC LIMIT ${limit}`;
      return rows.map(toLink);
   }
}

const COLUMNS = `id, workspace_id, provider, berry_type, berry_id, external_id, external_number,
                 external_url, external_updated_at, status, error, last_synced_at`;

function toLink(row: Record<string, unknown>): ScmLink {
   return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      provider: row.provider as ScmProviderId,
      berryType: row.berry_type as BerryType,
      berryId: row.berry_id as string,
      externalId: row.external_id === null ? null : Number(row.external_id),
      externalNumber: row.external_number === null ? null : Number(row.external_number),
      externalUrl: (row.external_url as string | null) ?? null,
      externalUpdatedAt: toRFC3339(row.external_updated_at as string | null),
      status: row.status as LinkStatus,
      error: (row.error as string | null) ?? null,
      lastSyncedAt: toRFC3339(row.last_synced_at as string | null),
   };
}
