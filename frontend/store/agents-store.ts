import type { Agent, AgentRoster } from '@/lib/agents';
import { create } from 'zustand';

/**
 * The workspace's agents, and the facts the list draws beside them.
 *
 * The archive is a second collection rather than a flag on the first: it is
 * loaded on demand and is not part of "the agents in this workspace" for any
 * other screen. The roster (owner, runtime, load, recent activity) is keyed by
 * agent id and read by both the toolbar and the table.
 */

interface AgentsState {
   agents: Agent[];
   /** Null until the archive has been asked for. */
   archived: Agent[] | null;
   roster: Map<string, AgentRoster>;
   error: string | null;
   hydrateAgents: (agents: Agent[], error?: string | null) => void;
   hydrateArchived: (agents: Agent[] | null) => void;
   hydrateRoster: (roster: Map<string, AgentRoster>) => void;
   /** Replaces one agent wherever it is held, so a row updates in place. */
   upsertAgent: (agent: Agent) => void;
   /** Drops an agent from the live list, for an archive that succeeded. */
   removeAgent: (id: string) => void;
   getAgentById: (id: string) => Agent | undefined;
}

const replace = (agents: Agent[], next: Agent): Agent[] =>
   agents.some((entry) => entry.id === next.id)
      ? agents.map((entry) => (entry.id === next.id ? next : entry))
      : agents;

export const useAgentsStore = create<AgentsState>((set, get) => ({
   agents: [],
   archived: null,
   roster: new Map(),
   error: null,

   hydrateAgents: (agents, error = null) => set({ agents, error }),
   hydrateArchived: (archived) => set({ archived }),
   hydrateRoster: (roster) => set({ roster }),

   upsertAgent: (agent) =>
      set((state) => ({
         agents: state.agents.some((entry) => entry.id === agent.id)
            ? replace(state.agents, agent)
            : agent.archivedAt
              ? state.agents
              : [...state.agents, agent],
         archived: state.archived ? replace(state.archived, agent) : state.archived,
      })),

   removeAgent: (id) =>
      set((state) => ({
         agents: state.agents.filter((entry) => entry.id !== id),
         archived: state.archived?.filter((entry) => entry.id !== id) ?? null,
      })),

   getAgentById: (id) =>
      get().agents.find((agent) => agent.id === id) ??
      get().archived?.find((agent) => agent.id === id),
}));
