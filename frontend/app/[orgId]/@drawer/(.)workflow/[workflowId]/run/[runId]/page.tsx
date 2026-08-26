'use client';

import { useParams } from 'next/navigation';

import { WorkflowRunDetail } from '@/components/common/workflows/workflow-run-detail';
import DetailDrawerShell from '@/components/layout/detail-drawer-shell';
import Header from '@/components/layout/headers/workflow-run/header';

export default function WorkflowRunDrawerPage() {
   const { workflowId, runId } = useParams<{ orgId: string; workflowId: string; runId: string }>();
   return (
      <DetailDrawerShell header={<Header workflowId={workflowId} runId={runId} />}>
         <div className="h-full min-h-0 overflow-y-auto bg-container">
            <div className="mx-auto max-w-3xl px-6 py-6 sm:px-8">
               <WorkflowRunDetail runId={runId} />
            </div>
         </div>
      </DetailDrawerShell>
   );
}
