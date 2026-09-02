'use client';

import { CreateProjectButton } from '@/components/common/projects/create-project-button';

export default function HeaderNav() {
   return (
      <div className="flex h-auto w-full flex-col gap-2 border-b px-6 py-3">
         <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
               <span className="font-medium">Projects</span>
               <p className="mt-1 max-w-2xl text-muted-foreground">
                  Group related tasks into a shared plan with status, health, and a target date.{' '}
                  <a href="" className="text-foreground underline-offset-2 hover:underline">
                     Learn more
                  </a>
               </p>
            </div>
            <CreateProjectButton />
         </div>
      </div>
   );
}
