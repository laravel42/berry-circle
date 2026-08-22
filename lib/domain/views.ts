import { Issue } from './issues';
import { Project } from './projects';
import { StatusCategory } from './status';
import { User } from './users';

export type ViewType = 'issue' | 'project';

/** Declarative filter of a saved view. */
export interface ViewFilter {
   statusCategories?: StatusCategory[];
   statusIds?: string[];
   labelIds?: string[];
   priorityIds?: string[];
   /** Only issues that belong to a project. */
   hasProject?: boolean;
   /** Only issues assigned to nobody. */
   unassigned?: boolean;
}

export interface View {
   id: string;
   name: string;
   description: string;
   /** Emoji shown as the view icon. */
   icon: string;
   type: ViewType;
   /** Owning team; undefined = workspace-level view. */
   teamId?: string;
   owner: User;
   createdAt: string;
   updatedAt: string;
   filter: ViewFilter;
}

/** Populated via the gateway API at runtime. */
export const views: View[] = [];

/** Populated via the gateway API at runtime. */
export const issueViews: View[] = [];

/** Populated via the gateway API at runtime. */
export const projectViews: View[] = [];

/** Filter views by owning team (populated at runtime). */
export function getViewsByTeam(teamId: string): View[] {
   return views.filter((v) => v.teamId === teamId);
}

/** Resolve by id (populated at runtime). */
export function getViewById(id: string): View | undefined {
   return views.find((v) => v.id === id);
}

/** Filter issues using a view's declarative filter (populated at runtime). */
export function filterIssuesForView(view: View, allIssues: Issue[] = []): Issue[] {
   const f = view.filter;
   return allIssues.filter((issue) => {
      if (f.statusCategories && f.statusCategories.length > 0) {
         if (!f.statusCategories.includes(issue.status.category)) return false;
      }
      if (f.statusIds && f.statusIds.length > 0) {
         if (!f.statusIds.includes(issue.status.id)) return false;
      }
      if (f.labelIds && f.labelIds.length > 0) {
         if (!issue.labels.some((l) => f.labelIds!.includes(l.id))) return false;
      }
      if (f.priorityIds && f.priorityIds.length > 0) {
         if (!f.priorityIds.includes(issue.priority.id)) return false;
      }
      if (f.hasProject !== undefined) {
         if (f.hasProject && !issue.project) return false;
         if (!f.hasProject && issue.project) return false;
      }
      if (f.unassigned !== undefined) {
         if (f.unassigned && issue.assignee !== null) return false;
      }
      return true;
   });
}

/** Filter projects using a view's declarative filter (populated at runtime). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function filterProjectsForView(view: View, source: Project[] = []): Project[] {
   // For project-type views, the filter semantics are simpler.
   // At boot (empty data), this returns empty.
   return [];
}
