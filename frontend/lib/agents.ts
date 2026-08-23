import type { User } from '@/data/users';
import { z } from 'zod';
import { apiFetch } from './api';
import { connectionSchema } from './api-schemas';
import { toUiUser } from './catalog';

const agentSchema = z.object({
   id: z.string(),
   name: z.string(),
   description: z.string().nullish(),
   avatarUrl: z.string().nullable(),
   status: z.string(),
   capabilities: z.array(z.string()),
   createdAt: z.string(),
   updatedAt: z.string(),
});

const agentConnectionSchema = connectionSchema(agentSchema);

export type Agent = z.infer<typeof agentSchema>;

const PREFERRED_AGENT_NAMES = ['berry-prototype', 'hello-world', 'assistant', 'coder'];

export interface AgentStatusDisplay {
   label: string;
   tone: 'online' | 'busy' | 'offline' | 'unknown';
}

/** Map gateway AgentStatus to list UI copy. */
export function agentStatusDisplay(status: string): AgentStatusDisplay {
   switch (status) {
      case 'available':
         return { label: 'Online', tone: 'online' };
      case 'busy':
         return { label: 'Busy', tone: 'busy' };
      case 'offline':
         return { label: 'Offline', tone: 'offline' };
      default:
         return { label: 'Unknown', tone: 'unknown' };
   }
}

/** Load workspace agents; OpenFang summaries are reconciled server-side. */
export async function loadWorkspaceAgents(): Promise<Agent[]> {
   const collected: Agent[] = [];
   let after: string | undefined;
   for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ first: '100' });
      if (after) params.set('after', after);
      const json: unknown = await apiFetch(`/api/v1/agents?${params.toString()}`);
      const parsed = agentConnectionSchema.safeParse(json);
      if (!parsed.success) {
         throw new Error('Agent list was not recognized');
      }
      collected.push(...parsed.data.nodes);
      const { hasNextPage, endCursor } = parsed.data.pageInfo;
      if (!hasNextPage || !endCursor || parsed.data.nodes.length === 0) {
         break;
      }
      after = endCursor;
   }
   return collected;
}

export async function getWorkspaceAgent(agentId: string): Promise<Agent> {
   const json: unknown = await apiFetch(`/api/v1/agents/${encodeURIComponent(agentId)}`);
   const parsed = agentSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Agent response was not recognized');
   }
   return parsed.data;
}

export function agentToUser(agent: Agent): User {
   return toUiUser({
      id: agent.id,
      name: agent.name,
      avatarUrl: agent.avatarUrl,
      type: 'agent',
   });
}

/** Prefer the prototype OpenRouter agent, then other ready runtimes. */
export function pickRunnableAgent(agents: Agent[]): Agent | undefined {
   for (const name of PREFERRED_AGENT_NAMES) {
      const match = agents.find(
         (agent) => agent.name === name && agent.status !== 'offline' && agent.status !== 'unknown'
      );
      if (match) return match;
   }
   return (
      agents.find((agent) => agent.status === 'available') ??
      agents.find((agent) => agent.status !== 'offline') ??
      agents[0]
   );
}
