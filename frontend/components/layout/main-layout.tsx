import React from 'react';
import { AppSidebar } from '@/components/layout/sidebar/app-sidebar';
import { SidebarProvider } from '@/components/ui/sidebar';
import { CreateIssueModalProvider } from '@/components/common/issues/create-issue-modal-provider';
import { IssuesHydrator } from '@/components/common/issues/issues-hydrator';
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
      <SidebarProvider>
         <IssuesHydrator />
         <CreateIssueModalProvider />
         <CommandPalette />
         <AppSidebar />
         <div className="h-svh w-full overflow-hidden bg-background lg:p-2">
            <div className="flex h-full w-full flex-col items-center justify-start overflow-hidden border-y border-border bg-container lg:rounded-sm lg:border">
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
