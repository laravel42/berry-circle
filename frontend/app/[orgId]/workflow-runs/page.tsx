import { Suspense } from 'react';

import WorkflowRunsLedger from '@/components/common/workflows/workflow-runs-ledger';
import Header from '@/components/layout/headers/workflow-runs/header';
import MainLayout from '@/components/layout/main-layout';

export default function WorkflowRunsPage() {
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
            <WorkflowRunsLedger />
         </Suspense>
      </MainLayout>
   );
}
