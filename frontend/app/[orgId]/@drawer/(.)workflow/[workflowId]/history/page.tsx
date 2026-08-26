'use client';

import { useParams } from 'next/navigation';
import { Suspense } from 'react';

import WorkflowHistory from '@/components/common/workflows/workflow-history';
import DetailDrawerShell from '@/components/layout/detail-drawer-shell';
import Header from '@/components/layout/headers/workflow/header';

export default function WorkflowHistoryDrawerPage() {
   const { workflowId } = useParams<{ orgId: string; workflowId: string }>();
   return (
      <DetailDrawerShell header={<Header workflowId={workflowId} />}>
         <Suspense>
            <WorkflowHistory workflowId={workflowId} />
         </Suspense>
      </DetailDrawerShell>
   );
}
