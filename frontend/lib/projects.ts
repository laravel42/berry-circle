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
   githubRepo: z.string().nullish(),
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
   if (apiProject.githubRepo) {
      project.githubRepo = apiProject.githubRepo;
   }
   if (apiProject.description) {
      project.description = apiProject.description;
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
   githubRepo?: string;
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
   if (input.githubRepo) body.githubRepo = input.githubRepo;

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

/**
 * Delete a project.
 *
 * Unlike patchWorkspaceProject above, a failure is raised rather than
 * swallowed. That helper returns undefined so an optimistic field can
 * reconcile on the next load; a delete cannot borrow that, because showing a
 * project as gone when it is not means someone stops looking for it.
 */
export async function deleteWorkspaceProject(projectId: string): Promise<void> {
   await apiFetch(`/api/v1/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
   });
}

const repositorySchema = z.object({
   id: z.number(),
   fullName: z.string(),
   name: z.string(),
   private: z.boolean(),
   defaultBranch: z.string(),
   description: z.string().optional(),
});

export type GitHubRepository = z.infer<typeof repositorySchema>;

const accessSchema = z.object({
   selectedOnly: z.boolean(),
   installed: z.boolean(),
   manageUrl: z.string().optional(),
   installUrl: z.string().optional(),
});

export type GitHubAccess = z.infer<typeof accessSchema>;

export interface RepositoryChoices {
   repositories: GitHubRepository[];
   access: GitHubAccess;
}

/**
 * Repositories the workspace's GitHub connection can see.
 *
 * Errors are raised rather than swallowed: an empty picker and a picker that
 * could not load look identical, and the fixes are opposite — connect GitHub
 * versus try again.
 */
export async function loadGitHubRepositories(): Promise<RepositoryChoices> {
   const json: unknown = await apiFetch('/api/v1/integrations/github/repositories');
   const parsed = z
      .object({ repositories: z.array(repositorySchema), access: accessSchema })
      .safeParse(json);
   if (!parsed.success) throw new Error('Repository list was not recognized');
   return { repositories: parsed.data.repositories, access: parsed.data.access };
}

/** Link a project to a repository, or unlink it with null. */
export async function setProjectRepository(
   projectId: string,
   fullName: string | null
): Promise<void> {
   await apiFetch(`/api/v1/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ githubRepo: fullName }),
   });
}
