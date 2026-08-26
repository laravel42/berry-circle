'use client';

import { useParams } from 'next/navigation';

import GoalOverview from '@/components/common/goals/goal-overview';
import DetailDrawerShell from '@/components/layout/detail-drawer-shell';
import Header from '@/components/layout/headers/goal/header';

export default function GoalOverviewDrawerPage() {
   const { goalId } = useParams<{ orgId: string; goalId: string }>();
   return (
      <DetailDrawerShell header={<Header goalId={goalId} />}>
         <GoalOverview goalId={goalId} />
      </DetailDrawerShell>
   );
}
