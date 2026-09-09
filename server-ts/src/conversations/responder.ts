import type { Sql } from '../db/pool.ts';
import { Message, TextBlock } from '@strands-agents/sdk';
import { Completion } from '../llm/completion.ts';
import type { AwsCredentials } from '../agents/runtime/model.ts';
import { toAgentName } from '../agents/runtime/agent.ts';
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
 * `conversation_messages` are the transcript, replayed as the turns of the
 * conversation on every reply — so a conversation survives a restart and
 * nothing depends on a session store outliving the request.
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
   /** The AWS region Bedrock is called in. */
   region: string;
   /**
    * Explicit Bedrock credentials. Omitted means the AWS default chain, which
    * is wrong wherever `AWS_ACCESS_KEY_ID` belongs to something else — in the
    * Compose stack it is MinIO's, and Bedrock rejects it as an invalid
    * security token.
    */
   credentials?: AwsCredentials | null;
   /** Injected by tests; production builds one from the region. */
   completion?: Pick<Completion, 'converse'>;
   defaultModel: string;
}

export class ConversationResponder {
   readonly #sql: Sql;
   readonly #completion: Pick<Completion, 'converse'>;
   readonly #defaultModel: string;

   constructor(options: ResponderOptions) {
      this.#sql = options.sql;
      this.#completion =
         options.completion ??
         new Completion({
            region: options.region,
            ...(options.credentials ? { credentials: options.credentials } : {}),
         });
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

      // A single completion with no tools, so this goes straight to Bedrock
      // rather than through an agent framework: a tool loop with no tools is
      // machinery with nothing to do.
      const messages = toMessages(input.history);
      if (messages.length === 0 || messages.at(-1)?.role !== 'user') {
         // The reply is to a person; with nothing from one there is nothing
         // to answer, and inventing a turn would put words in their mouth.
         throw new ResponderUnavailable('nothing to answer');
      }

      const result = await this.#completion
         .converse({
            model: (agent.model_name as string | null) || this.#defaultModel,
            // Its own instructions, plus what this conversation is not. An
            // agent that offers to "go ahead and fix it" here would be
            // promising something a chat turn cannot do.
            system: `${(agent.instructions as string | null) ?? ''}

You are answering a question in Berry's chat, not working a task. You have no
tools and no workspace here: you cannot read the repository, run commands or
change anything. Answer from what you are told and from what you know. If
doing the thing would need a task, say so and say what the task would be.`,
            messages,
            ...(input.signal ? { signal: input.signal } : {}),
         })
         .catch((cause: unknown) => {
            throw new ResponderUnavailable(
               cause instanceof Error ? cause.message : String(cause)
            );
         });

      const text = result.value;
      const usage: Usage = {
         inputTokens: result.inputTokens,
         outputTokens: result.outputTokens,
      };

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
 * The conversation as turns.
 *
 * Bedrock wants alternating user/assistant messages starting with the user,
 * so consecutive rows from the same side are joined, a leading agent row is
 * dropped, and a system row rides in the next user turn. Names are added only
 * when more than one person is talking; otherwise the model starts answering
 * "Andrea:" back. The tail is kept: a long conversation's beginning matters
 * less than what was just said.
 */
export function toMessages(history: ConversationMessage[]): Message[] {
   const recent = history.slice(-MAX_HISTORY);
   const people = new Set(
      recent.filter((message) => message.authorType === 'user').map((message) => message.authorName)
   );
   const turns: Array<{ role: 'user' | 'assistant'; parts: string[] }> = [];
   let pendingSystem: string[] = [];
   for (const message of recent) {
      if (message.authorType === 'system') {
         pendingSystem.push(`[Berry] ${message.body}`);
         continue;
      }
      const role = message.authorType === 'agent' ? 'assistant' : 'user';
      if (turns.length === 0 && role === 'assistant') continue;
      const text =
         role === 'user' && people.size > 1 ? `${message.authorName}: ${message.body}` : message.body;
      const parts = role === 'user' ? [...pendingSystem, text] : [text];
      pendingSystem = [];
      const last = turns.at(-1);
      if (last && last.role === role) last.parts.push(...parts);
      else turns.push({ role, parts });
   }
   return turns.map(
      (turn) => new Message({ role: turn.role, content: [new TextBlock(turn.parts.join('\n\n'))] })
   );
}
