import type { Sql } from '../db/pool.ts';
import { toRFC3339 } from '../db/pool.ts';
import type { Sealer } from './sealing.ts';

/**
 * A workspace's connection to a provider.
 *
 * The token is not part of the connection. Reading a connection tells you that
 * one exists, who it belongs to and whether it is usable; getting the
 * credential is a separate, deliberate call — so a listing, a serializer or a
 * log line cannot carry a secret it never asked for.
 */

export interface Connection {
   id: string;
   workspaceId: string;
   provider: string;
   externalAccountId: string | null;
   externalAccountName: string | null;
   scopes: string[];
   status: 'connected' | 'expired' | 'revoked' | 'disconnected' | string;
   statusDetail: string | null;
   expiresAt: string | null;
   createdAt: string;
   updatedAt: string;
}

export interface ToolGrant {
   /** Null for a grant that applies to every agent in the workspace. */
   agentId: string | null;
   provider: string;
   tool: string;
   maxEffect: string;
}

export class ConnectionUnavailable extends Error {
   override readonly name = 'ConnectionUnavailable';
   /** Distinguishes "connect GitHub" from "reconnect GitHub" for the caller. */
   readonly reason: 'missing' | 'expired' | 'unusable';
   constructor(message: string, reason: 'missing' | 'expired' | 'unusable') {
      super(message);
      this.reason = reason;
   }
}

export interface ConnectionRepositoryOptions {
   sql: Sql;
   sealer: Sealer;
   clock?: () => Date;
   /**
    * How long before expiry a token stops being handed out.
    *
    * A token that expires mid-clone fails halfway through, leaving a branch
    * that exists and a push that never happened. Refusing it slightly early
    * turns that into a clean "reconnect GitHub".
    */
   expiryMarginMs?: number;
}

const DEFAULT_EXPIRY_MARGIN_MS = 60_000;

export class ConnectionRepository {
   readonly #sql: Sql;
   readonly #sealer: Sealer;
   readonly #clock: () => Date;
   readonly #margin: number;

   constructor(options: ConnectionRepositoryOptions) {
      this.#sql = options.sql;
      this.#sealer = options.sealer;
      this.#clock = options.clock ?? (() => new Date());
      this.#margin = options.expiryMarginMs ?? DEFAULT_EXPIRY_MARGIN_MS;
   }

