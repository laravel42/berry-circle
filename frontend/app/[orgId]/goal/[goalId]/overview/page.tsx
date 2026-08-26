import GoalOverview from '@/components/common/goals/goal-overview';
import Header from '@/components/layout/headers/goal/header';
import MainLayout from '@/components/layout/main-layout';

interface Props {
   params: Promise<{ goalId: string }>;
}

export default async function GoalOverviewPage({ params }: Props) {
   const { goalId } = await params;
   return (
      <MainLayout header={<Header goalId={goalId} />} headersNumber={1}>
         <GoalOverview goalId={goalId} />
      </MainLayout>
   );
}
