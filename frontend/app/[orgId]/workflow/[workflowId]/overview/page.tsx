import WorkflowOverview from '@/components/common/workflows/workflow-overview';
import Header from '@/components/layout/headers/workflow/header';
import MainLayout from '@/components/layout/main-layout';

interface Props {
   params: Promise<{ workflowId: string }>;
}

export default async function WorkflowOverviewPage({ params }: Props) {
   const { workflowId } = await params;
   return (
      <MainLayout header={<Header workflowId={workflowId} />} headersNumber={1}>
         <WorkflowOverview workflowId={workflowId} />
      </MainLayout>
   );
}
