'use client';

import { ProjectActionsMenu } from '@/components/common/projects/project-actions-menu';
import { useDetailDrawerClose } from '@/components/layout/detail-drawer-context';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useProject } from '@/hooks/use-project';
import { useRightPanelStore } from '@/store/right-panel-store';
import { BarChart3, ChevronRight, Link2, PanelRight, Star } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useCallback } from 'react';

const PROJECT_TABS = [
   { label: 'Overview', segment: 'overview' },
   { label: 'Activity', segment: 'activity' },
   { label: 'Issues', segment: 'issues' },
];

function ProjectTabs({ projectId }: { projectId: string }) {
   const { orgId } = useParams<{ orgId: string }>();
   const pathname = usePathname();

   return (
      <div className="flex items-center gap-1">
         {PROJECT_TABS.map((tab) => {
            const href = `/${orgId}/project/${projectId}/${tab.segment}`;
            const isActive = pathname === href;
            return (
               <Link
                  key={tab.segment}
                  href={href}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                     'px-2.5 h-7 inline-flex items-center rounded-full border font-medium transition-colors',
                     isActive
                        ? 'bg-accent text-foreground border-border'
                        : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/50'
                  )}
               >
                  {tab.label}
               </Link>
            );
         })}
      </div>
   );
}

function PanelToggles() {
   const { openPanel, togglePanel } = useRightPanelStore();

   return (
      <div className="flex items-center gap-1">
         <Button
            size="xs"
            variant={openPanel === 'insights' ? 'secondary' : 'ghost'}
            onClick={() => togglePanel('insights')}
            aria-label="Toggle insights panel"
         >
            <BarChart3 className="size-4" />
         </Button>
         <Button
            size="xs"
            variant={openPanel === 'hidden' ? 'ghost' : 'secondary'}
            onClick={() => togglePanel('hidden')}
            aria-label="Toggle side panel"
         >
            <PanelRight className="size-4" />
         </Button>
      </div>
   );
}

export default function Header({ projectId }: { projectId: string }) {
   const { orgId } = useParams<{ orgId: string }>();
   const router = useRouter();
   const closeDrawer = useDetailDrawerClose();
   const project = useProject(projectId);

   // Whatever is showing the project has to stop showing it. In the drawer
   // that means closing: navigating instead would move the page behind the
   // overlay while the overlay kept rendering a project that no longer
   // exists. On the full page there is nothing left to show, so it returns
   // to the list.
   const afterDelete = useCallback(() => {
      if (closeDrawer) {
         closeDrawer();
         return;
      }
      router.push(`/${orgId}/projects`);
   }, [closeDrawer, router, orgId]);

   if (!project) {
      return (
         <div className="w-full flex items-center border-b py-1.5 px-6 h-10 text-muted-foreground">
            Loading project…
         </div>
      );
   }

   return (
      <>
         <div className="w-full flex justify-between items-center border-b py-1.5 px-6 h-10">
            <div className="flex items-center gap-2 min-w-0">
               <div className="flex items-center gap-1.5 min-w-0">
                  <Link
                     href={`/${orgId}/projects`}
                     className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                     Projects
                  </Link>
                  <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
                  <span className="inline-flex size-5 bg-muted/50 items-center justify-center rounded shrink-0">
                     <project.icon className="size-3.5" />
                  </span>
                  <span className="font-medium truncate">{project.name}</span>
                  <Button variant="ghost" size="icon" className="size-6 text-muted-foreground">
                     <Star className="size-3.5" />
                  </Button>
                  {/* Beside the name, as on an issue. The overflow button that
                      used to sit in the right-hand group had no menu behind
                      it, so this replaces it rather than adding a second. */}
                  <ProjectActionsMenu project={project} onDeleted={afterDelete} />
               </div>
            </div>
            <div className="flex items-center gap-1">
               <Button variant="ghost" size="icon" className="size-7 text-muted-foreground">
                  <Link2 className="size-4" />
               </Button>
            </div>
         </div>
         <div className="w-full flex justify-between items-center border-b py-1.5 px-6 h-10">
            <ProjectTabs projectId={project.id} />
            <PanelToggles />
         </div>
      </>
   );
}
