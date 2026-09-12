'use client';

import {
   DEFAULT_MY_ISSUES_TAB,
   MY_ISSUES_TABS,
   useMyIssuesTab,
   type MyIssuesTab,
} from '@/components/common/my-issues/use-my-issues';
import { IssueFilterTrigger } from '@/components/common/issues/issue-filter-trigger';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useRightPanelStore } from '@/store/right-panel-store';
import { BarChart3, PanelRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { DisplayOptions } from '../display-options';

function HeaderNav() {
   const t = useTranslations('tasks.header');
   const common = useTranslations('common');
   return (
      <div className="flex h-auto w-full flex-col gap-2 border-b px-6 py-3">
         <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
               <span className="font-medium">{t('title')}</span>
               <p className="mt-1 max-w-2xl text-muted-foreground">
                  {t('description')}{' '}
                  <a href="" className="text-foreground underline-offset-2 hover:underline">
                     {common('learnMore')}
                  </a>
               </p>
            </div>
         </div>
      </div>
   );
}

function HeaderOptions() {
   const t = useTranslations('tasks');
   const lists = useTranslations('issueLists');
   const [tab, setTab] = useMyIssuesTab();
   const { openPanel, togglePanel } = useRightPanelStore();

   // Written out rather than built from the tab id: `t()` is typed against the
   // English catalogue, which cannot check a key assembled at runtime.
   const label: Record<MyIssuesTab, string> = {
      all: lists('scope.all'),
      assigned: lists('scope.assigned'),
      created: lists('scope.created'),
      agents: lists('scope.agents'),
   };

   return (
      <div className="mb-1 flex h-10 w-full items-center justify-between border-b px-6 py-1.5">
         <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
               {MY_ISSUES_TABS.map((value) => {
                  const isActive = tab === value;
                  return (
                     <button
                        key={value}
                        type="button"
                        aria-current={isActive ? 'page' : undefined}
                        onClick={() => void setTab(value === DEFAULT_MY_ISSUES_TAB ? null : value)}
                        className={cn(
                           'inline-flex h-7 cursor-pointer items-center rounded-sm border px-3.5 font-medium transition-colors',
                           isActive
                              ? 'border-border/70 bg-accent text-foreground'
                              : 'border-border/40 text-muted-foreground hover:border-border/60 hover:bg-accent/50 hover:text-foreground'
                        )}
                     >
                        {label[value]}
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
               aria-label={t('header.toggleInsights')}
            >
               <BarChart3 className="size-4" />
            </Button>
            <Button
               size="xs"
               variant={openPanel === 'breakdown' ? 'secondary' : 'ghost'}
               onClick={() => togglePanel('breakdown')}
               aria-label={t('header.toggleBreakdown')}
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
