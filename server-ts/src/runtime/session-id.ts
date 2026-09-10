import { createHash } from 'node:crypto';

/**
 * Which runtime session a task lands on.
 *
 * `(agent, issue)`, not the run: a follow-up run on the same issue reaches the
 * same warm microVM while it lives — same process, same checkout, same
 * in-memory conversation (spec 2.2a). A chat is `(agent, chat session)`. A
 * completion shares nothing with anything, so it is keyed by its own run.
 */
export function sessionKeyFor(input: {
   kind: 'agent' | 'completion';
   runId: string;
   agentId: string;
   issueId?: string | null;
   chatSessionId?: string | null;
}): string {
   if (input.kind === 'completion') return `completion:${input.runId}`;
   if (input.issueId) return `${input.agentId}:${input.issueId}`;
   if (input.chatSessionId) return `${input.agentId}:chat:${input.chatSessionId}`;
   throw new Error('an agent task needs an issue or a chat session to name its session');
}

/**
 * The AgentCore `runtimeSessionId` for a session key.
 *
 * Hashed so the id is always 70 characters — over AgentCore's 33 minimum —
 * and carries no identifier in the clear into AWS logs.
 */
export function runtimeSessionIdFor(sessionKey: string): string {
   return `berry-${createHash('sha256').update(sessionKey).digest('hex')}`;
}
