import { Suspense } from 'react';

import WorkflowHistory from '@/components/common/workflows/workflow-history';
import Header from '@/components/layout/headers/workflow/header';
import MainLayout from '@/components/layout/main-layout';

interface Props {
   params: Promise<{ workflowId: string }>;
}

export default async function WorkflowHistoryPage({ params }: Props) {
   const { workflowId } = await params;
   return (
      <MainLayout header={<Header workflowId={workflowId} />} headersNumber={1}>
         <Suspense>
            <WorkflowHistory workflowId={workflowId} />
         </Suspense>
      </MainLayout>
   );
}
