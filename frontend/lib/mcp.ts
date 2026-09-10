import { z } from 'zod';
import { apiFetch } from './api';

/**
 * MCP servers an agent's loop connects to: workspace-wide (`agentId: null`) or
 * one agent's. Header values are write-only: the server returns only their
 * names, so this client never holds a stored credential.
 */

export const mcpTransportSchema = z.enum(['streamable_http', 'sse']);
export type McpTransport = z.infer<typeof mcpTransportSchema>;

export const mcpServerSchema = z.object({
   id: z.string(),
   agentId: z.string().nullable(),
   name: z.string(),
   url: z.string(),
   transport: mcpTransportSchema,
   headerNames: z.array(z.string()),
   viaGateway: z.boolean(),
   enabled: z.boolean(),
   createdAt: z.string(),
   updatedAt: z.string(),
});
export type McpServer = z.infer<typeof mcpServerSchema>;

export interface McpServerInput {
   agentId: string | null;
   name: string;
   url: string;
   transport: McpTransport;
   headers: Record<string, string>;
   viaGateway: boolean;
   enabled: boolean;
}

/** A partial update. `headers`, when sent, replaces every stored header. */
export type McpServerPatch = Partial<Omit<McpServerInput, 'agentId'>>;

function parse(json: unknown): McpServer {
   const parsed = mcpServerSchema.safeParse(json);
   if (!parsed.success) throw new Error('MCP server response was not recognized');
   return parsed.data;
}

/** `'workspace'` lists workspace-wide servers only; an agent id lists that agent's own. */
export async function listMcpServers(agentId?: string | 'workspace'): Promise<McpServer[]> {
   const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
   const json: unknown = await apiFetch(`/api/v1/mcp-servers${query}`);
   const parsed = z.object({ nodes: z.array(mcpServerSchema) }).safeParse(json);
   if (!parsed.success) throw new Error('MCP server list was not recognized');
   return parsed.data.nodes;
}

export const createMcpServer = async (input: McpServerInput) =>
   parse(await apiFetch('/api/v1/mcp-servers', { method: 'POST', body: JSON.stringify(input) }));

export const updateMcpServer = async (id: string, patch: McpServerPatch) =>
   parse(
      await apiFetch(`/api/v1/mcp-servers/${encodeURIComponent(id)}`, {
         method: 'PATCH',
         body: JSON.stringify(patch),
      })
   );

export async function deleteMcpServer(id: string): Promise<void> {
   await apiFetch(`/api/v1/mcp-servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
