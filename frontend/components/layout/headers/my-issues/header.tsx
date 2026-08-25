'use client';

import {
   DEFAULT_MY_ISSUES_TAB,
   MY_ISSUES_TAB_ITEMS,
   scopeMyIssues,
   useMyIssuesTab,
} from '@/components/common/my-issues/use-my-issues';
import { IssueFilterTrigger } from '@/components/common/issues/issue-filter-trigger';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { useFilterStore } from '@/store/filter-store';
import { useIssuesStore } from '@/store/issues-store';
import { useRightPanelStore } from '@/store/right-panel-store';
import { useSearchStore } from '@/store/search-store';
import { BarChart3, PanelRight, SearchIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { DisplayOptions } from '../display-options';
import Notifications from '../notifications';

function HeaderNav() {
   const { isSearchOpen, toggleSearch, closeSearch, setSearchQuery, searchQuery } =
      useSearchStore();
   const searchInputRef = useRef<HTMLInputElement>(null);
   const searchContainerRef = useRef<HTMLDivElement>(null);

   useEffect(() => {
      if (isSearchOpen && searchInputRef.current) {
         searchInputRef.current.focus();
      }
   }, [isSearchOpen]);

   useEffect(() => {
      const handleClickOutside = (event: MouseEvent) => {
         if (
            searchContainerRef.current &&
            !searchContainerRef.current.contains(event.target as Node) &&
            isSearchOpen &&
            searchQuery.trim() === ''
         ) {
            closeSearch();
         }
      };
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
   }, [isSearchOpen, closeSearch, searchQuery]);

   return (
      <div className="w-full flex justify-between items-center border-b py-1.5 px-6 h-10">
         <div className="flex items-center gap-2">
            <SidebarTrigger />
            <span className="font-medium">Issues</span>
         </div>
         <div className="flex items-center gap-2">
            {isSearchOpen ? (
               <div ref={searchContainerRef} className="relative flex items-center w-64">
                  <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
                  <Input
                     type="search"
                     ref={searchInputRef}
                     value={searchQuery}
                     onChange={(event) => setSearchQuery(event.target.value)}
                     placeholder="Search issues..."
                     className="pl-8 h-7"
                     onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                           if (searchQuery.trim() === '') closeSearch();
                           else setSearchQuery('');
                        }
                     }}
                  />
               </div>
            ) : (
               <>
                  <Button
                     variant="ghost"
                     size="icon"
                     onClick={toggleSearch}
                     className="h-8 w-8"
                     aria-label="Search"
                  >
                     <SearchIcon className="h-4 w-4" />
                  </Button>
                  <Notifications />
               </>
            )}
         </div>
      </div>
   );
}

function HeaderOptions() {
   const [tab, setTab] = useMyIssuesTab();
   const { issues } = useIssuesStore();
   const { hasActiveFilters } = useFilterStore();
   const { openPanel, togglePanel } = useRightPanelStore();

   const count = scopeMyIssues(issues, tab).length;
   const showQueueChrome = count > 0 || hasActiveFilters();

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
            <span className="hidden text-muted-foreground sm:inline">
               {count} {count === 1 ? 'issue' : 'issues'}
            </span>
         </div>
         {showQueueChrome ? (
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
         ) : (
            <div />
         )}
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
