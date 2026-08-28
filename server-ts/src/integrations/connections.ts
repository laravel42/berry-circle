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
   externalAccountName: string | null;
   scopes: string[];
   status: 'connected' | 'expired' | 'revoked' | 'disconnected' | string;
   expiresAt: string | null;
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
         SELECT id, workspace_id, provider, external_account_name, scopes, status, expires_at
           FROM integration_connections
          WHERE workspace_id = ${workspaceId}
            AND provider = ${provider}
            AND status <> 'disconnected'
          ORDER BY created_at DESC
          LIMIT 1`;
      return row ? toConnection(row) : null;
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

   #isExpired(expiresAt: string | null): boolean {
      if (expiresAt === null) return false;
      const expiry = Date.parse(toRFC3339(expiresAt) ?? expiresAt);
      if (Number.isNaN(expiry)) return false;
      return expiry - this.#margin <= this.#clock().getTime();
   }
}

interface ConnectionRow {
   id: string;
   workspace_id: string;
   provider: string;
   external_account_name: string | null;
   scopes: string[];
   status: string;
   expires_at: string | null;
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
      externalAccountName: row.external_account_name,
      scopes: row.scopes,
      status: row.status,
      expiresAt: toRFC3339(row.expires_at),
   };
}
