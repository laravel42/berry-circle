import {
   AfterModelCallEvent,
   BeforeToolCallEvent,
   MessageAddedEvent,
   ModelMetadataEvent,
   ModelStreamUpdateEvent,
   type LocalAgent,
   type Message,
   type Plugin,
} from '@strands-agents/sdk';
import type { Usage } from '../../../runs/ledger.ts';
import { ResultText } from '../result-text.ts';

/**
 * What the run cost and what it concluded.
 *
 * Usage comes from the stream's metadata event, once per model call; the SDK
 * aggregates the same numbers into `AgentResult.metrics`, and a test keeps
 * the two equal. The result text comes from each assistant message as the
 * SDK adds it to the conversation — one `endTurn` per message, which is the
 * boundary `ResultText` needs to tell a report from a sign-off.
 */

export interface AccountingSnapshot {
   usage: Usage;
   /** Prompt-cache tokens. Kept beside `usage` because the ledger's Usage has no place for them. */
   cacheReadTokens: number;
   cacheWriteTokens: number;
   toolCalls: number;
   modelCalls: number;
   result: ResultText;
}

export class AccountingPlugin implements Plugin {
   readonly name = 'berry:accounting';
   readonly #usage: Usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costMicros: null,
      currency: null,
   };
   readonly #result = new ResultText();
   #toolCalls = 0;
   #modelCalls = 0;
   #cacheReadTokens = 0;
   #cacheWriteTokens = 0;

   initAgent(agent: LocalAgent): void {
      agent.addHook(ModelStreamUpdateEvent, (event) => {
         const inner = event.event;
         if (inner instanceof ModelMetadataEvent && inner.usage) {
            this.#usage.inputTokens += inner.usage.inputTokens;
            this.#usage.outputTokens += inner.usage.outputTokens;
            this.#usage.totalTokens = this.#usage.inputTokens + this.#usage.outputTokens;
            this.#cacheReadTokens += inner.usage.cacheReadInputTokens ?? 0;
            this.#cacheWriteTokens += inner.usage.cacheWriteInputTokens ?? 0;
         }
      });
      agent.addHook(AfterModelCallEvent, () => {
         this.#modelCalls += 1;
      });
      agent.addHook(BeforeToolCallEvent, () => {
         this.#toolCalls += 1;
      });
      agent.addHook(MessageAddedEvent, (event) => {
         if (event.message.role !== 'assistant') return;
         this.#result.append(textOf(event.message));
         this.#result.endTurn();
      });
   }

   snapshot(): AccountingSnapshot {
      return {
         usage: { ...this.#usage },
         cacheReadTokens: this.#cacheReadTokens,
         cacheWriteTokens: this.#cacheWriteTokens,
         toolCalls: this.#toolCalls,
         modelCalls: this.#modelCalls,
         result: this.#result,
      };
   }
}

/** The text blocks of a message, joined. Tool-use blocks say nothing. */
export function textOf(message: Message): string {
   return message.content
      .map((block) => (block.type === 'textBlock' ? block.text : ''))
      .join('');
}
