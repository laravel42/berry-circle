import { randomUUID } from 'node:crypto';
import { toRFC3339, type Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';

/**
 * Talking to an agent outside a run.
 *
 * A run is work: it has a task, a workspace, a ledger and a container. A
 * conversation is a question — "what would you do here", "why did that fail" —
 * and it deliberately has none of those. Keeping them apart is what stops
 * "ask the agent" from quietly becoming a way to make an agent do something
 * without a task, a gate or a record.
 *
 * The messages here are the durable transcript. The model's own session is
 * scratch, rebuilt from these rows on every turn, so a conversation survives a
 * restart and nothing depends on a session store staying alive.
 */

export interface ConversationSummary {
   id: string;
   kind: string;
   topic: string;
   agentId: string | null;
   agentName: string | null;
   messageCount: number;
   updatedAt: string;
}

export interface ConversationMessage {
   id: string;
   authorType: 'user' | 'agent' | 'system';
   authorName: string;
   body: string;
   channel: string;
   createdAt: string;
}

/** What a turn needs to know before it can be taken. */
export interface ConversationContext {
   id: string;
   workspaceId: string;
   agentId: string | null;
}

export class ConversationRepository {
   readonly #sql: Sql;
   readonly #newId: () => string;

   constructor(sql: Sql, options: { newId?: () => string } = {}) {
      this.#sql = sql;
      this.#newId = options.newId ?? randomUUID;
   }

   /**
    * The caller's own threads, most recently spoken in first.
    *
    * Scoped by participation rather than by workspace: a conversation is
    * between people and agents, and being in the same workspace is not being
    * in the conversation.
    */
   async list(userId: string, limit = 50): Promise<ConversationSummary[]> {
      const rows = await this.#sql`
         SELECT conversation.id, conversation.kind, conversation.topic, conversation.updated_at,
                agent.id AS agent_id, agent.name AS agent_name,
                (SELECT count(*) FROM conversation_messages AS message
                  WHERE message.conversation_id = conversation.id) AS message_count
           FROM conversations AS conversation
           JOIN conversation_participants AS me
             ON me.conversation_id = conversation.id
            AND me.participant_type = 'user'
            AND me.participant_id = ${userId}
            AND me.left_at IS NULL
           LEFT JOIN conversation_participants AS bot
             ON bot.conversation_id = conversation.id
            AND bot.participant_type = 'agent'
            AND bot.left_at IS NULL
           LEFT JOIN agents AS agent ON agent.id = bot.participant_id
          WHERE conversation.status = 'open'
          ORDER BY conversation.updated_at DESC, conversation.id DESC
          LIMIT ${limit}`;
      return rows.map((row) => ({
         id: row.id as string,
         kind: row.kind as string,
         topic: (row.topic as string | null) ?? (row.agent_name as string | null) ?? 'Conversation',
         agentId: (row.agent_id as string | null) ?? null,
         agentName: (row.agent_name as string | null) ?? null,
         messageCount: Number(row.message_count),
         updatedAt: toRFC3339(row.updated_at as string)!,
      }));
   }

   /**
    * The thread, if the caller is in it.
    *
    * "Not yours" and "does not exist" are the same answer, so a caller cannot
    * discover which conversation ids are real.
    */
   async context(conversationId: string, userId: string): Promise<ConversationContext> {
      const [row] = await this.#sql`
         SELECT conversation.id, conversation.workspace_id, bot.participant_id AS agent_id
           FROM conversations AS conversation
           JOIN conversation_participants AS me
             ON me.conversation_id = conversation.id
            AND me.participant_type = 'user'
            AND me.participant_id = ${userId}
            AND me.left_at IS NULL
           LEFT JOIN conversation_participants AS bot
             ON bot.conversation_id = conversation.id
            AND bot.participant_type = 'agent'
            AND bot.left_at IS NULL
          WHERE conversation.id = ${conversationId}`;
      if (!row) throw new NotFound();
      return {
         id: row.id as string,
         workspaceId: row.workspace_id as string,
         agentId: (row.agent_id as string | null) ?? null,
      };
   }

   async messages(conversationId: string, limit = 200): Promise<ConversationMessage[]> {
      const rows = await this.#sql`
         SELECT message.id, message.author_type, message.author_id, message.body,
                message.channel, message.created_at,
                COALESCE(person.name, agent.name, 'Berry') AS author_name
           FROM conversation_messages AS message
           LEFT JOIN users AS person
             ON person.id = message.author_id AND message.author_type = 'user'
           LEFT JOIN agents AS agent
             ON agent.id = message.author_id AND message.author_type = 'agent'
          WHERE message.conversation_id = ${conversationId}
          ORDER BY message.created_at ASC, message.id ASC
          LIMIT ${limit}`;
      return rows.map((row) => ({
         id: row.id as string,
         authorType: row.author_type as 'user' | 'agent' | 'system',
         authorName: row.author_name as string,
         body: row.body as string,
         channel: row.channel as string,
         createdAt: toRFC3339(row.created_at as string)!,
      }));
   }

   /**
    * The caller's thread with one agent, opened once.
    *
    * Idempotent by construction rather than by an idempotency key: selecting
    * the same agent twice continues one conversation, because two threads with
    * the same agent would be two halves of one memory.
    */
   async openWithAgent(input: {
      workspaceId: string;
      userId: string;
      agentId: string;
      agentName: string;
   }): Promise<string> {
      return this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const [existing] = await tx`
            SELECT conversation.id
              FROM conversations AS conversation
              JOIN conversation_participants AS me
                ON me.conversation_id = conversation.id
               AND me.participant_type = 'user' AND me.participant_id = ${input.userId}
               AND me.left_at IS NULL
              JOIN conversation_participants AS bot
                ON bot.conversation_id = conversation.id
               AND bot.participant_type = 'agent' AND bot.participant_id = ${input.agentId}
               AND bot.left_at IS NULL
             WHERE conversation.workspace_id = ${input.workspaceId}
               AND conversation.kind = 'direct'
               AND conversation.status = 'open'
             LIMIT 1`;
         if (existing) return existing.id as string;

         const id = this.#newId();
         await tx`
            INSERT INTO conversations (id, workspace_id, kind, topic, status, created_by)
            VALUES (${id}, ${input.workspaceId}, 'direct', ${input.agentName}, 'open', ${input.userId})`;
         await tx`
            INSERT INTO conversation_participants (conversation_id, participant_type, participant_id, role)
            VALUES (${id}, 'user', ${input.userId}, 'owner'),
                   (${id}, 'agent', ${input.agentId}, 'member')`;
         return id;
      }) as Promise<string>;
   }

   /**
    * Appends a message, and moves the thread to the top of the list.
    *
    * One transaction because `updated_at` is what the listing orders by: a
    * message that landed without it would be a reply nobody sees until
    * something else touches the row.
    */
   async append(input: {
      conversationId: string;
      authorType: 'user' | 'agent' | 'system';
      authorId: string | null;
      body: string;
   }): Promise<string> {
      const id = this.#newId();
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         await tx`
            INSERT INTO conversation_messages (id, conversation_id, author_type, author_id, body)
            VALUES (${id}, ${input.conversationId}, ${input.authorType}, ${input.authorId},
                    ${input.body})`;
         await tx`
            UPDATE conversations SET updated_at = now() WHERE id = ${input.conversationId}`;
      });
      return id;
   }
}
