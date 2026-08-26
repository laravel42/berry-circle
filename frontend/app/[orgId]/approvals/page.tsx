import { Suspense } from 'react';

import Approvals from '@/components/common/approvals/approvals';
import Header from '@/components/layout/headers/approvals/header';
import MainLayout from '@/components/layout/main-layout';

export default function ApprovalsPage() {
   return (
      <MainLayout
         header={
            <Suspense>
               <Header />
            </Suspense>
         }
         headersNumber={1}
      >
         <Suspense>
            <Approvals />
         </Suspense>
      </MainLayout>
   );
}
