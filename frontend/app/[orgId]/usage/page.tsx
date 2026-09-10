import { Suspense } from 'react';

import UsageOverview from '@/components/common/usage/usage-overview';
import Header from '@/components/layout/headers/usage/header';
import MainLayout from '@/components/layout/main-layout';

export default function UsagePage() {
   return (
      <MainLayout header={<Header />} headersNumber={1}>
         <Suspense>
            <UsageOverview />
         </Suspense>
      </MainLayout>
   );
}
