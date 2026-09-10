'use client';

import { McpServerManager } from '@/components/common/settings/mcp-servers';

/** The MCP servers this agent connects to: the workspace's, and its own. */
export default function AgentToolsTab({ agentId }: { agentId: string }) {
   return (
      <div className="flex max-w-3xl flex-col gap-6">
         <section className="flex flex-col gap-2">
            <h3 className="font-medium">Workspace servers</h3>
            <p className="text-muted-foreground">Managed in Settings → MCP servers.</p>
            <McpServerManager agentId={null} readOnly />
         </section>
         <section className="flex flex-col gap-2">
            <h3 className="font-medium">This agent’s servers</h3>
            <McpServerManager agentId={agentId} />
         </section>
      </div>
   );
}
