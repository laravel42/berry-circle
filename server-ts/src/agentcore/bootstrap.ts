import type { AgentCoreGatewayConfig } from '../config/config.ts';
import type { Logger } from '../observability/log.ts';
import { AgentCoreGitHubProvider } from '../scm/agentcore-github-provider.ts';
import type { ScmProvider } from '../scm/provider.ts';
import { AgentCoreGatewayClient, type ToolDefinition } from './gateway-client.ts';
import { AgentCoreIdentity } from './identity.ts';
import { missingRequired, resolveTools } from './tool-map.ts';

/**
 * Bringing the gateway up, once, at startup.
 *
 * Discovery happens here rather than lazily on the first call because of what
 * the failure looks like otherwise: a gateway that cannot create an issue
 * would be found out an hour later, when a plan compiles and a task silently
 * never reaches GitHub. Doing it at boot means somebody is watching.
 *
 * A gateway that cannot serve a required capability is reported and the
 * provider is *not* returned. Berry then runs without GitHub synchronisation
 * rather than with a broken half of it, which is the honest failure.
 */

export interface GatewayBootstrap {
   provider: ScmProvider | null;
   identity: AgentCoreIdentity;
   /** What the gateway offered, for a diagnostics endpoint. */
   tools: string[];
   missing: string[];
}

export async function startGateway(
   config: AgentCoreGatewayConfig,
   logger: Logger
): Promise<GatewayBootstrap> {
   const identity = new AgentCoreIdentity({
      region: config.region,
      providerName: config.githubProviderName,
      workloadName: config.workloadName,
   });

   const gateway = new AgentCoreGatewayClient({
      url: config.gatewayUrl,
      authorize: () => identity.gatewayHeaders(),
      observe: (call) => {
         // Never the arguments and never a header: a tool call's arguments
         // carry issue bodies and its headers carry the credential.
         logger.info('agentcore gateway call', {
            method: call.method,
            tool: call.tool,
            durationMs: call.durationMs,
            ok: call.ok,
            attempts: call.attempts,
            requestId: call.requestId,
            ...(call.errorKind ? { errorKind: call.errorKind } : {}),
         });
      },
   });

   let discovered: ToolDefinition[];
   try {
      discovered = await gateway.listTools();
   } catch (error: unknown) {
      // Not fatal to the process. A gateway that is down at boot should not
      // stop Berry from serving the workspace it already has.
      logger.error('agentcore gateway discovery failed', {
         error: error instanceof Error ? error.message : String(error),
         gatewayUrl: config.gatewayUrl,
      });
      return { provider: null, identity, tools: [], missing: ['*'] };
   }

   const resolved = resolveTools(discovered, config.toolOverrides);
   const problems = (resolved as unknown as { problems?: string[] }).problems ?? [];
   for (const problem of problems) {
      logger.error('agentcore tool mapping problem', { problem });
   }

   const missing = missingRequired(resolved);
   if (missing.length > 0) {
      logger.error('agentcore gateway is missing required GitHub tools', {
         missing,
         discovered: resolved.tools().slice(0, 40),
      });
      return { provider: null, identity, tools: resolved.tools(), missing };
   }

   logger.info('agentcore gateway ready', {
      tools: discovered.length,
      capabilities: resolved.available(),
   });

   return {
      provider: new AgentCoreGitHubProvider({
         gateway,
         tools: resolved,
         definitions: new Map(discovered.map((tool) => [tool.name, tool])),
         gitCredential: () => identity.gitCredential(),
      }),
      identity,
      tools: resolved.tools(),
      missing: [],
   };
}
