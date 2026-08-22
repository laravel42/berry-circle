import type { LucideIcon } from 'lucide-react';

/* -------------------------------------------------------------------------- */
/*                          Agent page mock behaviors                         */
/* -------------------------------------------------------------------------- */

export interface AgentExample {
   id: string;
   icon: LucideIcon;
   title: string;
   description: string;
   prompt: string;
}

/** Prompt suggestions for the agent page. Empty until real agents exist. */
export const agentExamples: AgentExample[] = [];

/** Skill chips shown on the agent page. */
export const agentSkills: string[] = [];

/**
 * Placeholder reply while the agent chat is not wired to the gateway.
 * Deterministic — no network, no randomness.
 */
export function getAgentReply(_input: string): string {
   return `The agent chat is not connected yet.

Agent runs will stream here once the gateway wiring lands — until then this page boots empty.`;
}

/** Short chat title derived from the first user message. */
export function chatTitleFrom(input: string): string {
   const clean = input.trim().replace(/\s+/g, ' ');
   return clean.length > 42 ? `${clean.slice(0, 42)}…` : clean || 'New chat';
}
