'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense, useCallback, useState } from 'react';

import UsageErrors from '@/components/common/usage/usage-errors';
import UsageFilters from '@/components/common/usage/usage-filters';
import UsageOverview from '@/components/common/usage/usage-overview';
import MainLayout from '@/components/layout/main-layout';
import { Button } from '@/components/ui/button';
import { localTimezone } from '@/lib/cron-schedule';
import type { UsageQuery } from '@/lib/usage';

const TABS = ['usage', 'errors'] as const;
type Tab = (typeof TABS)[number];

function UsageScreen() {
   const t = useTranslations('areas.usage');
   const router = useRouter();
   const params = useSearchParams();
   const raw = params.get('tab');
   const tab: Tab = raw === 'errors' ? 'errors' : 'usage';

   const [query, setQuery] = useState<UsageQuery>({
      days: 30,
      timezone: localTimezone(),
      boardId: null,
   });
   const [state, setState] = useState<{
      lastUpdated: Date | null;
      loading: boolean;
      reload: () => void;
   }>({ lastUpdated: null, loading: false, reload: () => undefined });

   // The tab's own read reports when it landed; keeping it in a ref-like state
   // lets the filter bar above both tabs say so.
   const onState = useCallback(
      (next: { lastUpdated: Date | null; loading: boolean; reload: () => void }) => {
         setState((current) =>
            current.lastUpdated?.getTime() === next.lastUpdated?.getTime() &&
            current.loading === next.loading
               ? current
               : next
         );
      },
      []
   );

   const open = (next: Tab) => {
      const search = new URLSearchParams(params.toString());
      if (next === 'usage') search.delete('tab');
      else search.set('tab', next);
      router.replace(search.size > 0 ? `?${search.toString()}` : '?', { scroll: false });
   };

   const header = (
      <div className="flex w-full flex-col gap-2 border-b px-6 py-3">
         <div className="min-w-0">
            <span className="font-medium">{t('title')}</span>
            <p className="mt-1 max-w-2xl text-muted-foreground">{t('subtitle')}</p>
         </div>
         <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-md border p-0.5">
               {TABS.map((name) => (
                  <Button
                     key={name}
                     size="xxs"
                     variant={tab === name ? 'secondary' : 'ghost'}
                     onClick={() => open(name)}
                  >
                     {t(`tabs.${name}`)}
                  </Button>
               ))}
            </div>
            <UsageFilters
               query={query}
               onChange={setQuery}
               lastUpdated={state.lastUpdated}
               loading={state.loading}
               onRefresh={state.reload}
            />
         </div>
      </div>
   );

   return (
      <MainLayout header={header}>
         {tab === 'usage' ? (
            <UsageOverview query={query} onState={onState} />
         ) : (
            <UsageErrors query={query} onState={onState} />
         )}
      </MainLayout>
   );
}

export default function UsagePage() {
   return (
      <Suspense>
         <UsageScreen />
      </Suspense>
   );
}
