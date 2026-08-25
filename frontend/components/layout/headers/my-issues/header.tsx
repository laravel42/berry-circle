'use client';

import {
   DEFAULT_MY_ISSUES_TAB,
   MY_ISSUES_TAB_ITEMS,
   useMyIssuesTab,
} from '@/components/common/my-issues/use-my-issues';
import { IssueFilterTrigger } from '@/components/common/issues/issue-filter-trigger';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useRightPanelStore } from '@/store/right-panel-store';
import { BarChart3, PanelRight } from 'lucide-react';
import { DisplayOptions } from '../display-options';
import Notifications from '../notifications';

function HeaderNav() {
   return (
      <div className="flex h-auto w-full flex-col gap-2 border-b px-6 py-3">
         <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
               <span className="font-medium">Issues</span>
               <p className="mt-1 max-w-2xl text-muted-foreground">
                  Work starts here. Assign to a human or an agent, then track it through
                  review.{' '}
                  <a href="" className="text-foreground underline-offset-2 hover:underline">
                     Learn more
                  </a>
               </p>
            </div>
            <Notifications />
         </div>
      </div>
   );
}

function HeaderOptions() {
   const [tab, setTab] = useMyIssuesTab();
   const { openPanel, togglePanel } = useRightPanelStore();

   return (
      <div className="mb-1 flex h-10 w-full items-center justify-between border-b px-6 py-1.5">
         <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
               {MY_ISSUES_TAB_ITEMS.map((item) => {
                  const isActive = tab === item.value;
                  return (
                     <button
                        key={item.value}
                        type="button"
                        aria-current={isActive ? 'page' : undefined}
                        onClick={() =>
                           void setTab(item.value === DEFAULT_MY_ISSUES_TAB ? null : item.value)
                        }
                        className={cn(
                           'inline-flex h-7 cursor-pointer items-center rounded-sm border px-3.5 font-medium transition-colors',
                           isActive
                              ? 'border-border/70 bg-accent text-foreground'
                              : 'border-border/40 text-muted-foreground hover:border-border/60 hover:bg-accent/50 hover:text-foreground'
                        )}
                     >
                        {item.label}
                     </button>
                  );
               })}
            </div>
         </div>
         <div className="flex items-center gap-1">
            <IssueFilterTrigger iconOnly />
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
               variant={openPanel === 'breakdown' ? 'secondary' : 'ghost'}
               onClick={() => togglePanel('breakdown')}
               aria-label="Toggle breakdown panel"
            >
               <PanelRight className="size-4" />
            </Button>
            <DisplayOptions iconOnly />
         </div>
      </div>
   );
}

export default function Header() {
   return (
      <>
         <HeaderNav />
         <HeaderOptions />
      </>
   );
}
