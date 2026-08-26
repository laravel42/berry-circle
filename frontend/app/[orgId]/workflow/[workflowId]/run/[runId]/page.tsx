import { WorkflowRunDetail } from '@/components/common/workflows/workflow-run-detail';
import Header from '@/components/layout/headers/workflow-run/header';
import MainLayout from '@/components/layout/main-layout';

interface Props {
   params: Promise<{ workflowId: string; runId: string }>;
}

export default async function WorkflowRunPage({ params }: Props) {
   const { workflowId, runId } = await params;
   return (
      <MainLayout header={<Header workflowId={workflowId} runId={runId} />} headersNumber={1}>
         <div className="h-full min-h-0 overflow-y-auto bg-container">
            <div className="mx-auto max-w-3xl px-6 py-6 sm:px-8 sm:py-8">
               <WorkflowRunDetail runId={runId} />
            </div>
         </div>
      </MainLayout>
   );
}
