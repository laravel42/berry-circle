import { Agent, JsonValidationError, StructuredOutputError } from '@strands-agents/sdk';
import { z } from 'zod';
import type { TaskEnvelope } from '../../../runtime/envelope.ts';
import { BerryRetryStrategy, classify } from '../failure.ts';
import type { ModelFactory } from '../model.ts';
import { textOf } from '../plugins/accounting.ts';
import type { Emit } from './emitter.ts';
import { toConversation } from './conversation.ts';

/**
 * One model call for the parts of Berry that are not an agent — the planner,
 * triage, the review gate, a chat reply, the editor.
 *
 * What `llm/completion.ts` did in the server, moved here so the server holds
 * no model client. A fresh agent per call: completions share no session.
 */
export async function runCompletionTask(
   envelope: TaskEnvelope,
   emit: Emit,
   deps: { modelFactory: ModelFactory; region: string }
): Promise<void> {
   emit({ type: 'task.started' });
   const spec = envelope.completion ?? { system: '', jsonSchema: null };
   const schema = spec.jsonSchema ? z.fromJSONSchema(spec.jsonSchema) : undefined;
   const agent = new Agent({
      model: deps.modelFactory({
         model: envelope.agent.model,
         region: deps.region,
         credentials: null,
         stream: false,
         maxTokens: envelope.agent.maxTokens ?? undefined,
      }),
      systemPrompt: spec.system,
      retryStrategy: new BerryRetryStrategy(),
      printer: false,
      messages: toConversation(envelope.transcript),
      ...(schema ? { structuredOutputSchema: schema } : {}),
   });
   try {
      const result = await agent.invoke(envelope.task.prompt);
      const usage = result.metrics?.accumulatedUsage;
      emit({
         type: 'task.usage',
         usage: {
            model: envelope.agent.model,
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
         },
      });
      if (schema && result.structuredOutput === undefined) {
         emit({ type: 'task.failed', failure: { code: 'COMPLETION_INVALID', message: textOf(result.lastMessage), retryable: false } });
         return;
      }
      emit({
         type: 'task.completed',
         result: {
            text: textOf(result.lastMessage),
            truncated: false,
            ...(schema ? { structured: result.structuredOutput } : {}),
            delivery: null,
         },
      });
   } catch (error) {
      if (error instanceof StructuredOutputError || error instanceof JsonValidationError) {
         emit({ type: 'task.failed', failure: { code: 'COMPLETION_INVALID', message: error.message, retryable: false } });
         return;
      }
      emit({ type: 'task.failed', failure: classify(error) });
   }
}
