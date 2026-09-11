import { McpClient, type McpServerConfig } from '@strands-agents/sdk';
import type { McpServerRef } from '../../runtime/envelope.ts';

/**
 * The agent's MCP servers, as Strands clients. Runs inside the container, so
 * it imports nothing but the SDK and the envelope's types (which the image
 * ships).
 *
 * Every server's tools are prefixed with its name, so two servers exposing
 * `search` cannot collide, and `continueOnError` keeps one unreachable server
 * from failing the whole task: its tools are simply missing.
 *
 * A server with an allowlist (a plugin's, carrying its admin-approved tools)
 * is filtered twice: Strands lists only those tools to the model, and the
 * permission table admits only those names, so an unapproved tool is neither
 * offered nor callable.
 */

export type EnvelopeMcpServerLike = McpServerRef;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function mcpServerConfigs(servers: EnvelopeMcpServerLike[]): Record<string, McpServerConfig> {
   const configs: Record<string, McpServerConfig> = {};
   for (const server of servers) {
      configs[server.name] = {
         url: server.url,
         // Strands names the transports 'streamable-http' | 'sse' | 'stdio'.
         // stdio is never offered: a workspace registers remote servers only.
         transport: server.transport === 'sse' ? 'sse' : 'streamable-http',
         headers: server.headers,
         prefix: server.name,
         continueOnError: true,
         // Strands compiles each pattern to a RegExp matched from the start of
         // the server-side name; anchoring the end too makes it an exact match.
         ...(server.allowedTools
            ? { toolFilters: { allowed: server.allowedTools.map((tool) => `^${escapeRegExp(tool)}$`) } }
            : {}),
      };
   }
   return configs;
}

/** Permission-table entries for allowlisted tools, under the agent-facing `<server>_<tool>` name. */
export function mcpToolPermissions(servers: EnvelopeMcpServerLike[]): Record<string, null> {
   const entries: Record<string, null> = {};
   for (const server of servers) {
      for (const tool of server.allowedTools ?? []) entries[`${server.name}_${tool}`] = null;
   }
   return entries;
}

export async function loadMcpClients(servers: EnvelopeMcpServerLike[]): Promise<McpClient[]> {
   if (servers.length === 0) return [];
   return McpClient.loadServers(mcpServerConfigs(servers));
}
