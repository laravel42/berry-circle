'use client';

import { SidebarTrigger } from '@/components/ui/sidebar';
import { CreateProjectButton } from '@/components/common/projects/create-project-button';
import { useProjectsStore } from '@/store/projects-store';

export default function HeaderNav() {
   const count = useProjectsStore((state) => state.projects.length);

   return (
      <div className="w-full flex justify-between items-center border-b py-1.5 px-6 h-10">
         <div className="flex items-center gap-2">
            <SidebarTrigger />
            <div className="flex items-center gap-1">
               <span className="font-medium">Projects</span>
               <span className="bg-accent rounded-md px-1.5 py-1">{count}</span>
            </div>
         </div>
         <div className="flex items-center gap-2">
            <CreateProjectButton />
         </div>
      </div>
   );
}
