import type { User } from '@/data/users';
import { create } from 'zustand';

interface MembersState {
   members: User[];
   hydrateMembers: (members: User[]) => void;
   getMemberById: (id: string) => User | undefined;
}

export const useMembersStore = create<MembersState>((set, get) => ({
   members: [],

   hydrateMembers: (members) => set({ members }),

   getMemberById: (id) => get().members.find((member) => member.id === id),
}));
