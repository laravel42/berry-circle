import { Issue } from './issues';
import { Project } from './projects';
import { StatusCategory } from './status';
import { User } from './users';

export type ViewType = 'issue' | 'project';

/** Declarative filter of a saved view, applied by getViewIssues/getViewProjects. */
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
   /** Who can see it. Private views are the owner's alone. */
   visibility: 'private' | 'workspace';
   /** Optimistic-concurrency counter; a save must send the one it read. */
   revision: number;
   /** The saved filter chips, exactly as the filter bar stores them. */
   savedFilters: unknown[];
   /** Saved layout and display defaults (`layout`, `grouping`, `ordering`, …). */
   display: Record<string, unknown>;
   /** The scope the view was saved from (`all`, `assigned`, …). */
   scope?: string;
}

/** Apply an issue view's declarative filter to the issue list. */
export function filterIssuesForView(view: View, source: Issue[] = []): Issue[] {
   const { filter } = view;
   return source.filter((issue) => {
      if (filter.statusCategories && !filter.statusCategories.includes(issue.status.category)) {
         return false;
      }
      if (filter.statusIds && !filter.statusIds.includes(issue.status.id)) return false;
      if (filter.labelIds && !issue.labels.some((label) => filter.labelIds?.includes(label.id))) {
         return false;
      }
      if (filter.priorityIds && !filter.priorityIds.includes(issue.priority.id)) return false;
      if (filter.hasProject && !issue.project) return false;
      if (filter.unassigned && issue.assignee) return false;
      return true;
   });
}

/** Apply a project view's declarative filter to the project list. */
export function filterProjectsForView(view: View, source: Project[] = []): Project[] {
   const { filter } = view;
   return source.filter((project) => {
      if (filter.statusCategories && !filter.statusCategories.includes(project.status.category)) {
         return false;
      }
      if (filter.priorityIds && !filter.priorityIds.includes(project.priority.id)) return false;
      return true;
   });
}
