import {
   Model,
   ModelContentBlockDeltaEvent,
   ModelContentBlockStartEvent,
   ModelContentBlockStopEvent,
   ModelMessageStartEvent,
   ModelMessageStopEvent,
   ModelMetadataEvent,
   type BaseModelConfig,
   type Message,
   type ModelStreamEvent,
   type StreamOptions,
} from '@strands-agents/sdk';

/**
 * A model that says what it is told to, for tests.
 *
 * The SDK's `Agent` takes any `Model`, which is what makes the loop testable
 * without Bedrock: a script of turns stands in for the model, the real agent
 * runs the real tools and the real hooks, and a test asserts on what reached
 * the ledger. Each turn is one model call; the agent decides how many there
 * are, so a script that runs out is an error rather than an empty answer —
 * the test asked for something the scenario did not cover.
 */

export type ScriptedTurn =
   | { kind: 'say'; text: string; usage?: Usage }
   | { kind: 'call'; tool: string; input: Record<string, unknown>; usage?: Usage }
   | { kind: 'throw'; error: Error };

interface Usage {
   inputTokens: number;
   outputTokens: number;
   /** Named as the SDK names them, so the metadata event carries them as-is. */
   cacheReadInputTokens?: number;
   cacheWriteInputTokens?: number;
}

const DEFAULT_USAGE: Usage = { inputTokens: 10, outputTokens: 5 };

export function say(text: string, usage?: Usage): ScriptedTurn {
   return { kind: 'say', text, ...(usage ? { usage } : {}) };
}

export function call(tool: string, input: Record<string, unknown>, usage?: Usage): ScriptedTurn {
   return { kind: 'call', tool, input, ...(usage ? { usage } : {}) };
}

export function throwing(error: Error): ScriptedTurn {
   return { kind: 'throw', error };
}

export class ScriptedModel extends Model<BaseModelConfig> {
   readonly #turns: ScriptedTurn[];
   readonly #contextWindowLimit: number | undefined;
   /** How many model calls the agent made. */
   calls = 0;
   /** The messages each call was given, oldest call first. */
   readonly received: Message[][] = [];

   /**
    * `contextWindowLimit` lets a test make the conversation manager act: the
    * SDK compresses proactively when the estimated input nears the window,
    * and a scripted model has no window unless it is told one.
    */
   constructor(turns: ScriptedTurn[], options: { contextWindowLimit?: number } = {}) {
      super();
      this.#turns = turns;
      this.#contextWindowLimit = options.contextWindowLimit;
   }

   updateConfig(): void {}

   getConfig(): BaseModelConfig {
      return {
         modelId: 'scripted',
         ...(this.#contextWindowLimit ? { contextWindowLimit: this.#contextWindowLimit } : {}),
      };
   }

   async *stream(messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
      const turn = this.#turns[this.calls];
      this.calls += 1;
      this.received.push(messages);
      if (!turn) throw new Error(`script exhausted after ${this.calls - 1} calls`);
      if (turn.kind === 'throw') throw turn.error;

      yield new ModelMessageStartEvent({ type: 'modelMessageStartEvent', role: 'assistant' });
      if (turn.kind === 'say') {
         yield new ModelContentBlockStartEvent({ type: 'modelContentBlockStartEvent' });
         // Word by word, so a test sees deltas the way Bedrock sends them.
         for (const piece of turn.text.split(/(?<= )/)) {
            if (piece === '') continue;
            yield new ModelContentBlockDeltaEvent({
               type: 'modelContentBlockDeltaEvent',
               delta: { type: 'textDelta', text: piece },
            });
         }
         yield new ModelContentBlockStopEvent({ type: 'modelContentBlockStopEvent' });
         yield new ModelMessageStopEvent({ type: 'modelMessageStopEvent', stopReason: 'endTurn' });
      } else {
         yield new ModelContentBlockStartEvent({
            type: 'modelContentBlockStartEvent',
            start: { type: 'toolUseStart', name: turn.tool, toolUseId: `call_${this.calls}` },
         });
         yield new ModelContentBlockDeltaEvent({
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'toolUseInputDelta', input: JSON.stringify(turn.input) },
         });
         yield new ModelContentBlockStopEvent({ type: 'modelContentBlockStopEvent' });
         yield new ModelMessageStopEvent({ type: 'modelMessageStopEvent', stopReason: 'toolUse' });
      }
      const usage = turn.usage ?? DEFAULT_USAGE;
      yield new ModelMetadataEvent({
         type: 'modelMetadataEvent',
         usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens },
      });
   }
}
