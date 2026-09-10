import { randomBytes, randomUUID } from 'node:crypto';
import { toRFC3339, type Queryable, type Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import type { Sealer } from '../integrations/sealing.ts';
import { isApiScope, type ApiScope } from '../public-api/scopes.ts';
import { InvalidPluginInput, PluginAlreadyInstalled } from './errors.ts';
import { appendPluginEvent } from './events.ts';
import {
   pluginManifestSchema,
   validateConfig,
   type PluginConfig,
   type PluginManifest,
   type PluginPackage,
} from './manifest.ts';
import { generateSigningSecret } from './tokens.ts';

/**
 * Installed plugins, one workspace at a time.
 *
 * Every method takes the workspace id and filters on it, and every write takes
 * the caller's transaction — the mount obtains that from `ScopedDb.mutate`, so
 * a write cannot happen without the membership and permission check.
 */

export interface PluginInstallation {
   id: string;
   workspaceId: string;
   key: string;
   name: string;
   version: string;
   description: string;
   manifest: PluginManifest;
   source: 'url' | 'upload';
   sourceUrl: string | null;
   enabled: boolean;
   config: PluginConfig;
   grantedScopes: ApiScope[];
   secretNames: string[];
   approvedTools: string[];
   installedBy: string;
   createdAt: string;
   updatedAt: string;
}

const COLUMNS = `i.id, i.workspace_id, i.plugin_key, i.name, i.version, i.manifest, i.source,
   i.source_url, i.enabled, i.config, i.granted_scopes, i.installed_by, i.created_at, i.updated_at,
   COALESCE((SELECT array_agg(s.name ORDER BY s.name) FROM plugin_secrets s
              WHERE s.installation_id = i.id), '{}') AS secret_names,
   COALESCE((SELECT array_agg(a.tool_name ORDER BY a.tool_name) FROM plugin_tool_approvals a
              WHERE a.installation_id = i.id), '{}') AS approved_tools`;

export interface PluginRepositoryOptions {
   sql: Sql;
   sealer: Sealer;
   clock?: () => Date;
   random?: (size: number) => Buffer;
}

export class PluginRepository {
   readonly #sql: Sql;
   readonly #sealer: Sealer;
   readonly #clock: () => Date;
   readonly #random: (size: number) => Buffer;

   constructor(options: PluginRepositoryOptions) {
      this.#sql = options.sql;
      this.#sealer = options.sealer;
      this.#clock = options.clock ?? (() => new Date());
      this.#random = options.random ?? randomBytes;
   }

   async install(
      tx: Queryable,
      input: {
         workspaceId: string;
         installedBy: string;
         pkg: PluginPackage;
         source: 'url' | 'upload';
         sourceUrl: string | null;
         config: unknown;
      }
   ): Promise<{ installation: PluginInstallation; signingSecret: string }> {
      const manifest = input.pkg.manifest;
      const config = validateConfig(manifest, input.config ?? {});
      const id = randomUUID();
      const now = this.#clock().toISOString();
      const signingSecret = generateSigningSecret(this.#random);

      await tx`
         INSERT INTO plugin_installations (
            id, workspace_id, plugin_key, name, version, manifest, source, source_url, base_url,
            enabled, config, granted_scopes, signing_secret_encrypted, installed_by, created_at, updated_at
         ) VALUES (
            ${id}, ${input.workspaceId}, ${manifest.key}, ${manifest.name}, ${manifest.version},
            ${tx.json(manifest as never)}, ${input.source}, ${input.sourceUrl}, ${manifest.baseUrl},
            true, ${tx.json(config as never)}, ${tx.array([...manifest.scopes])},
            ${this.#sealer.seal(signingSecret)}, ${input.installedBy}, ${now}, ${now}
         )`.catch((error: unknown) => {
         if ((error as { code?: string }).code === '23505') throw new PluginAlreadyInstalled();
         throw error;
      });

      for (const file of input.pkg.files) {
         await tx`
            INSERT INTO plugin_files (installation_id, workspace_id, path, content)
            VALUES (${id}, ${input.workspaceId}, ${file.path}, ${file.content})`;
      }
      for (const hook of manifest.hooks) {
         if (hook.trigger !== 'schedule') continue;
         const next = new Date(Date.parse(now) + hook.everyMinutes * 60_000).toISOString();
         await tx`
            INSERT INTO plugin_hook_state (installation_id, workspace_id, hook_key, interval_minutes, next_fire_at)
            VALUES (${id}, ${input.workspaceId}, ${hook.key}, ${hook.everyMinutes}, ${next})`;
      }
      await appendPluginEvent(tx, 'plugin.installed', input.workspaceId, id, manifest.key, now);
      return { installation: await readOne(tx, input.workspaceId, id), signingSecret };
   }

   async list(workspaceId: string): Promise<PluginInstallation[]> {
      const rows = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)} FROM plugin_installations AS i
          WHERE i.workspace_id = ${workspaceId}
          ORDER BY i.name, i.id`;
      return rows.map(toInstallation);
   }

   async listEnabled(workspaceId: string): Promise<PluginInstallation[]> {
      return (await this.list(workspaceId)).filter((installation) => installation.enabled);
   }

   async get(workspaceId: string, id: string): Promise<PluginInstallation> {
      return readOne(this.#sql, workspaceId, id);
   }

   async update(
      tx: Queryable,
      workspaceId: string,
      id: string,
      patch: { enabled?: boolean | undefined; config?: unknown }
   ): Promise<PluginInstallation> {
      const [locked] = await tx`
         SELECT manifest, enabled, config FROM plugin_installations
          WHERE id = ${id} AND workspace_id = ${workspaceId}
          FOR UPDATE`;
      if (!locked) throw new NotFound();
      const manifest = pluginManifestSchema.parse(locked.manifest);
      const config = patch.config === undefined ? (locked.config as PluginConfig) : validateConfig(manifest, patch.config);
      const enabled = patch.enabled ?? (locked.enabled as boolean);
      const now = this.#clock().toISOString();
      await tx`
         UPDATE plugin_installations
            SET enabled = ${enabled}, config = ${tx.json(config as never)}, updated_at = ${now}
          WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      await appendPluginEvent(tx, 'plugin.updated', workspaceId, id, manifest.key, now);
      return readOne(tx, workspaceId, id);
   }

   async uninstall(tx: Queryable, workspaceId: string, id: string): Promise<void> {
      const [removed] = await tx`
         DELETE FROM plugin_installations WHERE id = ${id} AND workspace_id = ${workspaceId}
         RETURNING plugin_key`;
      if (!removed) throw new NotFound();
      await appendPluginEvent(
         tx,
         'plugin.uninstalled',
         workspaceId,
         id,
         removed.plugin_key as string,
         this.#clock().toISOString()
      );
   }

   async setSecret(tx: Queryable, workspaceId: string, id: string, name: string, value: string): Promise<void> {
      const manifest = await lockedManifest(tx, workspaceId, id);
      if (!manifest.secrets.some((secret) => secret.name === name)) {
         throw new InvalidPluginInput([{ path: '/name', message: 'The plugin does not declare this secret.' }]);
      }
      if (value.length < 1 || value.length > 4096) {
         throw new InvalidPluginInput([{ path: '/value', message: 'Secret must contain 1 to 4096 characters.' }]);
      }
      const now = this.#clock().toISOString();
      await tx`
         INSERT INTO plugin_secrets (installation_id, workspace_id, name, value_encrypted, updated_at)
         VALUES (${id}, ${workspaceId}, ${name}, ${this.#sealer.seal(value)}, ${now})
         ON CONFLICT (installation_id, name)
         DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted, updated_at = EXCLUDED.updated_at`;
   }

   async deleteSecret(tx: Queryable, workspaceId: string, id: string, name: string): Promise<void> {
      await lockedManifest(tx, workspaceId, id);
      await tx`
         DELETE FROM plugin_secrets
          WHERE installation_id = ${id} AND workspace_id = ${workspaceId} AND name = ${name}`;
   }

   /** Decrypted secrets, for the hook call body only. Never serialized to a client. */
   async openSecrets(workspaceId: string, id: string): Promise<Record<string, string>> {
      const rows = await this.#sql`
         SELECT name, value_encrypted FROM plugin_secrets
          WHERE installation_id = ${id} AND workspace_id = ${workspaceId}`;
      const secrets: Record<string, string> = {};
      for (const row of rows) {
         secrets[row.name as string] = this.#sealer.open(Buffer.from(row.value_encrypted as Buffer));
      }
      return secrets;
   }

   async signingSecret(workspaceId: string, id: string): Promise<string> {
      const [row] = await this.#sql`
         SELECT signing_secret_encrypted FROM plugin_installations
          WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      if (!row) throw new NotFound();
      return this.#sealer.open(Buffer.from(row.signing_secret_encrypted as Buffer));
   }

   async setToolApproval(
      tx: Queryable,
      workspaceId: string,
      id: string,
      tool: string,
      approved: boolean,
      userId: string
   ): Promise<void> {
      const manifest = await lockedManifest(tx, workspaceId, id);
      if (!(manifest.mcp?.tools ?? []).some((declared) => declared.name === tool)) {
         throw new InvalidPluginInput([{ path: '/tool', message: 'The plugin does not declare this tool.' }]);
      }
      if (approved) {
         await tx`
            INSERT INTO plugin_tool_approvals (installation_id, workspace_id, tool_name, approved_by, approved_at)
            VALUES (${id}, ${workspaceId}, ${tool}, ${userId}, ${this.#clock().toISOString()})
            ON CONFLICT (installation_id, tool_name) DO NOTHING`;
      } else {
         await tx`
            DELETE FROM plugin_tool_approvals
             WHERE installation_id = ${id} AND workspace_id = ${workspaceId} AND tool_name = ${tool}`;
      }
   }

   async files(workspaceId: string, id: string): Promise<{ path: string; size: number }[]> {
      await this.get(workspaceId, id);
      const rows = await this.#sql`
         SELECT path, octet_length(content) AS size FROM plugin_files
          WHERE installation_id = ${id} AND workspace_id = ${workspaceId}
          ORDER BY path`;
      return rows.map((row) => ({ path: row.path as string, size: Number(row.size) }));
   }
}

async function readOne(sql: Queryable, workspaceId: string, id: string): Promise<PluginInstallation> {
   const [row] = await sql`
      SELECT ${sql.unsafe(COLUMNS)} FROM plugin_installations AS i
       WHERE i.id = ${id} AND i.workspace_id = ${workspaceId}`;
   if (!row) throw new NotFound();
   return toInstallation(row);
}

async function lockedManifest(tx: Queryable, workspaceId: string, id: string): Promise<PluginManifest> {
   const [row] = await tx`
      SELECT manifest FROM plugin_installations
       WHERE id = ${id} AND workspace_id = ${workspaceId}
       FOR UPDATE`;
   if (!row) throw new NotFound();
   return pluginManifestSchema.parse(row.manifest);
}

function toInstallation(row: Record<string, unknown>): PluginInstallation {
   const manifest = pluginManifestSchema.parse(row.manifest);
   return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      key: row.plugin_key as string,
      name: row.name as string,
      version: row.version as string,
      description: manifest.description,
      manifest,
      source: row.source === 'url' ? 'url' : 'upload',
      sourceUrl: (row.source_url as string | null) ?? null,
      enabled: row.enabled as boolean,
      config: row.config as PluginConfig,
      grantedScopes: (row.granted_scopes as string[]).filter(isApiScope),
      secretNames: row.secret_names as string[],
      approvedTools: row.approved_tools as string[],
      installedBy: row.installed_by as string,
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}
