'use client';

import { CreateCrewButton } from '@/components/common/teams/create-crew-button';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { useTeamsStore } from '@/store/teams-store';

export default function HeaderNav() {
   const count = useTeamsStore((state) => state.teams.length);

   return (
      <div className="w-full flex justify-between items-center border-b py-1.5 px-6 h-10">
         <div className="flex items-center gap-2">
            <SidebarTrigger className="" />
            <div className="flex items-center gap-1">
               <span className="text-sm font-medium">Crews</span>
               <span className="text-xs bg-accent rounded-md px-1.5 py-1">{count}</span>
            </div>
         </div>
         <div className="flex items-center gap-2">
            <CreateCrewButton />
         </div>
      </div>
   );
}
