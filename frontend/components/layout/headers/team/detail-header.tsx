'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useCrewDrawerStore } from '@/store/crew-drawer-store';
import { getTeamForUrl, useTeamsStore } from '@/store/teams-store';
import { ChevronDown, ChevronRight, ChevronUp } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';

interface CrewDetailHeaderProps {
   teamId: string;
}

/**
 * Crew drawer header: breadcrumb (crews › identifier + name) and previous /
 * next navigation across the crew list.
 */
export default function CrewDetailHeader({ teamId }: CrewDetailHeaderProps) {
   const { orgId } = useParams<{ orgId: string }>();
   const router = useRouter();
   const teams = useTeamsStore((state) => state.teams);
   const storeOpen = useCrewDrawerStore((state) => state.teamId);
   const openCrew = useCrewDrawerStore((state) => state.open);
   const team = getTeamForUrl(teamId);
   const index = teams.findIndex((entry) => entry.id === teamId);
   const previous = index > 0 ? teams[index - 1] : undefined;
   const next = index >= 0 && index < teams.length - 1 ? teams[index + 1] : undefined;

   const goToCrew = (id: string) => {
      if (storeOpen) {
         openCrew(id);
         return;
      }
      router.push(`/${orgId}/team/${id}/overview`);
   };

   return (
      <div className="w-full flex justify-between items-center border-b py-1.5 px-6 h-10 gap-4">
         <div className="flex items-center gap-2 min-w-0">
            <Badge asChild variant="secondary" className="h-6 px-2 text-xs font-medium">
               <Link href={`/${orgId}/teams`}>Crews</Link>
            </Badge>
            <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
            <span className="text-sm min-w-0 truncate">
               <span className="font-medium text-muted-foreground mr-1.5">{team.identifier}</span>
               <span className="font-medium">{team.name}</span>
            </span>
         </div>

         <div className="flex items-center gap-1 shrink-0">
            {index >= 0 && teams.length > 0 ? (
               <span className="text-xs text-muted-foreground mr-1">
                  {index + 1} / {teams.length}
               </span>
            ) : null}
            <Button
               variant="ghost"
               size="icon"
               className="size-6"
               disabled={!previous}
               aria-label="Previous crew"
               onClick={() => previous && goToCrew(previous.id)}
            >
               <ChevronUp className="size-4" />
            </Button>
            <Button
               variant="ghost"
               size="icon"
               className="size-6"
               disabled={!next}
               aria-label="Next crew"
               onClick={() => next && goToCrew(next.id)}
            >
               <ChevronDown className="size-4" />
            </Button>
         </div>
      </div>
   );
}
