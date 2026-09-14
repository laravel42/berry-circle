import { randomUUID } from 'node:crypto';
import { toRFC3339, type Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';

/**
 * Chat sessions with an agent.
 *
 * A conversation is a chat session. Each message a person sends becomes an
 * agent task (see `chat-tasks.ts`), and the reply is appended when the task
 * ends, so chat has the same tools, ledger and cancellation as any other task.
 *
 * The messages here are the durable transcript. Per-person state (pinned,
 * archived, read position, unsent draft) lives on the participant row, because
 * two people in one thread pin and read it independently.
 */

export interface ConversationSummary {
   id: string;
   kind: string;
   topic: string;
   agentId: string | null;
   agentName: string | null;
   messageCount: number;
   updatedAt: string;
   pinned: boolean;
   archived: boolean;
   /** Messages from the agent (or the system) since the caller last read the thread. */
   unread: number;
   activeRunId: string | null;
   draft: string;
   /**
    * The start of the newest message, for a row preview.
    *
    * Truncated on the server: a list of fifty threads has no use for fifty
    * whole replies, and sending them would make the list heavier than the
    * conversation it is listing.
    */
   lastMessage: string | null;
   lastMessageAuthor: 'user' | 'agent' | 'system' | null;
}

export interface ConversationMessage {
   id: string;
   authorType: 'user' | 'agent' | 'system';
   authorName: string;
   body: string;
   channel: string;
   createdAt: string;
   /** The task whose reply this is, for an agent message. */
   runId: string | null;
}

/** What a turn needs to know before it can be taken. */
export interface ConversationContext {
   id: string;
   workspaceId: string;
   agentId: string | null;
}

const SESSION_TITLE_SOURCES = { agent: 'agent', user: 'user' } as const;

export class ConversationRepository {
   readonly #sql: Sql;
   readonly #newId: () => string;

   constructor(sql: Sql, options: { newId?: () => string } = {}) {
      this.#sql = sql;
      this.#newId = options.newId ?? randomUUID;
   }

   /**
    * The caller's own threads: pinned first, then most recently spoken in.
    *
    * Scoped by participation rather than by workspace: a conversation is
    * between people and agents, and being in the same workspace is not being
    * in the conversation.
    */
   async list(
      userId: string,
      options: { archived?: boolean } = {},
      limit = 50
   ): Promise<ConversationSummary[]> {
      const archived = options.archived ?? false;
      const rows = await this.#sql`
         SELECT conversation.id, conversation.kind, conversation.topic, conversation.updated_at,
                conversation.active_run_id,
                agent.id AS agent_id, agent.name AS agent_name,
                me.pinned_at IS NOT NULL AS pinned,
                me.archived_at IS NOT NULL AS archived,
                me.draft,
                (SELECT count(*) FROM conversation_messages AS message
                  WHERE message.conversation_id = conversation.id) AS message_count,
                (SELECT count(*) FROM conversation_messages AS message
                  WHERE message.conversation_id = conversation.id
                    AND message.created_at > COALESCE(me.last_read_at, 'epoch'::timestamptz)
                    AND message.author_type <> 'user') AS unread,
                newest.body AS last_message,
                newest.author_type AS last_message_author
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
           -- One row per conversation: the newest message, trimmed to a preview.
           LEFT JOIN LATERAL (
              SELECT left(message.body, 200) AS body, message.author_type
                FROM conversation_messages AS message
               WHERE message.conversation_id = conversation.id
               ORDER BY message.created_at DESC, message.id DESC
               LIMIT 1
           ) AS newest ON true
          WHERE conversation.status = 'open'
            AND (me.archived_at IS NOT NULL) = ${archived}
          ORDER BY me.pinned_at IS NULL, conversation.updated_at DESC, conversation.id DESC
          LIMIT ${limit}`;
      return rows.map((row) => ({
         id: row.id as string,
         kind: row.kind as string,
         topic: (row.topic as string | null) ?? (row.agent_name as string | null) ?? 'Conversation',
         agentId: (row.agent_id as string | null) ?? null,
         agentName: (row.agent_name as string | null) ?? null,
         messageCount: Number(row.message_count),
         updatedAt: toRFC3339(row.updated_at as string) ?? '',
         pinned: row.pinned === true,
         archived: row.archived === true,
         unread: Number(row.unread),
         activeRunId: (row.active_run_id as string | null) ?? null,
         draft: (row.draft as string | null) ?? '',
         lastMessage: (row.last_message as string | null) ?? null,
         lastMessageAuthor:
            (row.last_message_author as 'user' | 'agent' | 'system' | null) ?? null,
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

   /**
    * One page of the transcript, oldest first.
    *
    * `before` is a message id: the page ends just before it, so a reader
    * scrolling up asks for what preceded the oldest message it holds.
    */
   async messages(
      conversationId: string,
      options: { before?: string | undefined; limit?: number } = {}
   ): Promise<ConversationMessage[]> {
      const before = options.before ?? null;
      const rows = await this.#sql`
         SELECT message.id, message.author_type, message.author_id, message.body,
                message.channel, message.created_at, message.run_id,
                COALESCE(person.name, agent.name, 'Berry') AS author_name
           FROM conversation_messages AS message
           LEFT JOIN users AS person
             ON person.id = message.author_id AND message.author_type = 'user'
           LEFT JOIN agents AS agent
             ON agent.id = message.author_id AND message.author_type = 'agent'
          WHERE message.conversation_id = ${conversationId}
            AND (${before}::uuid IS NULL
                 OR (message.created_at, message.id) <
                    (SELECT anchor.created_at, anchor.id FROM conversation_messages AS anchor
                      WHERE anchor.id = ${before}::uuid AND anchor.conversation_id = ${conversationId}))
          ORDER BY message.created_at DESC, message.id DESC
          LIMIT ${options.limit ?? 200}`;
      return rows
         .map((row) => ({
            id: row.id as string,
            authorType: row.author_type as 'user' | 'agent' | 'system',
            authorName: row.author_name as string,
            body: row.body as string,
            channel: row.channel as string,
            createdAt: toRFC3339(row.created_at as string) ?? '',
            runId: (row.run_id as string | null) ?? null,
         }))
         .reverse();
   }

   /**
    * The caller's latest open thread with one agent, or a new one.
    *
    * Kept for "chat with this agent" entry points; `createSession` is the
    * explicit "new chat", which is never deduplicated.
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
               AND me.left_at IS NULL AND me.archived_at IS NULL
              JOIN conversation_participants AS bot
                ON bot.conversation_id = conversation.id
               AND bot.participant_type = 'agent' AND bot.participant_id = ${input.agentId}
               AND bot.left_at IS NULL
             WHERE conversation.workspace_id = ${input.workspaceId}
               AND conversation.kind = 'direct'
               AND conversation.status = 'open'
             ORDER BY conversation.updated_at DESC, conversation.id DESC
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

   /** A new session with an agent of this workspace; never deduplicated. */
   async createSession(input: {
      workspaceId: string;
      userId: string;
      agentId: string;
      title: string | null;
   }): Promise<string> {
      const id = this.#newId();
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const [agent] = await tx`
            SELECT name FROM agents
             WHERE id = ${input.agentId} AND workspace_id = ${input.workspaceId} AND archived_at IS NULL`;
         if (!agent) throw new NotFound();
         await tx`
            INSERT INTO conversations (id, workspace_id, kind, topic, status, created_by, title_source)
            VALUES (${id}, ${input.workspaceId}, 'direct', ${input.title ?? (agent.name as string)}, 'open',
                    ${input.userId}, ${input.title ? SESSION_TITLE_SOURCES.user : SESSION_TITLE_SOURCES.agent})`;
         await tx`
            INSERT INTO conversation_participants (conversation_id, participant_type, participant_id, role)
            VALUES (${id}, 'user', ${input.userId}, 'owner'), (${id}, 'agent', ${input.agentId}, 'member')`;
      });
      return id;
   }

   /** A title a person set; generated titles never overwrite it afterwards. */
   async rename(id: string, userId: string, title: string): Promise<void> {
      const updated = await this.#sql`
         UPDATE conversations AS c SET topic = ${title}, title_source = 'user', updated_at = now()
          WHERE c.id = ${id}
            AND EXISTS (SELECT 1 FROM conversation_participants AS p
                         WHERE p.conversation_id = c.id AND p.participant_type = 'user'
                           AND p.participant_id = ${userId} AND p.left_at IS NULL)`;
      if (updated.count !== 1) throw new NotFound();
   }

   async setPinned(id: string, userId: string, pinned: boolean): Promise<void> {
      expectOne(
         await this.#sql`
            UPDATE conversation_participants
               SET pinned_at = CASE WHEN ${pinned} THEN now() ELSE NULL END
             WHERE conversation_id = ${id} AND participant_type = 'user'
               AND participant_id = ${userId} AND left_at IS NULL`
      );
   }

   async setArchived(id: string, userId: string, archived: boolean): Promise<void> {
      expectOne(
         await this.#sql`
            UPDATE conversation_participants
               SET archived_at = CASE WHEN ${archived} THEN now() ELSE NULL END
             WHERE conversation_id = ${id} AND participant_type = 'user'
               AND participant_id = ${userId} AND left_at IS NULL`
      );
   }

   async markRead(id: string, userId: string): Promise<void> {
      expectOne(
         await this.#sql`
            UPDATE conversation_participants SET last_read_at = now()
             WHERE conversation_id = ${id} AND participant_type = 'user'
               AND participant_id = ${userId} AND left_at IS NULL`
      );
   }

   async saveDraft(id: string, userId: string, draft: string): Promise<void> {
      expectOne(
         await this.#sql`
            UPDATE conversation_participants SET draft = ${draft}
             WHERE conversation_id = ${id} AND participant_type = 'user'
               AND participant_id = ${userId} AND left_at IS NULL`
      );
   }

   /** Deleting a direct session removes the thread and its messages; only its owner may. */
   async remove(id: string, userId: string): Promise<void> {
      const deleted = await this.#sql`
         DELETE FROM conversations AS c
          WHERE c.id = ${id} AND c.kind = 'direct'
            AND EXISTS (SELECT 1 FROM conversation_participants AS p
                         WHERE p.conversation_id = c.id AND p.participant_type = 'user'
                           AND p.participant_id = ${userId} AND p.role = 'owner' AND p.left_at IS NULL)`;
      if (deleted.count !== 1) throw new NotFound();
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

   /**
    * The reply a finished chat task left, posted once per run.
    *
    * Called from the run-terminal hook, which Task 13 registers once A's
    * `runs.chat_session_id` and `runs.priority` exist; the session's active run
    * then advances to its next queued task, if any.
    */
   async appendAgentReply(input: {
      conversationId: string;
      agentId: string;
      body: string;
      runId: string;
   }): Promise<void> {
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const [existing] = await tx`SELECT 1 FROM conversation_messages WHERE run_id = ${input.runId}`;
         if (existing) return; // a hook that fires twice posts once
         await tx`
            INSERT INTO conversation_messages (id, conversation_id, author_type, author_id, body, run_id)
            VALUES (${this.#newId()}, ${input.conversationId}, 'agent', ${input.agentId}, ${input.body},
                    ${input.runId})`;
         const [conversation] = await tx`
            UPDATE conversations SET updated_at = now(),
                   active_run_id = CASE WHEN active_run_id = ${input.runId}
                      THEN (SELECT r.id FROM runs AS r
                             WHERE r.chat_session_id = ${input.conversationId} AND r.status = 'queued'
                               AND r.id <> ${input.runId}
                             ORDER BY r.priority DESC, r.created_at ASC LIMIT 1)
                      ELSE active_run_id END
             WHERE id = ${input.conversationId}
            RETURNING workspace_id`;
         // Realtime: the reply reaches open chat views through the outbox and
         // the SSE hub, not by polling alone.
         await tx`
            INSERT INTO outbox_events (topic, aggregate_type, aggregate_id, workspace_id, payload)
            VALUES ('conversation.message.created', 'conversation', ${input.conversationId},
                    ${conversation?.workspace_id as string},
                    ${tx.json({ conversationId: input.conversationId, runId: input.runId } as never)})`;
      });
   }

   async pinnedAgents(userId: string, workspaceId: string): Promise<string[]> {
      const rows = await this.#sql`
         SELECT agent_id FROM user_pinned_agents
          WHERE user_id = ${userId} AND workspace_id = ${workspaceId}
          ORDER BY position`;
      return rows.map((row) => row.agent_id as string);
   }

   /** Replaces the caller's pinned agents; one outside the workspace is NotFound. */
   async setPinnedAgents(userId: string, workspaceId: string, agentIds: string[]): Promise<void> {
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         await tx`DELETE FROM user_pinned_agents WHERE user_id = ${userId} AND workspace_id = ${workspaceId}`;
         for (const [position, agentId] of [...new Set(agentIds)].entries()) {
            await tx`
               INSERT INTO user_pinned_agents (user_id, workspace_id, agent_id, position)
               VALUES (${userId}, ${workspaceId}, ${agentId}, ${position})`.catch((error: unknown) => {
               if ((error as { code?: string }).code === '23503') throw new NotFound();
               throw error;
            });
         }
      });
   }
}

/** Every per-person mutation checks participation in the same statement. */
function expectOne(result: { count: number }): void {
   if (result.count !== 1) throw new NotFound();
}
