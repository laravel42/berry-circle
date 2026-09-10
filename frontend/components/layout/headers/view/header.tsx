'use client';

import { Button } from '@/components/ui/button';
import { filterIssuesForView, filterProjectsForView } from '@/data/views';
import { useIssuesStore } from '@/store/issues-store';
import { useProjectsStore } from '@/store/projects-store';
import { useRightPanelStore } from '@/store/right-panel-store';
import { useViewsStore } from '@/store/views-store';
import { BarChart3, MoreHorizontal, Star } from 'lucide-react';
import { useParams } from 'next/navigation';

export default function Header() {
   const { viewId } = useParams<{ orgId: string; viewId: string }>();
   const view = useViewsStore((state) => state.getViewById(viewId));
   const issues = useIssuesStore((state) => state.issues);
   const projects = useProjectsStore((state) => state.projects);
   const { openPanel, togglePanel } = useRightPanelStore();

   if (!view) return null;

   const count =
      view.type === 'issue'
         ? filterIssuesForView(view, issues).length
         : filterProjectsForView(view, projects).length;

   return (
      <div className="w-full flex flex-col">
         <div className="w-full flex justify-between items-center border-b py-1.5 px-6 h-10">
            <div className="flex items-center gap-2 min-w-0">
               <span className="inline-flex size-5 items-center justify-center rounded bg-muted/50 shrink-0">
                  {view.icon}
               </span>
               <span className="font-medium truncate">{view.name}</span>
               <Star className="size-3.5 text-muted-foreground shrink-0 ml-1" />
               <MoreHorizontal className="size-3.5 text-muted-foreground shrink-0" />
            </div>
         </div>
         <div className="w-full flex justify-between items-center border-b py-1.5 px-6 h-10">
            <span className="text-muted-foreground">
               {count} {view.type === 'issue' ? 'issues' : 'projects'}
            </span>
            {view.type === 'issue' && (
               <Button
                  size="xs"
                  variant={openPanel === 'insights' ? 'secondary' : 'ghost'}
                  onClick={() => togglePanel('insights')}
               >
                  <BarChart3 className="size-4" />
               </Button>
            )}
         </div>
      </div>
   );
}
