import type { Provider } from '@/lib/integrations';
import { create } from 'zustand';

interface ProvidersState {
   providers: Provider[];
   loaded: boolean;
   hydrateProviders: (providers: Provider[]) => void;
}

/** The tool catalog, read once per session for the action step picker. */
export const useProvidersStore = create<ProvidersState>((set) => ({
   providers: [],
   loaded: false,
   hydrateProviders: (providers) => set({ providers, loaded: true }),
}));
