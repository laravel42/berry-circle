import {
   Agent,
   JsonValidationError,
   ModelContentBlockDeltaEvent,
   ModelMessageStartEvent,
   ModelStreamUpdateEvent,
   StructuredOutputError,
   type AgentResult,
   type LocalAgent,
   type Message,
   type Plugin,
} from '@strands-agents/sdk';
import { z } from 'zod';
import { BerryRetryStrategy, classify } from '../agents/runtime/failure.ts';
import { bedrockModel, type AwsCredentials, type ModelFactory } from '../agents/runtime/model.ts';
import { textOf } from '../agents/runtime/plugins/accounting.ts';

/**
 * One model call, for the parts of Berry that are not an agent.
 *
 * The planner, the triage pass, a chat reply and the editor each want a
 * system prompt, a message and an answer. They used to go around the agent
 * SDK to a raw Bedrock client, ask for JSON in the prompt and dig it back out
 * with a regex. A toolless agent with a structured-output schema is the same
 * call with the schema enforced by the model rather than hoped for.
 */

export interface CompletionResult<T> {
   value: T;
   /** The model's text, for a repair loop that wants to show it back. */
   text: string;
   inputTokens: number;
   outputTokens: number;
   durationMs: number;
}

export class CompletionFailed extends Error {
   override readonly name = 'CompletionFailed';
   readonly code: string;
   readonly retryable: boolean;
   constructor(cause: unknown) {
      const failure = classify(cause);
      super(failure.message);
      this.code = failure.code;
      this.retryable = failure.retryable;
   }
}

/** The model answered, but not in the shape it was asked for. */
export class CompletionInvalid extends Error {
   override readonly name = 'CompletionInvalid';
   readonly raw: string;
   constructor(message: string, raw: string) {
      super(message);
      this.raw = raw;
   }
}

export interface CompletionOptions {
   region: string;
   credentials?: AwsCredentials | null | undefined;
   modelFactory?: ModelFactory | undefined;
   timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 120_000;

interface Call {
   model: string;
   system: string;
   signal?: AbortSignal | undefined;
}

export class Completion {
   readonly #region: string;
   readonly #credentials: AwsCredentials | null;
   readonly #modelFactory: ModelFactory;
   readonly #timeoutMs: number;

   constructor(options: CompletionOptions) {
      this.#region = options.region;
      this.#credentials = options.credentials ?? null;
      this.#modelFactory = options.modelFactory ?? bedrockModel;
      this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
   }

   async text(input: Call & { user: string }): Promise<CompletionResult<string>> {
      const { result, durationMs } = await this.#invoke(input, input.user, {});
      const text = textOf(result.lastMessage);
      return finish(result, text, text, durationMs);
   }

   /** Any JSON object. For callers with their own lenient reader and repair loop. */
   async json(input: Call & { user: string }): Promise<CompletionResult<unknown>> {
      return this.structured({ ...input, schema: z.looseObject({}) });
   }

   async structured<S extends z.ZodType>(
      input: Call & { user: string; schema: S }
   ): Promise<CompletionResult<z.output<S>>> {
      const { result, durationMs } = await this.#invoke(input, input.user, {
         structuredOutputSchema: input.schema,
      });
      const text = textOf(result.lastMessage);
      if (result.structuredOutput === undefined) {
         throw new CompletionInvalid('the model did not answer in the shape it was asked for', text);
      }
      return finish(result, result.structuredOutput as z.output<S>, text, durationMs);
   }

   /** A multi-turn exchange, ending on the user turn to be answered. */
   async converse(input: Call & { messages: Message[] }): Promise<CompletionResult<string>> {
      const history = input.messages.slice(0, -1);
      const last = input.messages.at(-1);
      if (!last || last.role !== 'user') {
         throw new CompletionInvalid('a conversation must end on the user turn to answer', '');
      }
      const { result, durationMs } = await this.#invoke(input, textOf(last), { messages: history });
      const text = textOf(result.lastMessage);
      return finish(result, text, text, durationMs);
   }

   async #invoke(
      call: Call,
      prompt: string,
      extra: { structuredOutputSchema?: z.ZodType; messages?: Message[] }
   ): Promise<{ result: AgentResult; durationMs: number }> {
      const started = Date.now();
      const spoken = new LastWords();
      const agent = new Agent({
         model: this.#modelFactory({
            model: call.model,
            region: this.#region,
            credentials: this.#credentials,
         }),
         systemPrompt: call.system,
         retryStrategy: new BerryRetryStrategy(),
         plugins: [spoken],
         printer: false,
         ...(extra.messages ? { messages: extra.messages } : {}),
         ...(extra.structuredOutputSchema
            ? { structuredOutputSchema: extra.structuredOutputSchema }
            : {}),
      });
      // The caller's cancellation and a ceiling of Berry's own, whichever
      // comes first: a completion that hangs must not hold a request open.
      const timeout = AbortSignal.timeout(this.#timeoutMs);
      const cancelSignal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;
      try {
         const result = await agent.invoke(prompt, { cancelSignal });
         return { result, durationMs: Date.now() - started };
      } catch (error) {
         if (error instanceof StructuredOutputError || error instanceof JsonValidationError) {
            throw new CompletionInvalid(error.message, spoken.text);
         }
         throw new CompletionFailed(error);
      }
   }
}

/**
 * The model's most recent words, as they streamed.
 *
 * Kept here because when the SDK gives up on a structured answer it throws
 * before the refusing message reaches the conversation, and the caller's
 * repair loop wants to see what the model said instead of the shape.
 */
class LastWords implements Plugin {
   readonly name = 'berry:last-words';
   text = '';

   initAgent(agent: LocalAgent): void {
      agent.addHook(ModelStreamUpdateEvent, (event) => {
         const inner = event.event;
         if (inner instanceof ModelMessageStartEvent) this.text = '';
         if (inner instanceof ModelContentBlockDeltaEvent && inner.delta.type === 'textDelta') {
            this.text += inner.delta.text;
         }
      });
   }
}

function finish<T>(
   result: AgentResult,
   value: T,
   text: string,
   durationMs: number
): CompletionResult<T> {
   const usage = result.metrics?.accumulatedUsage;
   return {
      value,
      text,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      durationMs,
   };
}
