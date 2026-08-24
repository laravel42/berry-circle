import { Suspense } from 'react';

import RunOverview from '@/components/common/runs/run-overview';
import Header from '@/components/layout/headers/runs/header';
import MainLayout from '@/components/layout/main-layout';

export default function RunsPage() {
   return (
      <MainLayout header={<Header />} headersNumber={1}>
         <Suspense>
            <RunOverview />
         </Suspense>
      </MainLayout>
   );
}
