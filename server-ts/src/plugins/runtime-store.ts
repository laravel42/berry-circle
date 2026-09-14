import { randomBytes, randomUUID } from 'node:crypto';
import { secretMatches } from '../auth/tokens.ts';
import { toRFC3339, type Sql } from '../db/pool.ts';
import type { TimeCursor } from '../http/cursor.ts';
import { isApiScope, type ApiScope } from '../public-api/scopes.ts';
import { InvalidPluginInput } from './errors.ts';
import { generatePluginToken, parsePluginToken } from './tokens.ts';

/**
 * What a running plugin touches: the short-lived tokens it calls Berry with,
 * its key/value storage, and the log of every call Berry made to it.
 *
 * Tokens are stored as the digest of their secret half, like personal tokens.
 * Scopes are intersected with the installation's grant at resolve time, so an
 * admin narrowing a grant takes effect on tokens already handed out.
 */

export interface PluginPrincipal {
   installationId: string;
   workspaceId: string;
   pluginKey: string;
   installedBy: string;
   scopes: ApiScope[];
}

export class PluginTokenInvalid extends Error {
   override readonly name = 'PluginTokenInvalid';
}

export interface StoredValue {
   key: string;
   value: unknown;
   updatedAt: string;
}

export type InvocationKind = 'event' | 'schedule' | 'surface' | 'mcp';

export interface PluginInvocation {
   id: string;
   kind: InvocationKind;
   trigger: string;
   status: 'ok' | 'error';
   httpStatus: number | null;
   durationMs: number;
   error: string | null;
   createdAt: string;
}

const STORAGE_KEY = /^[A-Za-z0-9._:/-]{1,200}$/;
const MAX_VALUE_BYTES = 65_536;

export function validStorageKey(key: string): boolean {
   return STORAGE_KEY.test(key);
}

export class PluginRuntimeStore {
   readonly #sql: Sql;
   readonly #clock: () => Date;
   readonly #random: (size: number) => Buffer;

   constructor(options: { sql: Sql; clock?: () => Date; random?: (size: number) => Buffer }) {
      this.#sql = options.sql;
      this.#clock = options.clock ?? (() => new Date());
      this.#random = options.random ?? randomBytes;
   }

