import { randomUUID } from 'node:crypto';
import { toRFC3339, type Queryable, type Sql } from '../db/pool.ts';
import { Conflict, NotFound } from '../identity/errors.ts';
import type { Sealer } from '../integrations/sealing.ts';

import type { McpTransport } from '../runtime/envelope.ts';

export type { McpTransport };

export interface McpServer {
   id: string;
   agentId: string | null;
   name: string;
   url: string;
   transport: McpTransport;
   headerNames: string[];
   viaGateway: boolean;
   enabled: boolean;
   createdAt: string;
   updatedAt: string;
}

export interface McpServerInput {
   agentId: string | null;
   name: string;
   url: string;
   transport: McpTransport;
   headers: Record<string, string>;
   viaGateway: boolean;
   enabled: boolean;
}

/** A partial update; a field left undefined (or absent) keeps its value. */
export type McpServerPatch = { [K in keyof McpServerInput]?: McpServerInput[K] | undefined };

const COLUMNS = `id, agent_id, name, url, transport, header_names, via_gateway, enabled, created_at, updated_at`;

export class McpServerRepository {
   readonly #sql: Sql;
   readonly #sealer: Sealer;

   constructor(options: { sql: Sql; sealer: Sealer }) {
      this.#sql = options.sql;
      this.#sealer = options.sealer;
   }

   async list(workspaceId: string, agentId: string | null | 'all'): Promise<McpServer[]> {
      const rows = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)} FROM mcp_servers
          WHERE workspace_id = ${workspaceId}
            AND (${agentId === 'all'} OR agent_id IS NOT DISTINCT FROM ${agentId === 'all' ? null : agentId}::uuid)
          ORDER BY agent_id NULLS FIRST, name`;
      return rows.map(toServer);
   }

   async create(workspaceId: string, input: McpServerInput, userId: string): Promise<McpServer> {
      const sealed = this.#seal(input.headers);
      const [row] = await this.#sql`
         INSERT INTO mcp_servers (id, workspace_id, agent_id, name, url, transport, headers_sealed,
                                  header_names, via_gateway, enabled, created_by)
         VALUES (${randomUUID()}, ${workspaceId}, ${input.agentId}, ${input.name}, ${input.url},
                 ${input.transport}, ${sealed.bytes}, ${sealed.names}, ${input.viaGateway},
                 ${input.enabled}, ${userId})
         RETURNING ${this.#sql.unsafe(COLUMNS)}`.catch(classify);
      return toServer(row as Record<string, unknown>);
   }

   async update(workspaceId: string, id: string, patch: McpServerPatch): Promise<McpServer> {
      const sealed = patch.headers === undefined ? null : this.#seal(patch.headers);
      const [row] = await this.#sql`
         UPDATE mcp_servers SET
            name = COALESCE(${patch.name ?? null}, name),
            url = COALESCE(${patch.url ?? null}, url),
            transport = COALESCE(${patch.transport ?? null}, transport),
            via_gateway = COALESCE(${patch.viaGateway ?? null}::boolean, via_gateway),
            enabled = COALESCE(${patch.enabled ?? null}::boolean, enabled),
            headers_sealed = CASE WHEN ${sealed !== null} THEN ${sealed?.bytes ?? null}::bytea ELSE headers_sealed END,
            header_names = CASE WHEN ${sealed !== null} THEN ${sealed?.names ?? []}::text[] ELSE header_names END,
            updated_at = now()
          WHERE id = ${id} AND workspace_id = ${workspaceId}
          RETURNING ${this.#sql.unsafe(COLUMNS)}`.catch(classify);
      if (!row) throw new NotFound();
      return toServer(row);
   }

   async remove(workspaceId: string, id: string): Promise<void> {
      const deleted = await this.#sql`DELETE FROM mcp_servers WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      if (deleted.count !== 1) throw new NotFound();
   }

   static async copyForAgent(tx: Queryable, fromAgentId: string, toAgentId: string): Promise<void> {
      await tx`
         INSERT INTO mcp_servers (workspace_id, agent_id, name, url, transport, headers_sealed,
                                  header_names, via_gateway, enabled, created_by)
         SELECT workspace_id, ${toAgentId}, name, url, transport, headers_sealed, header_names,
                via_gateway, enabled, created_by
           FROM mcp_servers WHERE agent_id = ${fromAgentId}`;
   }

   /** Envelope-only: the one path where header values leave the database opened. */
   async forAgent(workspaceId: string, agentId: string): Promise<(McpServer & { headers: Record<string, string> })[]> {
      const rows = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)}, headers_sealed FROM mcp_servers
          WHERE workspace_id = ${workspaceId} AND enabled
            AND (agent_id IS NULL OR agent_id = ${agentId})
          ORDER BY agent_id NULLS FIRST, name`;
      return rows.map((row) => ({
         ...toServer(row),
         headers: row.headers_sealed
            ? (JSON.parse(this.#sealer.open(Buffer.from(row.headers_sealed as Buffer))) as Record<string, string>)
            : {},
      }));
   }

   #seal(headers: Record<string, string>): { bytes: Buffer | null; names: string[] } {
      const names = Object.keys(headers).sort();
      if (names.length === 0) return { bytes: null, names };
      return { bytes: this.#sealer.seal(JSON.stringify(headers)), names };
   }
}

function toServer(row: Record<string, unknown>): McpServer {
   return {
      id: row.id as string,
      agentId: (row.agent_id as string | null) ?? null,
      name: row.name as string,
      url: row.url as string,
      transport: row.transport as McpTransport,
      headerNames: (row.header_names as string[] | null) ?? [],
      viaGateway: row.via_gateway === true,
      enabled: row.enabled === true,
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}

function classify(error: unknown): never {
   const code = (error as { code?: string }).code;
   if (code === '23505') throw new Conflict();
   if (code === '23503') throw new NotFound();
   throw error;
}
