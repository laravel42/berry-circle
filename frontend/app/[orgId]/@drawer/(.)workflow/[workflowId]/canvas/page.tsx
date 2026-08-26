'use client';

import { useParams } from 'next/navigation';

import WorkflowCanvas from '@/components/common/workflows/canvas/workflow-canvas';
import DetailDrawerShell from '@/components/layout/detail-drawer-shell';
import Header from '@/components/layout/headers/workflow/header';

export default function WorkflowCanvasDrawerPage() {
   const { workflowId } = useParams<{ orgId: string; workflowId: string }>();
   return (
      <DetailDrawerShell header={<Header workflowId={workflowId} />}>
         <WorkflowCanvas workflowId={workflowId} />
      </DetailDrawerShell>
   );
}
