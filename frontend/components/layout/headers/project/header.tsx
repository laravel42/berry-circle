'use client';

import { GenerateIssuesButton } from '@/components/common/projects/generate-issues-button';
import { useProject } from '@/hooks/use-project';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

export default function Header({ projectId }: { projectId: string }) {
   const { orgId } = useParams<{ orgId: string }>();
   const project = useProject(projectId);

   if (!project) {
      return (
         <div className="flex h-10 w-full items-center border-b px-6 py-1.5 text-muted-foreground">
            Loading project…
         </div>
      );
   }

   return (
      <div className="flex h-10 w-full items-center justify-between border-b px-6 py-1.5">
         <div className="flex min-w-0 items-center gap-1.5">
            <Link
               href={`/${orgId}/projects`}
               className="text-muted-foreground transition-colors hover:text-foreground"
            >
               Projects
            </Link>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-muted/50">
               <project.icon className="size-3.5" />
            </span>
            <span className="truncate font-medium">{project.name}</span>
         </div>
         <div className="flex items-center gap-1">
            <GenerateIssuesButton project={project} />
         </div>
      </div>
   );
}
