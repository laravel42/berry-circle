import WorkflowCanvas from '@/components/common/workflows/canvas/workflow-canvas';
import Header from '@/components/layout/headers/workflow/header';
import MainLayout from '@/components/layout/main-layout';

interface Props {
   params: Promise<{ workflowId: string }>;
}

export default async function WorkflowCanvasPage({ params }: Props) {
   const { workflowId } = await params;
   return (
      <MainLayout header={<Header workflowId={workflowId} />} headersNumber={1}>
         <WorkflowCanvas workflowId={workflowId} />
      </MainLayout>
   );
}
