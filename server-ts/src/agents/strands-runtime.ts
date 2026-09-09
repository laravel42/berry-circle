import { Agent, BedrockModel, type Tool } from '@strands-agents/sdk';
import type { AwsCredentials } from '../llm/bedrock-chat.ts';

/**
 * Strands, behind a seam.
 *
 * The executor is 800 lines of Berry — the run ledger, the output buffer, the
 * repository work — and perhaps forty of those lines were ever about the agent
 * SDK. Keeping the SDK behind this boundary is what let ADK be replaced by
 * editing one file rather than auditing the executor's every branch, and is
 * the same reason `scm/provider.ts` exists.
 *
 * The events below are Berry's vocabulary, not Strands'. A future SDK emits
 * different shapes and translates them here; the executor keeps reading the
 * same five things it has always read.
 */

/** One thing that happened while the agent worked, in Berry's terms. */
export type AgentEvent =
   | { type: 'text'; text: string; partial: boolean }
   | { type: 'tool_started'; callId: string; name: string }
   | { type: 'tool_completed'; callId: string; ok: boolean }
   | { type: 'usage'; inputTokens: number; outputTokens: number }
   | { type: 'turn_complete' };

export interface AgentRuntimeOptions {
   /** A Bedrock inference profile id, e.g. `us.anthropic.claude-sonnet-4-...`. */
   model: string;
   region: string;
   /** Omitted means the AWS default chain: a role, or a local profile. */
   credentials?: AwsCredentials | null;
   systemPrompt: string;
   tools: Tool[];
   maxTokens?: number;
   temperature?: number;
}

const DEFAULT_MAX_TOKENS = 8192;

/**
 * The model for a run.
 *
 * No API key: Bedrock authenticates with SigV4 through the AWS credential
 * chain, so what this takes is a region and an id. A deployment on ECS or
 * Lambda therefore holds no model credential at all — the difference that
 * makes this migration worth the churn beyond swapping vendors.
 */
export function bedrockModel(options: {
   model: string;
   region: string;
   credentials?: AwsCredentials | null;
   maxTokens?: number;
   temperature?: number;
}): BedrockModel {
   return new BedrockModel({
      region: options.region,
      ...(options.credentials ? { clientConfig: { credentials: options.credentials } } : {}),
      modelId: options.model,
      maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
   });
}

/**
 * Runs one turn and yields Berry events.
 *
 * A generator rather than a callback so the executor keeps its `for await` and
 * everything it does inside it — flushing at turn boundaries, counting tool
 * calls, checking for cancellation — without this file knowing any of it.
 */
export async function* runAgent(
   options: AgentRuntimeOptions,
   message: string,
   signal?: AbortSignal
): AsyncGenerator<AgentEvent> {
   const agent = new Agent({
      model: bedrockModel(options),
      systemPrompt: options.systemPrompt,
      tools: options.tools,
   });

   // Names, so a completed tool can be reported with the one that started.
   const open = new Map<string, string>();

   for await (const event of agent.stream(message, signal ? { cancelSignal: signal } : {})) {
      if (signal?.aborted) return;

      for (const translated of translate(event as unknown as Record<string, unknown>, open)) {
         yield translated;
      }
   }
   yield { type: 'turn_complete' };
}

/**
 * One Strands event as zero or more Berry events.
 *
 * Written defensively against the payload rather than against the SDK's types.
 * The TypeScript SDK is young — 1.16.0 at the time of writing, and far less
 * exercised than its Python sibling — so an event shape that shifts should
 * cost Berry a missing delta, not a crashed run halfway through an agent's
 * work.
 */
function translate(event: Record<string, unknown>, open: Map<string, string>): AgentEvent[] {
   const type = String(event.type ?? '');

   // Text, as it is generated. This is what makes a run readable while it runs
   // rather than only once it is over.
   if (type === 'modelContentBlockDeltaEvent') {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (delta?.type === 'textDelta' && typeof delta.text === 'string' && delta.text !== '') {
         return [{ type: 'text', text: delta.text, partial: true }];
      }
      return [];
   }

   if (type === 'modelContentBlockStartEvent') {
      const start = event.start as Record<string, unknown> | undefined;
      if (start?.type === 'toolUseStart') {
         const callId = String(start.toolUseId ?? `tool_${open.size + 1}`);
         const name = String(start.name ?? '');
         open.set(callId, name);
         return [{ type: 'tool_started', callId, name }];
      }
      return [];
   }

   if (type === 'toolResultEvent') {
      const result = event.toolResult as Record<string, unknown> | undefined;
      const callId = String(result?.toolUseId ?? event.toolUseId ?? '');
      open.delete(callId);
      // Strands reports a thrown tool as a result with an error status rather
      // than by failing the run, so the ledger only learns by looking.
      const ok = String(result?.status ?? 'success') !== 'error';
      return [{ type: 'tool_completed', callId, ok }];
   }

   if (type === 'modelMetadataEvent') {
      const usage = event.usage as Record<string, unknown> | undefined;
      if (!usage) return [];
      return [
         {
            type: 'usage',
            inputTokens: Number(usage.inputTokens ?? 0),
            outputTokens: Number(usage.outputTokens ?? 0),
         },
      ];
   }

   // The end of one model message. A run that called three tools made four
   // model calls, and each is a turn the result accumulator has to see.
   if (type === 'modelMessageStopEvent') return [{ type: 'turn_complete' }];

   return [];
}

/** Every tool the agent left open when the stream ended. */
export function stillOpen(open: Map<string, string>): string[] {
   return [...open.keys()];
}