   async mintToken(input: {
      workspaceId: string;
      installationId: string;
      scopes: readonly ApiScope[];
      ttlMs: number;
   }): Promise<{ token: string; expiresAt: string }> {
      const generated = generatePluginToken(this.#random);
      const now = this.#clock();
      const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString();
      await this.#sql`
         INSERT INTO plugin_tokens (id, workspace_id, installation_id, public_id, secret_hash, scopes, expires_at, created_at)
         VALUES (${randomUUID()}, ${input.workspaceId}, ${input.installationId}, ${generated.publicId},
                 ${generated.secretHash}, ${this.#sql.array([...input.scopes])}, ${expiresAt}, ${now.toISOString()})`;
      return { token: generated.token, expiresAt };
   }

   async resolveToken(token: string): Promise<PluginPrincipal> {
      let parsed: { publicId: string; secret: string };
      try {
         parsed = parsePluginToken(token);
      } catch {
         throw new PluginTokenInvalid();
      }
      const [row] = await this.#sql`
         SELECT t.secret_hash, t.expires_at, t.scopes, i.id AS installation_id, i.workspace_id,
                i.plugin_key, i.installed_by, i.granted_scopes
           FROM plugin_tokens AS t
           JOIN plugin_installations AS i ON i.id = t.installation_id AND i.enabled
          WHERE t.public_id = ${parsed.publicId}`;
      if (!row) throw new PluginTokenInvalid();
      if (new Date(row.expires_at as string) <= this.#clock()) throw new PluginTokenInvalid();
      if (!secretMatches(parsed.secret, row.secret_hash as Buffer)) throw new PluginTokenInvalid();
      const granted = new Set((row.granted_scopes as string[]).filter(isApiScope));
      const scopes = (row.scopes as string[]).filter(isApiScope).filter((scope) => granted.has(scope)).sort();
      return {
         installationId: row.installation_id as string,
         workspaceId: row.workspace_id as string,
         pluginKey: row.plugin_key as string,
         installedBy: row.installed_by as string,
         scopes,
      };
   }

   async getValue(installationId: string, key: string): Promise<StoredValue | null> {
      const [row] = await this.#sql`
         SELECT key, value, updated_at FROM plugin_storage
          WHERE installation_id = ${installationId} AND key = ${key}`;
      return row ? toStored(row) : null;
   }

   async putValue(
      owner: { installationId: string; workspaceId: string },
      key: string,
      value: unknown
   ): Promise<StoredValue> {
      if (!validStorageKey(key)) {
         throw new InvalidPluginInput([{ path: '/key', message: 'Key must be 1 to 200 URL-safe characters.' }]);
      }
      const encoded = JSON.stringify(value);
      if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_VALUE_BYTES) {
         throw new InvalidPluginInput([{ path: '/value', message: 'Value must be JSON of at most 64 KB.' }]);
      }
      const now = this.#clock().toISOString();
      const [row] = await this.#sql`
         INSERT INTO plugin_storage (installation_id, workspace_id, key, value, updated_at)
         VALUES (${owner.installationId}, ${owner.workspaceId}, ${key}, ${this.#sql.json(value as never)}, ${now})
         ON CONFLICT (installation_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
         RETURNING key, value, updated_at`;
      if (!row) throw new Error('storage upsert returned no row');
      return toStored(row);
   }

   async deleteValue(installationId: string, key: string): Promise<boolean> {
      const result = await this.#sql`
         DELETE FROM plugin_storage WHERE installation_id = ${installationId} AND key = ${key}`;
      return result.count > 0;
   }

   async listValues(
      installationId: string,
      options: { prefix: string; after: string | null; limit: number }
   ): Promise<StoredValue[]> {
      const rows = await this.#sql`
         SELECT key, value, updated_at FROM plugin_storage
          WHERE installation_id = ${installationId}
            AND starts_with(key, ${options.prefix})
            AND (${options.after}::text IS NULL OR key > ${options.after})
          ORDER BY key
          LIMIT ${options.limit}`;
      return rows.map(toStored);
   }

   async recordInvocation(input: {
      workspaceId: string;
      installationId: string;
      kind: InvocationKind;
      trigger: string;
      status: 'ok' | 'error';
      httpStatus: number | null;
      durationMs: number;
      error: string | null;
   }): Promise<void> {
      await this.#sql`
         INSERT INTO plugin_invocations (
            id, workspace_id, installation_id, kind, trigger, status, http_status, duration_ms, error, created_at
         ) VALUES (
            ${randomUUID()}, ${input.workspaceId}, ${input.installationId}, ${input.kind},
            ${input.trigger.slice(0, 200)}, ${input.status}, ${input.httpStatus},
            ${Math.max(0, Math.round(input.durationMs))}, ${input.error?.slice(0, 500) ?? null},
            ${this.#clock().toISOString()}
         )`;
   }

   async listInvocations(
      workspaceId: string,
      installationId: string,
      cursor: TimeCursor | null,
      limit: number
   ): Promise<PluginInvocation[]> {
      const rows = await this.#sql`
         SELECT id, kind, trigger, status, http_status, duration_ms, error, created_at
           FROM plugin_invocations
          WHERE workspace_id = ${workspaceId} AND installation_id = ${installationId}
            AND (${cursor?.createdAt ?? null}::timestamptz IS NULL
                 OR (created_at, id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT ${limit}`;
      return rows.map((row) => ({
         id: row.id as string,
         kind: row.kind as InvocationKind,
         trigger: row.trigger as string,
         status: row.status === 'ok' ? 'ok' : 'error',
         httpStatus: (row.http_status as number | null) ?? null,
         durationMs: row.duration_ms as number,
         error: (row.error as string | null) ?? null,
         createdAt: toRFC3339(row.created_at as string) ?? '',
      }));
   }

   async pruneTokens(): Promise<number> {
      const result = await this.#sql`
         DELETE FROM plugin_tokens WHERE expires_at <= ${this.#clock().toISOString()}`;
      return result.count;
   }
}

function toStored(row: Record<string, unknown>): StoredValue {
   return {
      key: row.key as string,
      value: row.value,
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}
