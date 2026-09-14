import {
   BedrockAgentCoreControlClient,
   GetAgentRuntimeCommand,
   UpdateAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

/**
 * A runtime's session lifecycle (spec 2.2a): idle sessions reaped after an
 * hour by default, no session older than eight hours. AgentCore sets this per
 * runtime, not per session, so a profile's idle timeout is applied to the
 * runtime the profile belongs to.
 */
const MIN_S = 60;
const MAX_S = 28_800;

export function lifecycleFor(
   runtime: { idleTimeoutS: number; maxLifetimeS: number },
   profile: { idleTimeoutS: number | null } | null
): { idleRuntimeSessionTimeout: number; maxLifetime: number } {
   const clamp = (value: number) => Math.min(MAX_S, Math.max(MIN_S, Math.round(value)));
   const maxLifetime = clamp(runtime.maxLifetimeS);
   const idle = clamp(profile?.idleTimeoutS ?? runtime.idleTimeoutS);
   return { idleRuntimeSessionTimeout: Math.min(idle, maxLifetime), maxLifetime };
}

/** `…:runtime/<id>` → `<id>`. */
function runtimeIdOf(arn: string): string {
   const id = arn.split('/').at(-1);
   if (!id || !arn.includes(':runtime/')) throw new Error(`not an AgentCore runtime ARN: ${arn}`);
   return id;
}

/**
 * Writes the lifecycle onto a deployed runtime. `UpdateAgentRuntime` replaces
 * the definition, so the required fields are read back first and sent
 * unchanged; only the lifecycle differs.
 */
export async function applyLifecycle(
   client: Pick<BedrockAgentCoreControlClient, 'send'>,
   arn: string,
   lifecycle: { idleRuntimeSessionTimeout: number; maxLifetime: number }
): Promise<void> {
   const agentRuntimeId = runtimeIdOf(arn);
   const current = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId }));
   await client.send(
      new UpdateAgentRuntimeCommand({
         agentRuntimeId,
         agentRuntimeArtifact: current.agentRuntimeArtifact,
         roleArn: current.roleArn,
         ...(current.networkConfiguration ? { networkConfiguration: current.networkConfiguration } : {}),
         ...(current.protocolConfiguration ? { protocolConfiguration: current.protocolConfiguration } : {}),
         ...(current.environmentVariables ? { environmentVariables: current.environmentVariables } : {}),
         ...(current.requestHeaderConfiguration
            ? { requestHeaderConfiguration: current.requestHeaderConfiguration }
            : {}),
         ...(current.authorizerConfiguration ? { authorizerConfiguration: current.authorizerConfiguration } : {}),
         ...(current.filesystemConfigurations ? { filesystemConfigurations: current.filesystemConfigurations } : {}),
         lifecycleConfiguration: lifecycle,
      })
   );
}
