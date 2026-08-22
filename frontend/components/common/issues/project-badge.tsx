import { Badge } from '@/components/ui/badge';
import { Project } from '@/data/projects';
import Link from 'next/link';
import { WORKSPACE_SLUG } from '@/lib/config';

export function ProjectBadge({ project }: { project: Project }) {
   return (
      <Link href={`/${WORKSPACE_SLUG}/projects`} className="flex items-center justify-center gap-.5">
         <Badge
            variant="outline"
            className="gap-1.5 rounded-full text-muted-foreground bg-background"
         >
            <project.icon size={16} />
            {project.name}
         </Badge>
      </Link>
   );
}
