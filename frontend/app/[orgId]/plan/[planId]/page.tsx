import PlanPreview from '@/components/common/plans/plan-preview';
import Header from '@/components/layout/headers/plan/header';
import MainLayout from '@/components/layout/main-layout';

interface PlanPageProps {
   params: Promise<{ planId: string }>;
}

export default async function PlanPage({ params }: PlanPageProps) {
   const { planId } = await params;

   return (
      <MainLayout header={<Header planId={planId} />} headersNumber={1}>
         <PlanPreview planId={planId} />
      </MainLayout>
   );
}
