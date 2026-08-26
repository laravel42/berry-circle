'use client';

import { useParams } from 'next/navigation';

import WorkflowOverview from '@/components/common/workflows/workflow-overview';
import DetailDrawerShell from '@/components/layout/detail-drawer-shell';
import Header from '@/components/layout/headers/workflow/header';

export default function WorkflowOverviewDrawerPage() {
   const { workflowId } = useParams<{ orgId: string; workflowId: string }>();
   return (
      <DetailDrawerShell header={<Header workflowId={workflowId} />}>
         <WorkflowOverview workflowId={workflowId} />
      </DetailDrawerShell>
   );
}
