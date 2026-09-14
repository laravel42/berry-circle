'use client';

import { ContentBlocks } from '@/components/common/issues/details/content-blocks';
import { Button } from '@/components/ui/button';
import { useDetailDrawerClose, useInDetailDrawer } from '@/components/layout/detail-drawer-context';
import { useProject } from '@/hooks/use-project';
import { getProjectDetail } from '@/data/project-details';
import { useIssuesStore } from '@/store/issues-store';
import { useProjectUpdatesStore } from '@/store/project-updates-store';
import { descriptionToBlocks } from '@/lib/description-blocks';
import { WORKSPACE_SLUG } from '@/lib/config';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { ProjectActivityFeedList } from './project-activity-section';
import { ProjectPropertiesPanel } from './project-properties-panel';
import { ProjectTasksSection } from './project-tasks-section';

interface ProjectOverviewProps {
   projectId: string;
}

/** Unified project detail — layout mirrors issue detail. */
export default function ProjectOverview({ projectId }: ProjectOverviewProps) {
   const { orgId } = useParams<{ orgId: string }>();
   const inDrawer = useInDetailDrawer();
   const closeDrawer = useDetailDrawerClose();
   const router = useRouter();
   const t = useTranslations('issueLists');
   const agentContext = t('projects.agentContext');
   const project = useProject(projectId);
   const detail = getProjectDetail(projectId);
   const { issues: allIssues } = useIssuesStore();
   const { postUpdate } = useProjectUpdatesStore();
   const [draft, setDraft] = useState('');
   const issues = useMemo(
      () => (project ? allIssues.filter((issue) => issue.project?.id === project.id) : []),
      [allIssues, project]
   );

   const descriptionBlocks = useMemo(
      () =>
         detail.description.length > 0
            ? detail.description
            : descriptionToBlocks(project?.description),
      [detail.description, project?.description]
   );

   const afterDelete = useCallback(() => {
      if (closeDrawer) {
         closeDrawer();
         return;
      }
      router.push(`/${orgId ?? WORKSPACE_SLUG}/projects`);
   }, [closeDrawer, router, orgId]);

   const submitComment = useCallback(() => {
      const text = draft.trim();
      if (!text || !project) return;
      postUpdate(project.id, 'on-track', text);
      setDraft('');
   }, [draft, postUpdate, project]);

   if (!project) {
      return <div className="p-6 text-muted-foreground">Loading project…</div>;
   }

   return (
      <div
         className={cn(
            'h-full min-h-0 w-full overflow-hidden bg-container',
            inDrawer ? 'grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto]' : 'flex'
         )}
      >
         <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-y-auto">
               <div className="mx-auto max-w-3xl px-6 py-6 pb-4 sm:px-8 sm:py-8">
                  <h1 className="text-balance font-display leading-[1.08] tracking-[-0.025em]">
                     {project.name}
                  </h1>

                  {/* Named for what it is: agents read this before they touch
                      the project's tasks, so it is context rather than a note
                      to the team. */}
                  <div className="mt-4 mb-1 font-medium uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
                     {agentContext}
                  </div>
                  <div className="mt-1">
                     {descriptionBlocks.length > 0 ? (
                        <ContentBlocks blocks={descriptionBlocks} />
                     ) : detail.summary ? (
                        <p className="leading-relaxed text-muted-foreground">{detail.summary}</p>
                     ) : (
                        <p className="text-muted-foreground">No description yet.</p>
                     )}
                  </div>

                  <div className="mt-4">
                     <ProjectActivityFeedList projectId={projectId} />
                  </div>

                  <div className="mt-6 border-t border-border/60 pt-4 pb-2">
                     <ProjectTasksSection issues={issues} />
                  </div>
               </div>
            </div>

            <div className="relative z-10 shrink-0 border-t border-border/60 bg-container">
               <div className="mx-auto w-full max-w-3xl px-6 pt-5 pb-8 sm:px-8">
                  {/* A project update, not an issue comment. It used to borrow
                      the issue composer, which has since become issue-shaped —
                      mentions that start agents, per-task drafts, uploads onto
                      a task. None of that applies to a project update, so this
                      posts through the project updates store directly. */}
                  <div className="flex flex-col gap-2">
                     <textarea
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                           if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                              event.preventDefault();
                              submitComment();
                           }
                        }}
                        placeholder="Post an update…"
                        aria-label="Project update"
                        rows={2}
                        className="w-full resize-none bg-transparent text-foreground outline-none placeholder:text-foreground/40"
                     />
                     <div className="flex justify-end">
                        <Button size="xs" onClick={submitComment} disabled={!draft.trim()}>
                           post update
                        </Button>
                     </div>
                  </div>
               </div>
            </div>
         </div>

         <aside className="hidden h-full min-w-0 w-[221px] shrink-0 flex-col overflow-hidden border-l bg-muted/15 px-5 pt-6 pb-3.5 lg:flex">
            <ProjectPropertiesPanel
               project={project}
               detail={detail}
               issues={issues}
               compact
               onDeleted={afterDelete}
            />
         </aside>
      </div>
   );
}
