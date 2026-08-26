import React from 'react';
import { SidebarProvider } from '@/components/ui/sidebar';
import { CreateIssueModalProvider } from '@/components/common/issues/create-issue-modal-provider';
import { IssuesHydrator } from '@/components/common/issues/issues-hydrator';
import { CreatePlanModalProvider } from '@/components/common/plans/create-plan-modal-provider';
import { CommandPalette } from '@/components/layout/command-palette';
import { cn } from '@/lib/utils';

interface MainLayoutProps {
   children: React.ReactNode;
   header?: React.ReactNode;
   headersNumber?: 1 | 2;
}

const isEmptyHeader = (header: React.ReactNode | undefined): boolean => {
   if (!header) return true;

   if (React.isValidElement(header) && header.type === React.Fragment) {
      const props = header.props as { children?: React.ReactNode };

      if (!props.children) return true;

      if (Array.isArray(props.children) && props.children.length === 0) {
         return true;
      }
   }

   return false;
};

export default function MainLayout({ children, header }: MainLayoutProps) {
   return (
      <SidebarProvider className="h-full max-h-full">
         <IssuesHydrator />
         <CreateIssueModalProvider />
         <CreatePlanModalProvider />
         <CommandPalette />
         {/* No sidebar here: BerryShell owns the rail and the tab strip. The
             provider stays because sidebar preference stores are still used
             across headers and settings. */}
         <div className="h-full w-full overflow-hidden bg-background">
            <div className="flex h-full w-full flex-col items-center justify-start overflow-hidden bg-container">
               {header}
               <div
                  className={cn(
                     'w-full overflow-auto',
                     isEmptyHeader(header) ? 'h-full' : 'min-h-0 flex-1'
                  )}
               >
                  {children}
               </div>
            </div>
         </div>
      </SidebarProvider>
   );
}
