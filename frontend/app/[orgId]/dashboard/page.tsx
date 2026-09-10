import { Suspense } from 'react';

import DashboardOverview from '@/components/common/usage/dashboard-overview';
import Header from '@/components/layout/headers/dashboard/header';
import MainLayout from '@/components/layout/main-layout';

export default function DashboardPage() {
   return (
      <MainLayout header={<Header />} headersNumber={1}>
         <Suspense>
            <DashboardOverview />
         </Suspense>
      </MainLayout>
   );
}
