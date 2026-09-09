import { Agent, SlidingWindowConversationManager, type Plugin, type Tool } from '@strands-agents/sdk';
import { BerryRetryStrategy } from './failure.ts';
import { bedrockModel, type AwsCredentials, type ModelFactory } from './model.ts';

/**
 * The agent for one run, built in one place.
 *
 * Everything Berry adds to the SDK's loop arrives as a plugin: the ledger,
 * permissions, accounting, the tool-failure policy. The executor constructs
 * those with the run in scope and hands them here; this file is the only one
 * that knows what an `Agent` is made of.
 */

export interface RunAgentSpec {
   agentName: string;
   model: string;
   region: string;
   credentials: AwsCredentials | null;
   systemPrompt: string;
   tools: Tool[];
   plugins: Plugin[];
   maxTokens?: number | undefined;
   temperature?: number | undefined;
   traceAttributes: Record<string, string>;
}

/** Messages kept in the model's view of the conversation. */
export const WINDOW_SIZE = 60;

export function buildRunAgent(spec: RunAgentSpec, modelFactory: ModelFactory = bedrockModel): Agent {
   return new Agent({
      model: modelFactory({
         model: spec.model,
         region: spec.region,
         credentials: spec.credentials,
         maxTokens: spec.maxTokens,
         temperature: spec.temperature,
      }),
      name: toAgentName(spec.agentName),
      systemPrompt: spec.systemPrompt,
      tools: spec.tools,
      plugins: spec.plugins,
      // Replacing the SDK's default rather than joining it, so a throttled
      // call is retried on Berry's idea of transient and nothing else.
      retryStrategy: new BerryRetryStrategy(),
      // A long run reads many files and runs many commands; without a ceiling
      // the conversation grows until the model refuses it. The window keeps
      // the recent turns and the run ledger keeps everything that fell out.
      conversationManager: new SlidingWindowConversationManager({
         windowSize: WINDOW_SIZE,
         proactiveCompression: true,
      }),
      traceAttributes: spec.traceAttributes,
      printer: false,
   });
}

/**
 * A model-safe agent name.
 *
 * Berry's names are free text — "Prototype Writer" — so they are normalised
 * rather than rejected: the name is a label the model sees, and refusing to
 * run an agent because its name has a space in it would be absurd.
 */
export function toAgentName(name: string): string {
   const normalized = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
   return normalized === '' ? 'agent' : normalized;
}
