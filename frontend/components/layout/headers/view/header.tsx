'use client';

import { SavedViewsBar } from '@/components/common/views/saved-views-bar';
import { DisplayOptions } from '@/components/layout/headers/display-options';
import { IssueFilterTrigger } from '@/components/common/issues/issue-filter-trigger';
import { Button } from '@/components/ui/button';
import { filterIssuesForView, filterProjectsForView } from '@/data/views';
import { useIssuesStore } from '@/store/issues-store';
import { useProjectsStore } from '@/store/projects-store';
import { useRightPanelStore } from '@/store/right-panel-store';
import { useViewsStore } from '@/store/views-store';
import { BarChart3 } from 'lucide-react';
import { useParams } from 'next/navigation';

export default function Header() {
   const { viewId } = useParams<{ orgId: string; viewId: string }>();
   const view = useViewsStore((state) => state.getViewById(viewId));
   const issues = useIssuesStore((state) => state.issues);
   const projects = useProjectsStore((state) => state.projects);
   const { openPanel, togglePanel } = useRightPanelStore();

   const count = view
      ? view.type === 'issue'
         ? filterIssuesForView(view, issues).length
         : filterProjectsForView(view, projects).length
      : 0;

   return (
      <div className="w-full flex flex-col">
         <SavedViewsBar />
         <div className="w-full flex justify-between items-center border-b py-1.5 px-6 h-10">
            <span className="text-muted-foreground">
               {count} {view?.type === 'project' ? 'projects' : 'tasks'}
            </span>
            {view?.type !== 'project' && (
               <div className="flex items-center gap-1">
                  <IssueFilterTrigger iconOnly />
                  <Button
                     size="xs"
                     variant={openPanel === 'insights' ? 'secondary' : 'ghost'}
                     onClick={() => togglePanel('insights')}
                     aria-label="Toggle insights panel"
                  >
                     <BarChart3 className="size-4" />
                  </Button>
                  <DisplayOptions iconOnly />
               </div>
            )}
         </div>
      </div>
   );
}
