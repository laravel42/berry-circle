import { Suspense } from 'react';

import Workflows from '@/components/common/workflows/workflows';
import Header from '@/components/layout/headers/workflows/header';
import MainLayout from '@/components/layout/main-layout';

export default function WorkflowsPage() {
   return (
      <MainLayout header={<Header />} headersNumber={2}>
         <Suspense>
            <Workflows />
         </Suspense>
      </MainLayout>
   );
}
