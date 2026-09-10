import type { TaskEnvelope } from './envelope.ts';
import type { LifecycleEvent } from './lifecycle.ts';

/** Where a task runs: an AgentCore Runtime by ARN, or the same image on a URL. */
export interface RuntimeTarget {
   /** The `agent_runtimes` row, or null for the deployment's configured default. */
   id: string | null;
   driver: 'agentcore' | 'http';
   arn: string | null;
   qualifier: string;
   region: string | null;
   endpointUrl: string | null;
}

export interface RuntimeTransport {
   invoke(input: { target: RuntimeTarget; envelope: TaskEnvelope; signal: AbortSignal }): AsyncIterable<LifecycleEvent>;
   /** Ends the session. Never throws: a session already gone is the goal. */
   stop(input: { target: RuntimeTarget; runtimeSessionId: string }): Promise<void>;
}

/** The runtime could not be reached or refused the invoke. Always retryable. */
export class RuntimeUnavailable extends Error {
   override readonly name = 'RuntimeUnavailable';
   readonly retryable = true;
}

export function routingTransport(transports: { agentcore: RuntimeTransport | null; http: RuntimeTransport }): RuntimeTransport {
   const pick = (target: RuntimeTarget): RuntimeTransport => {
      if (target.driver === 'http') return transports.http;
      if (!transports.agentcore) throw new RuntimeUnavailable('no AgentCore credentials or region are configured');
      return transports.agentcore;
   };
   return {
      invoke: (input) => pick(input.target).invoke(input),
      stop: async (input) => {
         try {
            await pick(input.target).stop(input);
         } catch {
            // Nothing to stop through.
         }
      },
   };
}
