import { create } from 'zustand';
import { health, Project } from '@/data/projects';
import type { Priority } from '@/data/priorities';
import type { Status } from '@/data/status';
import type { User } from '@/data/users';
import { apiPriorityFromUi, apiProjectStatusFromUi } from '@/lib/catalog';
import { patchWorkspaceProject, type ProjectPatchBody } from '@/lib/projects';
import { useSessionStore } from '@/store/session-store';

interface ProjectsState {
   projects: Project[];
   hydrateProjects: (projects: Project[]) => void;
   addProject: (project: Project) => void;
   updateProject: (id: string, patch: Partial<Project>) => void;
   updateProjectStatus: (id: string, status: Status) => void;
   updateProjectPriority: (id: string, priority: Priority) => void;
   updateProjectTargetDate: (id: string, targetDate: string | undefined) => void;
   updateProjectLead: (id: string, lead: User) => void;
   updateProjectHealth: (id: string, healthId: Project['health']['id']) => void;
   deleteProject: (id: string) => void;
   getProjectById: (id: string) => Project | undefined;
}

function leadFromSession(): User {
   const user = useSessionStore.getState().user;
   return (
      user ?? {
         id: 'me',
         name: 'You',
         avatarUrl: '',
         email: '',
         status: 'online',
         role: 'Member',
         joinedDate: '',
         teamIds: [],
         timezone: 'UTC',
      }
   );
}

function persistPatch(projectId: string, body: ProjectPatchBody, optimistic: Partial<Project>): void {
   useProjectsStore.getState().updateProject(projectId, optimistic);
   void patchWorkspaceProject(projectId, body, leadFromSession()).then((updated) => {
      if (updated) {
         useProjectsStore.getState().updateProject(projectId, updated);
      }
   });
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
   projects: [],

   hydrateProjects: (projects) => set({ projects }),

   deleteProject: (id) =>
      set((state) => ({ projects: state.projects.filter((project) => project.id !== id) })),

   addProject: (project) =>
      set((state) => ({
         projects: [project, ...state.projects.filter((entry) => entry.id !== project.id)],
      })),

   updateProject: (id, patch) =>
      set((state) => ({
         projects: state.projects.map((project) =>
            project.id === id ? { ...project, ...patch } : project
         ),
      })),

   updateProjectStatus: (id, status) => {
      get().updateProject(id, { status });
      persistPatch(id, { status: apiProjectStatusFromUi(status.id) }, { status });
   },

   updateProjectPriority: (id, priority) => {
      get().updateProject(id, { priority });
      persistPatch(id, { priority: apiPriorityFromUi(priority.id) }, { priority });
   },

   updateProjectTargetDate: (id, targetDate) => {
      get().updateProject(id, { targetDate });
      persistPatch(id, { targetDate: targetDate ?? null }, { targetDate });
   },

   updateProjectLead: (id, lead) => {
      get().updateProject(id, { lead });
   },

   updateProjectHealth: (id, healthId) => {
      const next = health.find((item) => item.id === healthId);
      if (next) get().updateProject(id, { health: next });
   },

   getProjectById: (id) => get().projects.find((project) => project.id === id),
}));
