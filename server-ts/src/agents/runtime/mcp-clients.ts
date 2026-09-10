import { McpClient, type McpServerConfig } from '@strands-agents/sdk';

/**
 * The agent's MCP servers, as Strands clients. Runs inside the container, so
 * it imports nothing from outside `agents/runtime/` but the SDK.
 *
 * Every server's tools are prefixed with its name, so two servers exposing
 * `search` cannot collide, and `continueOnError` keeps one unreachable server
 * from failing the whole task: its tools are simply missing.
 */

/** Structurally A's `McpServerRef`. */
export interface EnvelopeMcpServerLike {
   name: string;
   url: string;
   transport: 'http' | 'sse';
   headers: Record<string, string>;
}

export function mcpServerConfigs(servers: EnvelopeMcpServerLike[]): Record<string, McpServerConfig> {
   const configs: Record<string, McpServerConfig> = {};
   for (const server of servers) {
      configs[server.name] = {
         url: server.url,
         // Strands names the transports 'streamable-http' | 'sse' | 'stdio'; the
         // envelope's 'http' is streamable HTTP. stdio is never offered: a
         // workspace registers remote servers only.
         transport: server.transport === 'sse' ? 'sse' : 'streamable-http',
         headers: server.headers,
         prefix: server.name,
         continueOnError: true,
      };
   }
   return configs;
}

export async function loadMcpClients(servers: EnvelopeMcpServerLike[]): Promise<McpClient[]> {
   if (servers.length === 0) return [];
   return McpClient.loadServers(mcpServerConfigs(servers));
}
