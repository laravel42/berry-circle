import {
   BedrockAgentCoreClient,
   InvokeAgentRuntimeCommand,
   StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type { TaskEnvelope } from './envelope.ts';
import { parseLifecycleStream, type LifecycleEvent } from './lifecycle.ts';
import { RuntimeUnavailable, type RuntimeTarget, type RuntimeTransport } from './transport.ts';

/**
 * `InvokeAgentRuntime` with the task envelope; the response body is the
 * runtime's lifecycle SSE stream. Not `InvokeAgentRuntimeCommand`: the loop is
 * in the runtime now, so Berry sends it work rather than shell commands.
 */
export function agentCoreTransport(options: {
   region: string;
   credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | null;
   client?: Pick<BedrockAgentCoreClient, 'send'>;
}): RuntimeTransport {
   const clients = new Map<string, Pick<BedrockAgentCoreClient, 'send'>>();
   const clientFor = (region: string | null) => {
      if (options.client) return options.client;
      const key = region ?? options.region;
      let client = clients.get(key);
      if (!client) {
         client = new BedrockAgentCoreClient({
            region: key,
            ...(options.credentials ? { credentials: options.credentials } : {}),
         });
         clients.set(key, client);
      }
      return client;
   };

   return {
      async *invoke({ target, envelope, signal }: { target: RuntimeTarget; envelope: TaskEnvelope; signal: AbortSignal }): AsyncIterable<LifecycleEvent> {
         if (!target.arn) throw new RuntimeUnavailable('this runtime has no ARN');
         let body: AsyncIterable<Uint8Array>;
         try {
            const response = await clientFor(target.region).send(
               new InvokeAgentRuntimeCommand({
                  agentRuntimeArn: target.arn,
                  qualifier: target.qualifier,
                  runtimeSessionId: envelope.runtimeSessionId,
                  contentType: 'application/json',
                  accept: 'text/event-stream',
                  payload: new TextEncoder().encode(JSON.stringify(envelope)),
               }),
               { abortSignal: signal as never }
            );
            if (!response.response) throw new Error('the runtime returned no body');
            body = response.response as unknown as AsyncIterable<Uint8Array>;
         } catch (cause) {
            throw new RuntimeUnavailable(`could not invoke the AgentCore Runtime: ${message(cause)}`, { cause });
         }
         yield* parseLifecycleStream(body);
      },

      async stop({ target, runtimeSessionId }) {
         if (!target.arn) return;
         await clientFor(target.region)
            .send(new StopRuntimeSessionCommand({ agentRuntimeArn: target.arn, qualifier: target.qualifier, runtimeSessionId }))
            .catch(() => undefined);
      },
   };
}

function message(cause: unknown): string {
   return cause instanceof Error ? cause.message : String(cause);
}
