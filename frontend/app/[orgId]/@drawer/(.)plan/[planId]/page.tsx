'use client';

import { useParams } from 'next/navigation';

import PlanPreview from '@/components/common/plans/plan-preview';
import DetailDrawerShell from '@/components/layout/detail-drawer-shell';
import Header from '@/components/layout/headers/plan/header';

export default function PlanDrawerPage() {
   const { planId } = useParams<{ orgId: string; planId: string }>();

   return (
      <DetailDrawerShell header={<Header planId={planId} />}>
         <PlanPreview planId={planId} />
      </DetailDrawerShell>
   );
}
