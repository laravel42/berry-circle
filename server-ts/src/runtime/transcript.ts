import type { Sql } from '../db/pool.ts';
import type { TranscriptMessage } from './envelope.ts';

/**
 * The conversation a cold runtime restores: earlier runs of this agent on
 * this issue (or chat), as the text Berry recorded — what was asked, and what
 * the agent said. Tool calls are not in it; the ledger never stored their
 * arguments, and the warm path keeps them when it can.
 */

/** Matches the runtime's SlidingWindowConversationManager window (`WINDOW_SIZE` in agents/runtime/agent.ts). */
const TRANSCRIPT_MESSAGES = 60;
const TRANSCRIPT_CHARS = 200_000;

export async function buildTranscript(
   sql: Sql,
   input: {
      agentId: string;
      issueId: string | null;
      chatSessionId: string | null;
      excludeRunId: string;
      maxMessages?: number;
      maxChars?: number;
   }
): Promise<TranscriptMessage[]> {
   if (!input.issueId && !input.chatSessionId) return [];
   const rows = await sql`
      SELECT r.prompt, r.instructions, r.output, i.title,
             CASE WHEN i.id IS NULL THEN NULL ELSE berry_issue_identifier(r.workspace_id, i.number) END AS identifier
        FROM runs AS r
        LEFT JOIN issues AS i ON i.id = r.issue_id
       WHERE r.agent_id = ${input.agentId}
         AND r.kind = 'agent'
         AND r.id::text <> ${input.excludeRunId}
         AND r.status IN ('succeeded', 'failed', 'cancelled')
         AND (${input.issueId}::uuid IS NULL OR r.issue_id = ${input.issueId}::uuid)
         AND (${input.chatSessionId}::uuid IS NULL OR r.chat_session_id = ${input.chatSessionId}::uuid)
       ORDER BY r.created_at ASC, r.id ASC`;

   const messages: TranscriptMessage[] = [];
   for (const row of rows) {
      const asked =
         (row.prompt as string | null) ??
         (row.instructions as string | null) ??
         `Work on ${(row.identifier as string | null) ?? 'the task'}: ${(row.title as string | null) ?? ''}`.trim();
      messages.push({ role: 'user', text: asked });
      const said = ((row.output as string | null) ?? '').trim();
      if (said !== '') messages.push({ role: 'assistant', text: said });
   }

   const maxMessages = input.maxMessages ?? TRANSCRIPT_MESSAGES;
   const maxChars = input.maxChars ?? TRANSCRIPT_CHARS;
   const kept: TranscriptMessage[] = [];
   let chars = 0;
   for (let i = messages.length - 1; i >= 0 && kept.length < maxMessages; i -= 1) {
      const message = messages[i];
      if (!message) continue;
      if (chars + message.text.length > maxChars) break;
      chars += message.text.length;
      kept.unshift(message);
   }
   return kept;
}
