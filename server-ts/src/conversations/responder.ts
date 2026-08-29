import { InMemorySessionService, LlmAgent, Runner, isFinalResponse } from '@google/adk';
import type { Sql } from '../db/pool.ts';
import { OpenRouterLlm } from '../agents/openrouter-llm.ts';
import { toAgentName } from '../agents/executor.ts';
import type { ConversationMessage } from './repository.ts';

/**
 * One conversational turn from an agent.
 *
 * Deliberately toolless. A run is how an agent does something: it has a task,
 * a workspace, a ledger and a container, and every one of those exists so the
 * work can be watched, gated and undone. Giving a chat box the same reach
 * would be a way to make an agent act with none of them, so the answer here is
 * words.
 *
 * The model's session is in memory and thrown away. Berry's own
 * `conversation_messages` are the transcript, replayed as the prompt on every
 * turn — so a conversation survives a restart and nothing depends on a session
 * store outliving the request.
 */

/** A long answer is still an answer; a runaway one is a bill. */
const MAX_HISTORY = 40;

export interface Usage {
   inputTokens: number;
   outputTokens: number;
}

export interface Reply {
   text: string;
   usage: Usage;
}

export class ResponderUnavailable extends Error {
   override readonly name = 'ResponderUnavailable';
   constructor(message: string) {
      super(message);
   }
}

export interface ResponderOptions {
   sql: Sql;
   apiKey: string;
   baseUrl?: string | undefined;
   defaultModel: string;
}

export class ConversationResponder {
   readonly #sql: Sql;
   readonly #apiKey: string;
   readonly #baseUrl: string | undefined;
   readonly #defaultModel: string;

   constructor(options: ResponderOptions) {
      this.#sql = options.sql;
      this.#apiKey = options.apiKey;
      this.#baseUrl = options.baseUrl;
      this.#defaultModel = options.defaultModel;
   }

   async reply(input: {
      agentId: string;
      history: ConversationMessage[];
      signal?: AbortSignal;
   }): Promise<Reply> {
      const [agent] = await this.#sql`
         SELECT name, instructions, model_name FROM agents
          WHERE id = ${input.agentId} AND archived_at IS NULL`;
      if (!agent) throw new ResponderUnavailable('that agent no longer exists');

      const sessions = new InMemorySessionService();
      const runner = new Runner({
         appName: 'berry',
         agent: new LlmAgent({
            name: toAgentName(agent.name as string),
            model: new OpenRouterLlm({
               model: (agent.model_name as string | null) || this.#defaultModel,
               apiKey: this.#apiKey,
               ...(this.#baseUrl ? { baseUrl: this.#baseUrl } : {}),
               title: 'Berry',
            }),
            // Its own instructions, plus what this conversation is not. An
            // agent that offers to "go ahead and fix it" here would be
            // promising something a chat turn cannot do.
            instruction: `${(agent.instructions as string | null) ?? ''}

You are answering a question in Berry's chat, not working a task. You have no
tools and no workspace here: you cannot read the repository, run commands or
change anything. Answer from what you are told and from what you know. If
doing the thing would need a task, say so and say what the task would be.`,
            tools: [],
         }),
         sessionService: sessions,
      });

      const session = await sessions.createSession({
         appName: 'berry',
         userId: 'berry',
      });

      let text = '';
      const usage: Usage = { inputTokens: 0, outputTokens: 0 };
      for await (const event of runner.runAsync({
         userId: session.userId,
         sessionId: session.id,
         newMessage: { role: 'user', parts: [{ text: transcript(input.history) }] },
         ...(input.signal ? { abortSignal: input.signal } : {}),
      })) {
         const metadata = event.usageMetadata;
         if (metadata) {
            usage.inputTokens += metadata.promptTokenCount ?? 0;
            // Reasoning tokens are inside completion_tokens, which is what
            // `candidatesTokenCount` carries — the same reading the run
            // ledger takes.
            usage.outputTokens += metadata.candidatesTokenCount ?? 0;
         }
         // Partial frames are the same text arriving twice; only the final one
         // is the reply.
         if (!isFinalResponse(event)) continue;
         for (const part of event.content?.parts ?? []) {
            if (typeof part.text === 'string') text += part.text;
         }
      }

      const trimmed = text.trim();
      if (trimmed === '') {
         // Better than storing an empty message the person cannot tell from a
         // silent failure.
         throw new ResponderUnavailable('the agent did not answer');
      }
      return { text: trimmed, usage };
   }
}

/**
 * The conversation as one prompt.
 *
 * Flattened rather than replayed as a multi-turn session, because the session
 * is in memory and the rows are the truth — rebuilding a session from them on
 * every turn would be the same thing with more moving parts. The tail is kept:
 * a long conversation's beginning matters less than what was just said.
 */
function transcript(history: ConversationMessage[]): string {
   const recent = history.slice(-MAX_HISTORY);
   if (recent.length === 1) return recent[0]!.body;
   const lines = recent.map(
      (message) => `${message.authorType === 'user' ? message.authorName : 'You'}: ${message.body}`
   );
   return `${lines.join('\n\n')}\n\nReply to the last message.`;
}
