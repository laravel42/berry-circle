import { LucideIcon } from 'lucide-react';

export interface AgentExample {
   id: string;
   icon: LucideIcon;
   title: string;
   description: string;
   prompt: string;
}

/** Populated via the gateway API at runtime. */
export const agentExamples: AgentExample[] = [];

export const agentSkills: string[] = [];

/** Derive a chat title from the first user message. */
export function chatTitleFrom(input: string): string {
   return input.slice(0, 60);
}

/** Get a canned agent reply (stub — replaced by API call in M3). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getAgentReply(_input: string): string {
   return '';
}
