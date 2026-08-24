import type { Agent } from '@/lib/agents';
import { create } from 'zustand';

interface AgentsState {
   agents: Agent[];
   error: string | null;
   hydrateAgents: (agents: Agent[], error?: string | null) => void;
   getAgentById: (id: string) => Agent | undefined;
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
   agents: [],
   error: null,
   hydrateAgents: (agents, error = null) => set({ agents, error }),
   getAgentById: (id) => get().agents.find((agent) => agent.id === id),
}));
