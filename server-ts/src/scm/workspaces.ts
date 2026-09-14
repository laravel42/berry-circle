import type { Sql } from '../db/pool.ts';
import type { ScmProvisioning } from './provisioning.ts';

/**
 * The GitHub organization a workspace's repositories live in.
 *
 * Resolved, never created. With Berry's own git server this derived a name and
 * provisioned one; a GitHub organization is an account with billing and
 * members, and Berry making one because somebody made a workspace would be a
 * surprising thing for a task tracker to do.
 */
export class ScmWorkspaces {
   readonly #sql: Sql;
   readonly #scm: ScmProvisioning;
   readonly #webhook: { url: string; secret: string } | null;

   constructor(
      sql: Sql,
      scm: ScmProvisioning,
      webhook: { url: string; secret: string } | null = null
   ) {
      this.#sql = sql;
      this.#scm = scm;
      this.#webhook = webhook;
   }

   /**
    * The owner new repositories in this workspace belong to.
    *
    * Returns null when the organization could not be provisioned. The caller
    * then has a choice to make — Berry does not silently fall back to some
    * other account, because a repository created in the wrong place is harder
    * to notice than one that was not created at all.
    */
   async owner(workspaceId: string): Promise<string | null> {
      // The organization a workspace's repositories live in is GitHub's, not
      // Berry's to invent: it is whatever account the App is installed on.
      // Berry records the mapping and does not create anything.
      const link = await this.#scm.linkFor('workspace', workspaceId);
      if (link?.status === 'synced' && link.externalUrl) {
         return link.externalUrl.split('/').pop() ?? null;
      }
      return null;
   }
}
