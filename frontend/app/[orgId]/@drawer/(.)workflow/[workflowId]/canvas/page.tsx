'use client';

import { useParams } from 'next/navigation';

import WorkflowCanvasPlaceholder from '@/components/common/workflows/workflow-canvas-placeholder';
import DetailDrawerShell from '@/components/layout/detail-drawer-shell';
import Header from '@/components/layout/headers/workflow/header';

export default function WorkflowCanvasDrawerPage() {
   const { workflowId } = useParams<{ orgId: string; workflowId: string }>();
   return (
      <DetailDrawerShell header={<Header workflowId={workflowId} />}>
         <WorkflowCanvasPlaceholder workflowId={workflowId} />
      </DetailDrawerShell>
   );
}
