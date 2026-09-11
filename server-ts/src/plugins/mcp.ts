import type { McpTransport } from '../runtime/envelope.ts';
import type { PluginRepository } from './repository.ts';
import type { PluginRuntimeStore } from './runtime-store.ts';

/**
 * A plugin's remote MCP server, as an agent run sees it.
 *
 * Only tools an admin approved are listed, and a plugin with none approved is
 * left out entirely — declaring a tool in a manifest is a request, not a
 * grant. The bearer token is minted per call so it expires with the run it
 * was handed to; `ttlMs` should be that run's lease horizon.
 */

export interface PluginMcpServer {
   name: string;
   url: string;
   transport: McpTransport;
   headers: Record<string, string>;
   allowedTools: string[];
   installationId: string;
}

export async function pluginMcpServers(
   deps: { plugins: PluginRepository; runtime: PluginRuntimeStore },
   workspaceId: string,
   ttlMs: number
): Promise<PluginMcpServer[]> {
   const servers: PluginMcpServer[] = [];
   for (const installation of await deps.plugins.listEnabled(workspaceId)) {
      const mcp = installation.manifest.mcp;
      if (!mcp) continue;
      const allowedTools = mcp.tools
         .map((tool) => tool.name)
         .filter((name) => installation.approvedTools.includes(name));
      if (allowedTools.length === 0) continue;
      const { token } = await deps.runtime.mintToken({
         workspaceId,
         installationId: installation.id,
         scopes: installation.grantedScopes,
         ttlMs,
      });
      await deps.runtime.recordInvocation({
         workspaceId, installationId: installation.id, kind: 'mcp', trigger: 'agent-session',
         status: 'ok', httpStatus: null, durationMs: 0, error: null,
      });
      servers.push({
         name: `plugin-${installation.key}`,
         url: installation.manifest.baseUrl.replace(/\/+$/, '') + mcp.path,
         transport: 'streamable_http',
         headers: { Authorization: `Bearer ${token}` },
         allowedTools,
         installationId: installation.id,
      });
   }
   return servers;
}