   /** The workspace's live connection for a provider, or null. */
   async find(workspaceId: string, provider: string): Promise<Connection | null> {
      const [row] = await this.#sql<ConnectionRow[]>`
         SELECT ${this.#sql.unsafe(COLUMNS)}
           FROM integration_connections
          WHERE workspace_id = ${workspaceId}
            AND provider = ${provider}
            AND status <> 'disconnected'
          ORDER BY created_at DESC
          LIMIT 1`;
      return row ? this.#reported(toConnection(row)) : null;
   }

   /** Every live connection in the workspace, for the settings page. */
   async list(workspaceId: string): Promise<Connection[]> {
      const rows = await this.#sql<ConnectionRow[]>`
         SELECT ${this.#sql.unsafe(COLUMNS)}
           FROM integration_connections
          WHERE workspace_id = ${workspaceId} AND status <> 'disconnected'
          ORDER BY provider ASC`;
      return rows.map((row) => this.#reported(toConnection(row)));
   }

   /**
    * Records a credential the OAuth exchange just returned.
    *
    * One live connection per provider per workspace: reconnecting replaces
    * rather than accumulates, so `token` never has to guess which of several
    * rows is the real one. The previous row is marked disconnected rather than
    * deleted, because it is the record of an access that existed.
    *
    * The token is sealed here and nowhere else, so there is exactly one place
    * in the server where a provider credential is written in the clear.
    */
   async save(input: {
      workspaceId: string;
      provider: string;
      connectedByUserId: string;
      accessToken: string;
      refreshToken?: string | null;
      expiresAt?: string | null;
      scopes?: string[];
      externalAccountId?: string | null;
      externalAccountName?: string | null;
   }): Promise<Connection> {
      const now = this.#clock().toISOString();
      return this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         await tx`
            UPDATE integration_connections
               SET status = 'disconnected', status_detail = 'replaced by a new connection',
                   access_token_encrypted = NULL, refresh_token_encrypted = NULL,
                   updated_at = ${now}
             WHERE workspace_id = ${input.workspaceId}
               AND provider = ${input.provider}
               AND status <> 'disconnected'`;

         const [row] = await tx<ConnectionRow[]>`
            INSERT INTO integration_connections
               (workspace_id, provider, connected_by_user_id, external_account_id,
                external_account_name, access_token_encrypted, refresh_token_encrypted,
                expires_at, scopes, status, created_at, updated_at)
            VALUES (${input.workspaceId}, ${input.provider}, ${input.connectedByUserId},
                    ${input.externalAccountId ?? null}, ${input.externalAccountName ?? null},
                    ${this.#sealer.seal(input.accessToken)},
                    ${input.refreshToken ? this.#sealer.seal(input.refreshToken) : null},
                    ${input.expiresAt ?? null}, ${input.scopes ?? []}, 'connected',
                    ${now}, ${now})
            RETURNING ${tx.unsafe(COLUMNS)}`;
         return toConnection(row!);
      }) as Promise<Connection>;
   }

   /**
    * Ends a connection, and every grant that rode on it.
    *
    * The credential is cleared rather than kept beside a `disconnected`
    * status: a token nothing will ever use again is only a liability.
    */
   async disconnect(workspaceId: string, provider: string): Promise<boolean> {
      const now = this.#clock().toISOString();
      return this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const rows = await tx`
            UPDATE integration_connections
               SET status = 'disconnected', status_detail = 'disconnected by a person',
                   access_token_encrypted = NULL, refresh_token_encrypted = NULL,
                   updated_at = ${now}
             WHERE workspace_id = ${workspaceId} AND provider = ${provider}
               AND status <> 'disconnected'
             RETURNING id`;
         if (rows.length === 0) return false;
         await tx`
            DELETE FROM integration_permissions
             WHERE workspace_id = ${workspaceId} AND provider = ${provider}`;
         return true;
      }) as Promise<boolean>;
   }

   /**
    * The credential itself, opened for one use.
    *
    * Separate from `find` so that reaching a secret is always an explicit act
    * in the code that needs it. Every refusal names why, because "connect
    * GitHub" and "reconnect GitHub" are different things to tell someone.
    */
   async token(workspaceId: string, provider: string): Promise<string> {
      const [row] = await this.#sql<TokenRow[]>`
         SELECT status, expires_at, access_token_encrypted
           FROM integration_connections
          WHERE workspace_id = ${workspaceId}
            AND provider = ${provider}
            AND status <> 'disconnected'
          ORDER BY created_at DESC
          LIMIT 1`;

      if (!row) {
         throw new ConnectionUnavailable(`${provider} is not connected to this workspace`, 'missing');
      }
      if (row.status !== 'connected') {
         throw new ConnectionUnavailable(
            `the ${provider} connection is ${row.status}`,
            row.status === 'expired' ? 'expired' : 'unusable'
         );
      }
      if (row.access_token_encrypted === null) {
         throw new ConnectionUnavailable(`the ${provider} connection holds no credential`, 'unusable');
      }
      if (this.#isExpired(row.expires_at)) {
         throw new ConnectionUnavailable(`the ${provider} credential has expired`, 'expired');
      }

      // Opened last, so a connection that was never going to work has already
      // been refused without the key being touched.
      return this.#sealer.open(Buffer.from(row.access_token_encrypted));
   }

   /**
    * Grants recorded against this workspace.
    *
    * A row here is a deliberate decision someone made; the absence of one
    * means the provider's default applies, which is the caller's business to
    * fill in rather than this repository's to invent.
    */
   async grants(workspaceId: string): Promise<ToolGrant[]> {
      const rows = await this.#sql`
         SELECT agent_id, provider, tool, max_effect
           FROM integration_permissions
          WHERE workspace_id = ${workspaceId}
          ORDER BY provider ASC, tool ASC`;
      return rows.map((row) => ({
         agentId: (row.agent_id as string | null) ?? null,
         provider: row.provider as string,
         tool: row.tool as string,
         maxEffect: row.max_effect as string,
      }));
   }

   /**
    * The status a reader should see, which is not always the column.
    *
    * Nothing writes `expired` to the row: a connection keeps saying
    * `connected` until something tries to use its token and is refused, so the
    * settings page can show a provider green for days after its credential
    * lapsed. Deriving it here — off the same clock and margin `token` refuses
    * on — is what stops the page and the call from disagreeing.
    */
   #reported(connection: Connection): Connection {
      if (connection.status !== 'connected' || !this.#isExpired(connection.expiresAt)) {
         return connection;
      }
      return {
         ...connection,
         status: 'expired',
         statusDetail: connection.statusDetail ?? 'The credential expired. Reconnect to continue.',
      };
   }

   #isExpired(expiresAt: string | null): boolean {
      if (expiresAt === null) return false;
      const expiry = Date.parse(toRFC3339(expiresAt) ?? expiresAt);
      if (Number.isNaN(expiry)) return false;
      return expiry - this.#margin <= this.#clock().getTime();
   }
}

const COLUMNS = `id, workspace_id, provider, external_account_id, external_account_name,
   scopes, status, status_detail, expires_at, created_at, updated_at`;

interface ConnectionRow {
   id: string;
   workspace_id: string;
   provider: string;
   external_account_id: string | null;
   external_account_name: string | null;
   scopes: string[];
   status: string;
   status_detail: string | null;
   expires_at: string | null;
   created_at: string;
   updated_at: string;
}

interface TokenRow {
   status: string;
   expires_at: string | null;
   access_token_encrypted: Uint8Array | null;
}

function toConnection(row: ConnectionRow): Connection {
   return {
      id: row.id,
      workspaceId: row.workspace_id,
      provider: row.provider,
      externalAccountId: row.external_account_id,
      externalAccountName: row.external_account_name,
      scopes: row.scopes ?? [],
      status: row.status,
      statusDetail: row.status_detail,
      expiresAt: toRFC3339(row.expires_at),
      createdAt: toRFC3339(row.created_at) ?? '',
      updatedAt: toRFC3339(row.updated_at) ?? '',
   };
}
