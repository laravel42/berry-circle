import type { Project } from '@/data/projects';
import { health } from '@/data/projects';
import type { User } from '@/data/users';
import { FolderKanban } from 'lucide-react';
import { z } from 'zod';
import { apiFetch } from './api';
import { connectionSchema, newIdempotencyKey } from './api-schemas';
import {
   apiPriorityFromUi,
   apiProjectStatusFromUi,
   uiPriorityFromApi,
   uiStatusFromProjectApi,
} from './catalog';

const projectSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   name: z.string(),
   description: z.string().nullish(),
   status: z.string(),
   priority: z.string(),
   startDate: z.string().nullish(),
   targetDate: z.string().nullish(),
   createdAt: z.string(),
   updatedAt: z.string(),
});

const projectConnectionSchema = connectionSchema(projectSchema);

type ApiProject = z.infer<typeof projectSchema>;

export type ProjectPatchBody = {
   name?: string;
   description?: string | null;
   status?: string;
   priority?: string;
   startDate?: string | null;
   targetDate?: string | null;
};

export function toUiProject(apiProject: ApiProject, lead: User): Project | undefined {
   const status = uiStatusFromProjectApi(apiProject.status);
   const priority = uiPriorityFromApi(apiProject.priority);
   if (!status || !priority) return undefined;
   const noUpdate = health.find((entry) => entry.id === 'no-update');
   if (!noUpdate) return undefined;

   const project: Project = {
      id: apiProject.id,
      name: apiProject.name,
      status,
      icon: FolderKanban,
      percentComplete: 0,
      startDate: apiProject.startDate ?? apiProject.createdAt.slice(0, 10),
      lead,
      priority,
      health: noUpdate,
      teamId: apiProject.workspaceId,
      labels: [],
   };
   if (apiProject.targetDate) {
      project.targetDate = apiProject.targetDate;
   }
   return project;
}

async function fetchProjectPage(
   workspaceId: string,
   lead: User,
   after?: string
): Promise<{ projects: Project[]; nextCursor?: string }> {
   const params = new URLSearchParams({
      workspaceId,
      first: '100',
   });
   if (after) params.set('after', after);

   const json: unknown = await apiFetch(`/api/v1/projects?${params.toString()}`);
   const parsed = projectConnectionSchema.safeParse(json);
   if (!parsed.success) return { projects: [] };

   const projects: Project[] = [];
   for (const node of parsed.data.nodes) {
      const mapped = toUiProject(node, lead);
      if (mapped) projects.push(mapped);
   }

   const { hasNextPage, endCursor } = parsed.data.pageInfo;
   return {
      projects,
      nextCursor: hasNextPage && endCursor ? endCursor : undefined,
   };
}

export async function loadWorkspaceProjects(workspaceId: string, lead: User): Promise<Project[]> {
   if (!workspaceId) return [];
   const collected: Project[] = [];
   try {
      let after: string | undefined;
      for (let page = 0; page < 20; page += 1) {
         const batch = await fetchProjectPage(workspaceId, lead, after);
         collected.push(...batch.projects);
         if (!batch.nextCursor) break;
         after = batch.nextCursor;
      }
      return collected;
   } catch {
      return collected;
   }
}

export async function createWorkspaceProject(input: {
   workspaceId: string;
   name: string;
   description?: string;
   statusId?: string;
   priorityId?: string;
   startDate?: string;
   targetDate?: string;
   lead: User;
}): Promise<Project> {
   const body: Record<string, string> = {
      workspaceId: input.workspaceId,
      name: input.name,
      status: apiProjectStatusFromUi(input.statusId ?? 'to-do'),
      priority: apiPriorityFromUi(input.priorityId ?? 'no-priority'),
   };
   if (input.description) body.description = input.description;
   if (input.startDate) body.startDate = input.startDate;
   if (input.targetDate) body.targetDate = input.targetDate;

   const json: unknown = await apiFetch('/api/v1/projects', {
      method: 'POST',
      headers: { 'Idempotency-Key': newIdempotencyKey() },
      body: JSON.stringify(body),
   });
   const parsed = projectSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Create project response was not recognized');
   }
   const project = toUiProject(parsed.data, input.lead);
   if (!project) {
      throw new Error('Created project could not be displayed');
   }
   return project;
}

export async function getWorkspaceProject(
   projectId: string,
   lead: User
): Promise<Project | undefined> {
   try {
      const json: unknown = await apiFetch(`/api/v1/projects/${projectId}`);
      const parsed = projectSchema.safeParse(json);
      if (!parsed.success) return undefined;
      return toUiProject(parsed.data, lead);
   } catch {
      return undefined;
   }
}

export async function patchWorkspaceProject(
   projectId: string,
   patch: ProjectPatchBody,
   lead: User
): Promise<Project | undefined> {
   try {
      const json: unknown = await apiFetch(`/api/v1/projects/${projectId}`, {
         method: 'PATCH',
         body: JSON.stringify(patch),
      });
      const parsed = projectSchema.safeParse(json);
      if (!parsed.success) return undefined;
      return toUiProject(parsed.data, lead);
   } catch {
      return undefined;
   }
}
