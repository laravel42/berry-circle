'use client';

import { useParams } from 'next/navigation';

import CrewDetails from '@/components/common/teams/details/crew-details';
import DetailDrawerShell from '@/components/layout/detail-drawer-shell';
import CrewDetailHeader from '@/components/layout/headers/team/detail-header';

export default function CrewOverviewDrawerPage() {
   const { teamId } = useParams<{ orgId: string; teamId: string }>();

   return (
      <DetailDrawerShell header={<CrewDetailHeader teamId={teamId} />}>
         <CrewDetails teamId={teamId} />
      </DetailDrawerShell>
   );
}
